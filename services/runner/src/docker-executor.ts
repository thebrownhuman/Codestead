import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import {
  classifyProcess,
  normalizeTestResult,
  sanitizeOutput,
  type ProcessClassification,
} from "./normalize.js";
import type {
  ProcessExecutor,
  ProcessResult,
} from "./process-executor.js";
import type {
  CompileResult,
  NormalizedStatus,
  NormalizedTestResult,
  RunnerResult,
} from "./types.js";
import type { ValidatedJob } from "./validation.js";

export interface JobExecutor {
  execute(job: ValidatedJob, requestHash: string): Promise<RunnerResult>;
}

interface ExecutionBudget {
  readonly deadlineMs: number;
  outputBytesRemaining: number;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function stableSourceHash(job: ValidatedJob): string {
  const hash = createHash("sha256");
  const ordered = [...job.request.sourceFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  for (const file of ordered) {
    hash
      .update(String(Buffer.byteLength(file.path, "utf8")))
      .update(":")
      .update(file.path)
      .update(":")
      .update(String(Buffer.byteLength(file.content, "utf8")))
      .update(":")
      .update(file.content);
  }
  return hash.digest("hex");
}

function syntheticTimeout(): ProcessResult {
  return {
    exitCode: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    wallTimeMs: 0,
    timedOut: true,
    outputLimitExceeded: false,
  };
}

function syntheticInfrastructure(): ProcessResult {
  return {
    exitCode: 125,
    signal: null,
    stdout: "",
    stderr: "container execution infrastructure failed",
    wallTimeMs: 0,
    timedOut: false,
    outputLimitExceeded: false,
  };
}

function statusFromClassification(
  classification: ProcessClassification,
): NormalizedStatus {
  switch (classification) {
    case "OK":
      return "ACCEPTED";
    case "COMPILE_ERROR":
      return "COMPILE_ERROR";
    case "RUNTIME_ERROR":
      return "RUNTIME_ERROR";
    case "TIMEOUT":
      return "TIMEOUT";
    case "MEMORY_LIMIT":
      return "MEMORY_LIMIT";
    case "OUTPUT_LIMIT":
      return "OUTPUT_LIMIT";
    case "INFRASTRUCTURE_ERROR":
      return "INFRASTRUCTURE_ERROR";
  }
}

export class DockerJobExecutor implements JobExecutor {
  readonly #config: RunnerConfig;
  readonly #process: ProcessExecutor;
  readonly #clock: () => number;

  constructor(
    config: RunnerConfig,
    processExecutor: ProcessExecutor,
    clock: () => number = Date.now,
  ) {
    this.#config = config;
    this.#process = processExecutor;
    this.#clock = clock;
  }

  async execute(
    job: ValidatedJob,
    requestHash: string,
  ): Promise<RunnerResult> {
    const startedAtMs = this.#clock();
    const budget: ExecutionBudget = {
      deadlineMs: startedAtMs + job.limits.wallTimeMs,
      outputBytesRemaining: job.limits.outputBytes,
    };
    const containerPrefix =
      `lc-${requestHash.slice(0, 8)}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await mkdir(this.#config.tempRoot, { recursive: true, mode: 0o700 });
    await chmod(this.#config.tempRoot, 0o700);
    const jobDirectory = await mkdtemp(
      path.join(this.#config.tempRoot, "job-"),
    );
    if (jobDirectory.includes(",") || /[\r\n]/.test(jobDirectory)) {
      await rm(jobDirectory, { recursive: true, force: true });
      throw new Error("runner temporary path contains unsupported characters");
    }

    try {
      // The random parent is 0700; only this bind-mounted child needs
      // traverse/read permission for the container's unprivileged UID.
      await chmod(jobDirectory, 0o755);
      await this.writeSources(jobDirectory, job);
      const compileProcess = await this.runContainer(
        jobDirectory,
        job,
        containerPrefix,
        "COMPILE",
        "",
        "compile",
        budget,
      );
      const compileClassification = classifyProcess(
        compileProcess,
        "COMPILE",
      );
      const compileStatus =
        compileClassification === "RUNTIME_ERROR"
          ? "INFRASTRUCTURE_ERROR"
          : compileClassification;
      const compile: CompileResult = {
        status: compileStatus,
        exitCode: compileProcess.exitCode,
        stdout: sanitizeOutput(
          compileProcess.stdout,
          jobDirectory,
          job.limits.outputBytes,
        ),
        stderr: sanitizeOutput(
          compileProcess.stderr,
          jobDirectory,
          job.limits.outputBytes,
        ),
        wallTimeMs: compileProcess.wallTimeMs,
      };

      if (compileStatus !== "OK") {
        return this.result(job, requestHash, startedAtMs, {
          status: statusFromClassification(compileStatus),
          compile,
          tests: [],
        });
      }

      if (job.request.mode === "COMPILE") {
        return this.result(job, requestHash, startedAtMs, {
          status: "COMPILE_ONLY",
          compile,
          tests: [],
        });
      }

      if (job.request.mode === "RUN") {
        const runProcess = await this.runContainer(
          jobDirectory,
          job,
          containerPrefix,
          "RUN",
          job.request.stdin ?? "",
          "run",
          budget,
        );
        const runClassification = classifyProcess(runProcess, "RUN");
        return this.result(job, requestHash, startedAtMs, {
          status: statusFromClassification(runClassification),
          compile,
          run: {
            exitCode: runProcess.exitCode,
            stdout: sanitizeOutput(
              runProcess.stdout,
              jobDirectory,
              job.limits.outputBytes,
            ),
            stderr: sanitizeOutput(
              runProcess.stderr,
              jobDirectory,
              job.limits.outputBytes,
            ),
            wallTimeMs: runProcess.wallTimeMs,
          },
          tests: [],
        });
      }

      const tests: NormalizedTestResult[] = [];
      for (const [index, test] of (job.request.tests ?? []).entries()) {
        const process = await this.runContainer(
          jobDirectory,
          job,
          containerPrefix,
          "RUN",
          test.stdin,
          `test-${index}`,
          budget,
        );
        tests.push(
          normalizeTestResult(
            test,
            process,
            jobDirectory,
            job.limits.outputBytes,
          ),
        );
      }
      const status = this.aggregateTestStatus(tests);
      return this.result(job, requestHash, startedAtMs, {
        status,
        compile,
        tests,
      });
    } finally {
      await rm(jobDirectory, { recursive: true, force: true });
    }
  }

  private async writeSources(
    jobDirectory: string,
    job: ValidatedJob,
  ): Promise<void> {
    for (const file of job.request.sourceFiles) {
      const destination = path.resolve(jobDirectory, file.path);
      const relative = path.relative(jobDirectory, destination);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      ) {
        throw new Error("source path escaped the temporary directory");
      }
      await mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o755,
      });
      await writeFile(destination, file.content, {
        encoding: "utf8",
        mode: 0o444,
        flag: "wx",
      });
    }
  }

  private dockerArguments(
    jobDirectory: string,
    job: ValidatedJob,
    containerName: string,
    mode: "COMPILE" | "RUN",
  ): readonly string[] {
    const limits = job.limits;
    return [
      "run",
      "--rm",
      "--interactive",
      "--name",
      containerName,
      "--label",
      "io.learncoding.runner.job=true",
      "--pull",
      "never",
      "--network",
      "none",
      "--ipc",
      "none",
      "--log-driver",
      "none",
      "--read-only",
      "--init",
      "--stop-timeout",
      "1",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      String(limits.pids),
      "--memory",
      `${limits.memoryMb}m`,
      "--memory-swap",
      `${limits.memoryMb}m`,
      "--cpus",
      String(limits.cpuCount),
      "--ulimit",
      `fsize=${limits.fileBytes}:${limits.fileBytes}`,
      "--ulimit",
      "nofile=64:64",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
      "--tmpfs",
      `/work:rw,exec,nosuid,nodev,size=${limits.fileBytes},uid=65532,gid=65532,mode=0700`,
      "--user",
      "65532:65532",
      "--env",
      "HOME=/tmp",
      "--workdir",
      "/work",
      "--mount",
      `type=bind,src=${jobDirectory},dst=/input,readonly`,
      job.runtime.image,
      job.runtime.harnessPath,
      "--mode",
      mode.toLowerCase(),
      "--language",
      job.runtime.language,
      "--source-root",
      "/input",
      "--entrypoint",
      `/input/${job.request.entrypoint}`,
    ];
  }

  private async runContainer(
    jobDirectory: string,
    job: ValidatedJob,
    containerPrefix: string,
    mode: "COMPILE" | "RUN",
    stdin: string,
    suffix: string,
    budget: ExecutionBudget,
  ): Promise<ProcessResult> {
    const remainingMs = Math.floor(budget.deadlineMs - this.#clock());
    if (remainingMs <= 0 || budget.outputBytesRemaining <= 0) {
      return remainingMs <= 0
        ? syntheticTimeout()
        : {
            ...syntheticTimeout(),
            timedOut: false,
            outputLimitExceeded: true,
          };
    }

    const containerName = `${containerPrefix}-${suffix}`.toLowerCase();
    let result: ProcessResult;
    try {
      result = await this.#process.run({
        command: this.#config.dockerBinary,
        args: this.dockerArguments(
          jobDirectory,
          job,
          containerName,
          mode,
        ),
        stdin,
        timeoutMs: remainingMs,
        maxOutputBytes: budget.outputBytesRemaining,
      });
    } catch {
      result = syntheticInfrastructure();
    }

    const usedOutput =
      Buffer.byteLength(result.stdout, "utf8") +
      Buffer.byteLength(result.stderr, "utf8");
    budget.outputBytesRemaining = Math.max(
      0,
      budget.outputBytesRemaining - usedOutput,
    );

    if (
      result.timedOut ||
      result.outputLimitExceeded ||
      result.exitCode === null ||
      result.exitCode === 125
    ) {
      await this.forceRemove(containerName);
    }
    return result;
  }

  private async forceRemove(containerName: string): Promise<void> {
    try {
      await this.#process.run({
        command: this.#config.dockerBinary,
        args: ["rm", "--force", containerName],
        stdin: "",
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
      });
    } catch {
      // Cleanup is best effort; --rm and VM-level reconciliation remain active.
    }
  }

  private aggregateTestStatus(
    tests: readonly NormalizedTestResult[],
  ): NormalizedStatus {
    if (tests.some((test) => test.status === "INFRASTRUCTURE_ERROR")) {
      return "INFRASTRUCTURE_ERROR";
    }
    if (tests.some((test) => test.status === "TIMEOUT")) {
      return "TIMEOUT";
    }
    if (tests.some((test) => test.status === "MEMORY_LIMIT")) {
      return "MEMORY_LIMIT";
    }
    if (tests.some((test) => test.status === "OUTPUT_LIMIT")) {
      return "OUTPUT_LIMIT";
    }
    if (tests.some((test) => test.status === "RUNTIME_ERROR")) {
      return "RUNTIME_ERROR";
    }
    if (tests.some((test) => test.status === "FAILED")) {
      return "WRONG_ANSWER";
    }
    return "ACCEPTED";
  }

  private result(
    job: ValidatedJob,
    requestHash: string,
    startedAtMs: number,
    execution: {
      readonly status: NormalizedStatus;
      readonly compile: CompileResult;
      readonly run?: RunnerResult["run"];
      readonly tests: readonly NormalizedTestResult[];
    },
  ): RunnerResult {
    const passed = execution.tests.filter(
      (test) => test.status === "PASSED",
    ).length;
    const base = {
      status: execution.status,
      requestHash,
      sourceHash: stableSourceHash(job),
      runtimeVersion: job.runtime.version,
      imageDigest: job.runtime.imageDigest,
      compile: execution.compile,
      tests: execution.tests,
      totals: {
        passed,
        failed: execution.tests.length - passed,
        total: execution.tests.length,
      },
      startedAt: iso(startedAtMs),
      finishedAt: iso(this.#clock()),
    };
    return {
      ...base,
      ...(job.request.testBundleVersion === undefined
        ? {}
        : { testBundleVersion: job.request.testBundleVersion }),
      ...(execution.run === undefined ? {} : { run: execution.run }),
    };
  }
}
