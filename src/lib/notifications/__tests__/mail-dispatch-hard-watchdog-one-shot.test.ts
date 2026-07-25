// @vitest-environment node

import { fork, type ForkOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

function childEnvironment(fault: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MAIL_DISPATCH_WATCHDOG_TEST_FAULT: fault,
  };
  for (const name of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

async function runOneShotFixture(fault: string) {
  const options: ForkOptions & Readonly<{ windowsHide: true }> = {
    cwd: process.cwd(),
    env: childEnvironment(fault),
    execArgv: [
      "--import",
      pathToFileURL(
        path.resolve(
          process.cwd(),
          "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-raw-kill-probe.mjs",
        ),
      ).href,
    ],
    serialization: "json",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  };
  const child = fork(
    path.resolve(
      process.cwd(),
      "src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs",
    ),
    [],
    options,
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("message", (message) => {
    if (
      message
      && typeof message === "object"
      && (message as { type?: unknown }).type === "READY"
    ) {
      child.send({ type: "ARM", generation: 1 });
    }
  });

  const result = await new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("One-shot raw-kill fixture did not close."));
    }, 3_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  return { result, stderr, stdout };
}

describe("mail dispatch watchdog one-shot parent kill", () => {
  it.each([
    ["EXIT_AFTER_ARMED", 81],
    ["UNCAUGHT_AFTER_ARMED", 72],
  ] as const)(
    "attempts one successful numeric parent raw-kill for %s",
    { timeout: 10_000 },
    async (fault, expectedCode) => {
      const { result, stderr, stdout } = await runOneShotFixture(fault);

      expect(result).toEqual({ code: expectedCode, signal: null });
      expect(stdout).toBe("PARENT_RAW_SIGKILL\n");
      expect(stderr).toBe("");
    },
  );

  it("contains one parent raw-kill site and no retry scheduler", () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        "src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs",
      ),
      "utf8",
    );
    const start = source.indexOf(
      "function killCapturedParentForFailure(code) {",
    );
    const end = source.indexOf("\nfunction fail(code) {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const fatalPath = source.slice(start, end);

    const exitStart = source.indexOf('process.on("exit", () => {');
    const exitEnd = source.indexOf(
      '\nprocess.on("uncaughtException"',
      exitStart,
    );
    expect(exitStart).toBeGreaterThanOrEqual(0);
    expect(exitEnd).toBeGreaterThan(exitStart);
    const exitPath = source.slice(exitStart, exitEnd);

    const parentKillPattern =
      /capturedRawKill\(parentPid, capturedSigkill\)/gu;
    expect(
      source.match(parentKillPattern) ?? [],
    ).toHaveLength(2);
    expect(fatalPath.match(parentKillPattern) ?? []).toHaveLength(1);
    expect(exitPath.match(parentKillPattern) ?? []).toHaveLength(1);
    expect(fatalPath).toContain('if (phase === "fatal") return;');
    expect(fatalPath).toContain('phase = "fatal";');
    for (const pathSource of [fatalPath, exitPath]) {
      expect(pathSource).not.toMatch(
        /\b(?:for|while)\s*\(|\b(?:queueMicrotask|setImmediate|setInterval|setTimeout)\s*\(/u,
      );
    }
  });
});
