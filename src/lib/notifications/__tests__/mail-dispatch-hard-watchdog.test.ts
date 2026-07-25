// @vitest-environment node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disarmMailDispatchHardWatchdog,
  isMailDispatchHardWatchdogArmed,
  MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS,
  MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS,
  MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS,
  startMailDispatchHardWatchdog,
  type ArmedMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "../mail-dispatch-hard-watchdog";
import { planMailDispatchRuntime } from "../mail-dispatch-runtime-policy";

const TEST_FAULT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_FAULT";
const TEST_HANDSHAKE_NAME =
  "MAIL_DISPATCH_WATCHDOG_TEST_HANDSHAKE_TIMEOUT_MS";

function stubWatchdogFault(fault: string) {
  vi.stubEnv(TEST_FAULT_NAME, fault);
  vi.stubEnv(TEST_HANDSHAKE_NAME, "1000");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function closeController(
  controller: MailDispatchHardWatchdog | undefined,
  armed: ArmedMailDispatchHardWatchdog | undefined,
) {
  if (armed && isMailDispatchHardWatchdogArmed(armed)) {
    await disarmMailDispatchHardWatchdog(armed);
  }
  await controller?.close();
}

type FatalFixtureResult = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

async function runFatalFixture(input: Readonly<{
  fault: string;
  phase: "arm" | "armed" | "disarm" | "idle";
  exitMode: "native" | "return" | "throw";
}>): Promise<FatalFixtureResult> {
  const fixture = path.resolve(
    process.cwd(),
    "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-fatal-parent.mjs",
  );
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS: "1500",
    MAIL_DISPATCH_WATCHDOG_TEST_HANDSHAKE_TIMEOUT_MS: "1000",
    MAIL_DISPATCH_WATCHDOG_TEST_FAULT: input.fault,
    MAIL_DISPATCH_WATCHDOG_TEST_EXIT_MODE: input.exitMode,
    MAIL_DISPATCH_WATCHDOG_TEST_FATAL_PHASE: input.phase,
    DATABASE_URL: "postgresql://watchdog-must-not-inherit",
    GMAIL_CLIENT_SECRET: "gmail-secret-must-not-inherit",
    DELETION_TOMBSTONE_KEY: "tombstone-must-not-inherit",
    LOST_DEVICE_PROOF_KEY: "proof-key-must-not-inherit",
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
      reject(new Error("Watchdog fatal fixture did not terminate."));
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

  return { ...result, stdout, stderr };
}

describe("mail dispatch external hard watchdog", () => {
  it("binds and packages the exact production timer implementation", () => {
    const policy = planMailDispatchRuntime();

    expect(MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS).toBe(55_000);
    expect(MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS).toBe(2_000);
    expect(MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS).toBe(2_000);
    expect(MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS).toBe(
      policy.timeouts.hardWatchdogMs,
    );
    expect(MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS).toBe(
      policy.timeouts.watchdogArmAckMs,
    );
    expect(MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS).toBe(
      policy.timeouts.watchdogDisarmDeliveryMs,
    );
    expect(
      MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS
      + 47_000
      + MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS,
    ).toBeLessThan(MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS);

    const childSource = readFileSync(
      path.resolve(
        process.cwd(),
        "src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs",
      ),
      "utf8",
    );
    expect(childSource).toContain("const PRODUCTION_TIMEOUT_MS = 55_000;");

    const dockerfile = readFileSync(
      path.resolve(process.cwd(), "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "COPY --chown=node:node src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs ./src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs",
    );
  });

  it("returns an opaque capability only after ARM acknowledgement and requires DISARM acknowledgement", async () => {
    let controller: MailDispatchHardWatchdog | undefined;
    let armed: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog();
      armed = await controller.arm();

      expect(Object.isFrozen(armed)).toBe(true);
      expect(Reflect.ownKeys(armed)).toEqual([]);
      expect(isMailDispatchHardWatchdogArmed(armed)).toBe(true);
      await expect(controller.arm()).rejects.toThrow(/already armed/i);

      await disarmMailDispatchHardWatchdog(armed);
      expect(isMailDispatchHardWatchdogArmed(armed)).toBe(false);
      await expect(disarmMailDispatchHardWatchdog(armed))
        .rejects.toThrow(/not armed/i);
      armed = undefined;
    } finally {
      await closeController(controller, armed);
    }
  });

  it("accepts delayed ARM acknowledgement and DISARM delivery only inside the explicit IPC budget", async () => {
    stubWatchdogFault("DELAY_BOUNDARY_IPC");
    let controller: MailDispatchHardWatchdog | undefined;
    let armed: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog();
      armed = await controller.arm();
      expect(isMailDispatchHardWatchdogArmed(armed)).toBe(true);
      await disarmMailDispatchHardWatchdog(armed);
      armed = undefined;
    } finally {
      await closeController(controller, armed);
    }
  });

  it("rejects forged and stale-generation capabilities without disarming the current generation", async () => {
    let controller: MailDispatchHardWatchdog | undefined;
    let current: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog();
      const first = await controller.arm();
      await disarmMailDispatchHardWatchdog(first);

      current = await controller.arm();
      const forged = Object.freeze({}) as ArmedMailDispatchHardWatchdog;
      expect(isMailDispatchHardWatchdogArmed(first)).toBe(false);
      expect(isMailDispatchHardWatchdogArmed(forged)).toBe(false);
      await expect(disarmMailDispatchHardWatchdog(first))
        .rejects.toThrow(/not armed/i);
      await expect(disarmMailDispatchHardWatchdog(forged))
        .rejects.toThrow(/not armed/i);
      expect(isMailDispatchHardWatchdogArmed(current)).toBe(true);

      await disarmMailDispatchHardWatchdog(current);
      current = undefined;
    } finally {
      await closeController(controller, current);
    }
  });

  it.each([
    "EXIT_BEFORE_READY",
    "MALFORMED_READY",
    "RAW_KILL_THROW_BEFORE_READY",
    "RAW_KILL_UNAVAILABLE_BEFORE_READY",
  ])("refuses startup for child fault %s without invoking the post-ready fatal hook", async (fault) => {
    stubWatchdogFault(fault);
    const outcome = await startMailDispatchHardWatchdog().then(
      (controller) => ({ kind: "started" as const, controller }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );

    if (outcome.kind === "started") {
      await outcome.controller.close();
    }
    expect(outcome.kind).toBe("failed");
  });

  it.each([
    ["DISCONNECT_AFTER_READY", "idle"],
    ["MALFORMED_ARMED", "arm"],
    ["DROP_ARM_ACK", "arm"],
    ["DISCONNECT_ON_ARM", "arm"],
    ["SEND_CALLBACK_ERROR", "arm"],
    ["SEND_SYNC_THROW", "arm"],
    ["MALFORMED_DISARMED", "disarm"],
    ["DROP_DISARM_ACK", "disarm"],
    ["DISCONNECT_ON_DISARM", "disarm"],
  ] as const)(
    "module-owned exit terminates post-READY fault %s without unwind",
    { timeout: 10_000 },
    async (fault, phase) => {
      const result = await runFatalFixture({
        fault,
        phase,
        exitMode: "native",
      });

      expect(result).toEqual({
        code: 1,
        signal: null,
        stdout: "",
        stderr: "",
      });
    },
  );

  it.each(["return", "throw"] as const)(
    "uses captured reallyExit when public process.exit is patched to %s",
    { timeout: 10_000 },
    async (exitMode) => {
      const result = await runFatalFixture({
        fault: "CONTROLLER_FAIL_AFTER_ARMED",
        phase: "armed",
        exitMode,
      });

      expect(result).toEqual({
        code: 1,
        signal: null,
        stdout: "ARMED\n",
        stderr: "",
      });
    },
  );

  it(
    "kills a stalled or SIGSTOPped parent without running cleanup, health, retry, or telemetry callbacks",
    { timeout: 10_000 },
    async () => {
      const fixture = path.resolve(
        process.cwd(),
        "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-parent.mjs",
      );
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS: "250",
        DATABASE_URL: "postgresql://watchdog-must-not-inherit",
        GMAIL_CLIENT_SECRET: "gmail-secret-must-not-inherit",
        DELETION_TOMBSTONE_KEY: "tombstone-must-not-inherit",
        LOST_DEVICE_PROOF_KEY: "proof-key-must-not-inherit",
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
      let stopAttempted = false;
      let stopSignalAccepted = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (
          process.platform !== "win32"
          && !stopAttempted
          && stdout.includes("ARMED\n")
        ) {
          stopAttempted = true;
          stopSignalAccepted = child.kill("SIGSTOP");
        }
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
          reject(new Error("Watchdog subprocess did not hard-exit."));
        }, 5_000);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });

      expect(stdout).toBe("ARMED\n");
      expect(stderr).toBe("");
      expect(stdout).not.toMatch(/POOL_END|HEALTH|RETRY|TELEMETRY|FINALLY/u);
      if (process.platform === "win32") {
        expect(result.code).not.toBe(0);
      } else {
        expect(stopAttempted).toBe(true);
        expect(stopSignalAccepted).toBe(true);
        expect(result.signal).toBe("SIGKILL");
      }
    },
  );

  it.each([
    "EXIT_AFTER_ARMED",
    "DISCONNECT_AFTER_ARMED",
    "UNCAUGHT_AFTER_ARMED",
    "UNHANDLED_REJECTION_AFTER_ARMED",
  ])(
    "child fault %s independently kills a frozen parent before its five-second watchdog timer",
    { timeout: 10_000 },
    async (fault) => {
      const fixture = path.resolve(
        process.cwd(),
        "src/lib/notifications/__tests__/fixtures/mail-dispatch-hard-watchdog-parent.mjs",
      );
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS: "5000",
        MAIL_DISPATCH_WATCHDOG_TEST_FAULT: fault,
        DATABASE_URL: "postgresql://watchdog-must-not-inherit",
        GMAIL_CLIENT_SECRET: "gmail-secret-must-not-inherit",
        DELETION_TOMBSTONE_KEY: "tombstone-must-not-inherit",
        LOST_DEVICE_PROOF_KEY: "proof-key-must-not-inherit",
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
          reject(new Error("Faulted watchdog did not kill its frozen parent."));
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

      expect(stdout).toBe("ARMED\n");
      expect(stderr).toBe("");
      expect(stdout).not.toMatch(/POOL_END|HEALTH|RETRY|TELEMETRY|FINALLY/u);
      if (process.platform === "win32") {
        expect(result.code).not.toBe(0);
      } else {
        expect(result.signal).toBe("SIGKILL");
      }
    },
  );
});
