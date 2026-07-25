// @vitest-environment node

import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

type FixtureResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

async function runFixture(): Promise<FixtureResult> {
  const fixture = path.resolve(
    process.cwd(),
    "src/lib/notifications/__tests__/fixtures/guarded-outbox-pool-drift-failstop.mjs",
  );
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
  };
  for (const name of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }

  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixture],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("TX2 pool-drift fixture did not terminate."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  return { ...result, stdout, stderr };
}

describe("guarded TX2 pool authority", () => {
  it(
    "fail-stops before TX2 acquisition or provider initiation after live pool drift",
    { timeout: 15_000 },
    async () => {
      const result = await runFixture();

      expect(result).toEqual({
        code: 1,
        signal: null,
        stdout: "READY\n",
        stderr: "",
      });
      expect(result.stdout).not.toMatch(
        /FORBIDDEN_TX2_CONNECT|FORBIDDEN_PROVIDER|RESUMED/u,
      );
      expect(result.stdout).not.toMatch(
        /11111111|22222222|33333333|learner@example/u,
      );
    },
  );
});
