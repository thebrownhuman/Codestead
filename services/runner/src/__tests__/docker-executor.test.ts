import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerJobExecutor } from "../docker-executor.js";
import { validateJobRequest } from "../validation.js";
import {
  FakeProcessExecutor,
  jobRequest,
  processResult,
  testConfig,
} from "./fixtures.js";

const roots: string[] = [];

async function environment() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "runner-executor-test-"),
  );
  roots.push(root);
  const config = testConfig({ tempRoot: root });
  return { root, config };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Docker CLI execution plan", () => {
  it("uses fixed digest image and all mandatory isolation flags", async () => {
    const { config } = await environment();
    const process = new FakeProcessExecutor([
      processResult(),
      processResult({ stdout: "hello\n" }),
    ]);
    const executor = new DockerJobExecutor(config, process);
    const validated = validateJobRequest(
      jobRequest("python", { stdin: "input" }),
      config,
    );
    const result = await executor.execute(validated, "a".repeat(64));

    expect(result.status).toBe("ACCEPTED");
    expect(result.imageDigest).toBe(
      `sha256:${"d".repeat(64)}`,
    );
    const request = process.requests[0]!;
    expect(request.command).toBe("docker");
    expect(request.args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--interactive",
        "--label",
        "io.learncoding.runner.job=true",
        "--pull",
        "never",
        "--ipc",
        "none",
        "--log-driver",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "32",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--cpus",
        "0.5",
        "--user",
        "65532:65532",
        "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
        "/work:rw,exec,nosuid,nodev,size=16777216,uid=65532,gid=65532,mode=0700",
        config.runtimes.python.image,
        config.runtimes.python.harnessPath,
      ]),
    );
    expect(request.args).not.toContain("sh");
    expect(request.args).not.toContain("-c");
  });

  it("keeps hidden expected output outside every process request", async () => {
    const { config } = await environment();
    const process = new FakeProcessExecutor([
      processResult(),
      processResult({ stdout: "TOP_SECRET_EXPECTED" }),
    ]);
    const executor = new DockerJobExecutor(config, process);
    const validated = validateJobRequest(
      jobRequest("python", {
        mode: "TEST",
        stdin: undefined,
        testBundleVersion: "bundle-1",
        tests: [
          {
            id: "hidden-1",
            visibility: "HIDDEN",
            category: "edge",
            stdin: "hidden-input",
            expectedStdout: "TOP_SECRET_EXPECTED",
            comparison: "EXACT",
          },
        ],
      }),
      config,
    );
    const result = await executor.execute(validated, "b".repeat(64));

    expect(result.status).toBe("ACCEPTED");
    expect(process.requests[1]!.stdin).toBe("hidden-input");
    expect(JSON.stringify(process.requests)).not.toContain(
      "TOP_SECRET_EXPECTED",
    );
    expect(result.tests[0]).not.toHaveProperty("actualStdout");
    expect(result.tests[0]).not.toHaveProperty("expectedStdout");
    expect(JSON.stringify(result.tests[0])).not.toContain("TOP_SECRET");
  });

  it("stops after a compile error and normalizes diagnostics", async () => {
    const { config } = await environment();
    const process = new FakeProcessExecutor([
      processResult({
        exitCode: 10,
        stderr: "/input/main.py: compile failed",
      }),
    ]);
    const executor = new DockerJobExecutor(config, process);
    const result = await executor.execute(
      validateJobRequest(jobRequest(), config),
      "c".repeat(64),
    );
    expect(result.status).toBe("COMPILE_ERROR");
    expect(result.compile.stderr).toContain(
      "<workspace>/main.py",
    );
    expect(process.requests).toHaveLength(1);
  });

  it("force-removes a named container after timeout", async () => {
    const { config } = await environment();
    const process = new FakeProcessExecutor([
      processResult({ exitCode: null, timedOut: true }),
      processResult(),
    ]);
    const executor = new DockerJobExecutor(config, process);
    const result = await executor.execute(
      validateJobRequest(jobRequest(), config),
      "d".repeat(64),
    );
    expect(result.status).toBe("TIMEOUT");
    expect(process.requests).toHaveLength(2);
    expect(process.requests[1]!.args.slice(0, 2)).toEqual([
      "rm",
      "--force",
    ]);
  });

  it("enforces a total output budget across phases", async () => {
    const { config } = await environment();
    const process = new FakeProcessExecutor([
      processResult({ stdout: "1234" }),
    ]);
    const executor = new DockerJobExecutor(config, process);
    const result = await executor.execute(
      validateJobRequest(
        jobRequest("python", { limits: { outputBytes: 4 } }),
        config,
      ),
      "e".repeat(64),
    );
    expect(result.status).toBe("OUTPUT_LIMIT");
    expect(process.requests).toHaveLength(1);
  });

  it("normalizes visible wrong answers and totals", async () => {
    const { config } = await environment();
    const process = new FakeProcessExecutor([
      processResult(),
      processResult({ stdout: "wrong" }),
    ]);
    const executor = new DockerJobExecutor(config, process);
    const result = await executor.execute(
      validateJobRequest(
        jobRequest("python", {
          mode: "TEST",
          stdin: undefined,
          testBundleVersion: "bundle-1",
          tests: [
            {
              id: "visible-1",
              visibility: "VISIBLE",
              category: "example",
              stdin: "",
              expectedStdout: "right",
              comparison: "EXACT",
            },
          ],
        }),
        config,
      ),
      "f".repeat(64),
    );
    expect(result.status).toBe("WRONG_ANSWER");
    expect(result.totals).toEqual({ passed: 0, failed: 1, total: 1 });
    expect(result.tests[0]).toMatchObject({
      actualStdout: "wrong",
      expectedStdout: "right",
    });
  });

  it("removes the temporary source directory after every job", async () => {
    const { config } = await environment();
    const process = new FakeProcessExecutor([
      processResult(),
      processResult(),
    ]);
    const executor = new DockerJobExecutor(config, process);
    await executor.execute(
      validateJobRequest(jobRequest(), config),
      "1".repeat(64),
    );
    const mountArgument =
      process.requests[0]!.args[
        process.requests[0]!.args.indexOf("--mount") + 1
      ]!;
    const mountedPath = /^type=bind,src=(.+),dst=\/input,readonly$/.exec(
      mountArgument,
    )?.[1];
    expect(mountedPath).toBeDefined();
    expect(existsSync(mountedPath!)).toBe(false);
  });

  it("maps process-adapter failure to infrastructure failure", async () => {
    const { config } = await environment();
    const process = new FakeProcessExecutor([
      new Error("docker unavailable"),
    ]);
    const executor = new DockerJobExecutor(config, process);
    const result = await executor.execute(
      validateJobRequest(jobRequest(), config),
      "2".repeat(64),
    );
    expect(result.status).toBe("INFRASTRUCTURE_ERROR");
    expect(result.compile.stderr).not.toContain("docker unavailable");
  });
});
