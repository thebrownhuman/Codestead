import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  NATIVE_RUNTIME_VERSIONS,
  type RunnerConfig,
} from "../config.js";
import type {
  ProcessExecutor,
  ProcessRequest,
  ProcessResult,
} from "../process-executor.js";
import type {
  Language,
  RunnerJobRequest,
  RunnerResult,
} from "../types.js";

const DIGESTS: Record<Language, string> = {
  c: "a".repeat(64),
  cpp: "b".repeat(64),
  java: "c".repeat(64),
  python: "d".repeat(64),
  javascript: "e".repeat(64),
};

export function testConfig(
  overrides: Partial<RunnerConfig> = {},
): RunnerConfig {
  const runtime = (
    language: Language,
    version: string,
    extensions: readonly string[],
    defaultEntrypoint: string,
  ) => ({
    language,
    version,
    image: `registry.test/runner-${language}@sha256:${DIGESTS[language]}`,
    imageDigest: `sha256:${DIGESTS[language]}`,
    harnessPath: "/opt/runner/execute",
    allowedExtensions: extensions,
    defaultEntrypoint,
  });
  return {
    host: "127.0.0.1",
    port: 4100,
    sharedSecret: "test-secret-that-is-at-least-32-bytes-long",
    authMaxSkewSeconds: 300,
    nonceTtlSeconds: 900,
    maxBodyBytes: 1_048_576,
    maxSourceBytes: 131_072,
    maxSourceFiles: 8,
    maxTests: 50,
    maxQueueDepth: 100,
    concurrency: 2,
    idempotencyTtlMs: 86_400_000,
    idempotencyCapacity: 10_000,
    dockerBinary: "docker",
    tempRoot: path.join(
      os.tmpdir(),
      "learncoding-runner-temp-test",
      randomUUID(),
    ),
    stateRoot: path.join(
      os.tmpdir(),
      "learncoding-runner-state-test",
      randomUUID(),
    ),
    defaults: {
      wallTimeMs: 5_000,
      memoryMb: 128,
      cpuCount: 0.5,
      pids: 32,
      outputBytes: 65_536,
      fileBytes: 16_777_216,
    },
    maxima: {
      wallTimeMs: 30_000,
      memoryMb: 512,
      cpuCount: 1,
      pids: 64,
      outputBytes: 262_144,
      fileBytes: 67_108_864,
    },
    runtimes: {
      c: runtime(
        "c",
        NATIVE_RUNTIME_VERSIONS.c,
        [".c", ".h"],
        "main.c",
      ),
      cpp: runtime(
        "cpp",
        NATIVE_RUNTIME_VERSIONS.cpp,
        [".cpp", ".cc", ".cxx", ".h", ".hpp"],
        "main.cpp",
      ),
      java: runtime("java", "Java 21", [".java"], "Main.java"),
      python: runtime("python", "Python 3.14", [".py"], "main.py"),
      javascript: runtime(
        "javascript",
        "Node.js 22",
        [".js", ".mjs"],
        "main.js",
      ),
    },
    ...overrides,
  };
}

export function jobRequest(
  language: Language = "python",
  overrides: {
    [Key in keyof RunnerJobRequest]?:
      | RunnerJobRequest[Key]
      | undefined;
  } = {},
): RunnerJobRequest {
  const config = testConfig();
  const runtime = config.runtimes[language];
  const merged = {
    submissionId: "submission-1",
    correlationId: "correlation-1",
    language,
    runtimeVersion: runtime.version,
    mode: "RUN",
    sourceFiles: [
      {
        path: runtime.defaultEntrypoint,
        content: "learner source; never executed by tests",
      },
    ],
    entrypoint: runtime.defaultEntrypoint,
    stdin: "",
    ...overrides,
  };
  for (const key of Object.keys(merged) as Array<keyof typeof merged>) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  return merged as RunnerJobRequest;
}

export function processResult(
  overrides: Partial<ProcessResult> = {},
): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    wallTimeMs: 5,
    timedOut: false,
    outputLimitExceeded: false,
    ...overrides,
  };
}

export class FakeProcessExecutor implements ProcessExecutor {
  readonly requests: ProcessRequest[] = [];
  readonly #responses: Array<
    ProcessResult | Error | (() => Promise<ProcessResult>)
  >;

  constructor(
    responses: Array<
      ProcessResult | Error | (() => Promise<ProcessResult>)
    >,
  ) {
    this.#responses = [...responses];
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("fake process response queue is empty");
    }
    if (response instanceof Error) {
      throw response;
    }
    return typeof response === "function" ? response() : response;
  }
}

export function runnerResult(
  overrides: Partial<RunnerResult> = {},
): RunnerResult {
  return {
    status: "ACCEPTED",
    requestHash: "f".repeat(64),
    sourceHash: "e".repeat(64),
    runtimeVersion: "Python 3.14",
    imageDigest: `sha256:${"d".repeat(64)}`,
    compile: {
      status: "OK",
      exitCode: 0,
      stdout: "",
      stderr: "",
      wallTimeMs: 1,
    },
    tests: [],
    totals: { passed: 0, failed: 0, total: 0 },
    startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:00:01.000Z",
    ...overrides,
  };
}
