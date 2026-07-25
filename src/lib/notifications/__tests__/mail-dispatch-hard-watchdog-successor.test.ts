// @vitest-environment node

import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

type FixtureResult = Readonly<{
  code: number | null;
  elapsedMs: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}>;

function testEnvironment(
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://watchdog-must-not-inherit",
    GMAIL_CLIENT_SECRET: "gmail-secret-must-not-inherit",
    DELETION_TOMBSTONE_KEY: "tombstone-must-not-inherit",
    LOST_DEVICE_PROOF_KEY: "proof-key-must-not-inherit",
    ...extra,
  };
  for (const name of ["PATH", "SYSTEMROOT", "WINDIR"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

async function runFixture(input: Readonly<{
  fixture: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}>): Promise<FixtureResult> {
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", input.fixture],
    {
      cwd: process.cwd(),
      env: input.environment,
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

  const closed = await new Promise<Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Watchdog successor fixture did not close."));
    }, input.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  return {
    ...closed,
    elapsedMs: performance.now() - startedAt,
    stdout,
    stderr,
  };
}

function expectRawSigkill(result: FixtureResult) {
  if (process.platform === "win32") {
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
  } else {
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  }
}

describe("mail dispatch hard watchdog native-exit successor", () => {
  it(
    "confirms a graceful child close without reaching either kill bound",
    { timeout: 10_000 },
    async () => {
      const result = await runFixture({
        fixture: path.resolve(
          process.cwd(),
          "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-close-parent.mjs",
        ),
        environment: testEnvironment({}),
        timeoutMs: 3_000,
      });

      expect(result).toMatchObject({
        code: 0,
        signal: null,
        stdout: "CLOSED\n",
        stderr: "",
      });
      expect(result.elapsedMs).toBeLessThan(2_500);
    },
  );

  it(
    "arms the child timer before dropping ACK while the shorter parent bound parks",
    { timeout: 10_000 },
    async () => {
      const result = await runFixture({
        fixture: path.resolve(
          process.cwd(),
          "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-drop-arm-parent.mjs",
        ),
        environment: testEnvironment({
          MAIL_DISPATCH_WATCHDOG_TEST_FAULT: "DROP_ARM_ACK",
          MAIL_DISPATCH_WATCHDOG_TEST_HANDSHAKE_TIMEOUT_MS: "1000",
          MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS: "1500",
        }),
        timeoutMs: 4_000,
      });

      expectRawSigkill(result);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.elapsedMs).toBeGreaterThanOrEqual(1_400);
      expect(result.elapsedMs).toBeLessThan(3_500);
    },
  );

  it(
    "uses the child import-captured numeric raw kill from an ordinary exit hook after mutation",
    { timeout: 10_000 },
    async () => {
      const result = await runFixture({
        fixture: path.resolve(
          process.cwd(),
          "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-parent.mjs",
        ),
        environment: testEnvironment({
          MAIL_DISPATCH_WATCHDOG_TEST_FAULT:
            "EXIT_AFTER_ARMED_WITH_MUTATED_KILL",
          MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS: "5000",
        }),
        timeoutMs: 3_000,
      });

      expectRawSigkill(result);
      expect(result.stdout).toBe("ARMED\n");
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toMatch(
        /POOL_END|HEALTH|RETRY|TELEMETRY|FINALLY/u,
      );
      expect(result.elapsedMs).toBeLessThan(2_500);
    },
  );
});
