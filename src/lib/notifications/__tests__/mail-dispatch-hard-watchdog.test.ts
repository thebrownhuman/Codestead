// @vitest-environment node

import { ChildProcess, spawn } from "node:child_process";
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

function fatalExit(error: Error): never {
  throw error;
}

const TEST_FAULT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_FAULT";
const TEST_HANDSHAKE_NAME =
  "MAIL_DISPATCH_WATCHDOG_TEST_HANDSHAKE_TIMEOUT_MS";

function recordingFatalExit(errors: Error[]) {
  return ((error: Error) => {
    errors.push(error);
    return undefined as never;
  }) as Parameters<typeof startMailDispatchHardWatchdog>[0]["fatalExit"];
}

function stubWatchdogFault(fault: string) {
  vi.stubEnv(TEST_FAULT_NAME, fault);
  vi.stubEnv(TEST_HANDSHAKE_NAME, "100");
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
      controller = await startMailDispatchHardWatchdog({ fatalExit });
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
      controller = await startMailDispatchHardWatchdog({ fatalExit });
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
      controller = await startMailDispatchHardWatchdog({ fatalExit });
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
  ])("refuses startup for child fault %s without invoking the post-ready fatal hook", async (fault) => {
    stubWatchdogFault(fault);
    const fatalities: Error[] = [];
    const outcome = await startMailDispatchHardWatchdog({
      fatalExit: recordingFatalExit(fatalities),
    }).then(
      (controller) => ({ kind: "started" as const, controller }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );

    if (outcome.kind === "started") {
      await outcome.controller.close();
    }
    expect(outcome.kind).toBe("failed");
    expect(fatalities).toEqual([]);
  });

  it("fatal-exits if the ready child disconnects while idle", async () => {
    stubWatchdogFault("DISCONNECT_AFTER_READY");
    const fatalities: Error[] = [];
    let controller: MailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog({
        fatalExit: recordingFatalExit(fatalities),
      });
      await vi.waitFor(() => expect(fatalities).toHaveLength(1), {
        timeout: 1_000,
      });
      expect(fatalities[0]).toMatchObject({
        code: "WATCHDOG_CHILD_FAILED",
      });
    } finally {
      await closeController(controller, undefined);
    }
  });

  it.each([
    "MALFORMED_ARMED",
    "DROP_ARM_ACK",
    "DISCONNECT_ON_ARM",
    "SEND_CALLBACK_ERROR",
  ])("rejects ARM and fatal-exits for child fault %s", async (fault) => {
    stubWatchdogFault(fault);
    const fatalities: Error[] = [];
    let controller: MailDispatchHardWatchdog | undefined;
    let armed: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog({
        fatalExit: recordingFatalExit(fatalities),
      });
      const outcome = await controller.arm().then(
        (capability) => ({ kind: "armed" as const, capability }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      if (outcome.kind === "armed") armed = outcome.capability;

      expect(outcome.kind).toBe("failed");
      await vi.waitFor(() => expect(fatalities).toHaveLength(1), {
        timeout: 1_000,
      });
      expect(fatalities[0]).toMatchObject({
        code: expect.stringMatching(
          /^WATCHDOG_(?:PROTOCOL_INVALID|HANDSHAKE_TIMEOUT|CHILD_FAILED)$/u,
        ),
      });
    } finally {
      await closeController(controller, armed);
    }
  });

  it("invokes the fatal hook before best-effort IPC teardown and contains teardown exceptions", async () => {
    stubWatchdogFault("MALFORMED_ARMED");
    const order: string[] = [];
    const fatalities: Error[] = [];
    let controller: MailDispatchHardWatchdog | undefined;
    const kill = vi
      .spyOn(ChildProcess.prototype, "kill")
      .mockImplementation(() => {
        order.push("teardown");
        throw new Error("injected teardown failure");
      });
    try {
      controller = await startMailDispatchHardWatchdog({
        fatalExit: ((error: Error) => {
          order.push("fatal");
          fatalities.push(error);
          return undefined as never;
        }) as Parameters<
          typeof startMailDispatchHardWatchdog
        >[0]["fatalExit"],
      });
      const outcome = await controller.arm().then(
        () => "armed" as const,
        () => "failed" as const,
      );

      expect(outcome).toBe("failed");
      expect(fatalities).toHaveLength(1);
      expect(order[0]).toBe("fatal");
      expect(order).toContain("teardown");
    } finally {
      kill.mockRestore();
      await closeController(controller, undefined);
    }
  });

  it.each([
    "MALFORMED_DISARMED",
    "DROP_DISARM_ACK",
    "DISCONNECT_ON_DISARM",
  ])("rejects DISARM and fatal-exits for child fault %s", async (fault) => {
    stubWatchdogFault(fault);
    const fatalities: Error[] = [];
    let controller: MailDispatchHardWatchdog | undefined;
    let armed: ArmedMailDispatchHardWatchdog | undefined;
    try {
      controller = await startMailDispatchHardWatchdog({
        fatalExit: recordingFatalExit(fatalities),
      });
      armed = await controller.arm();
      const capability = armed;
      const outcome = await disarmMailDispatchHardWatchdog(capability).then(
        () => ({ kind: "disarmed" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      if (outcome.kind === "disarmed") armed = undefined;

      expect(outcome.kind).toBe("failed");
      await vi.waitFor(() => expect(fatalities).toHaveLength(1), {
        timeout: 1_000,
      });
      expect(isMailDispatchHardWatchdogArmed(capability)).toBe(false);
    } finally {
      await closeController(controller, armed);
    }
  });

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
        child.once("exit", (code, signal) => {
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
        child.once("exit", (code, signal) => {
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
