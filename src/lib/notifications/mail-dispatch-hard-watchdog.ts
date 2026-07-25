import {
  fork,
  type ChildProcess,
  type ForkOptions,
} from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAIL_DISPATCH_HARD_WATCHDOG_TIMEOUT_MS = 55_000;
export const MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS = 2_000;
export const MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS = 2_000;

const WATCHDOG_READY_TIMEOUT_MS = 5_000;
const WATCHDOG_CHILD_URL = new URL(
  "./mail-dispatch-hard-watchdog-child.mjs",
  import.meta.url,
);
const WATCHDOG_CHILD_PATH = WATCHDOG_CHILD_URL.protocol === "file:"
  ? fileURLToPath(WATCHDOG_CHILD_URL)
  : process.env.NODE_ENV === "test"
    ? path.resolve(
      process.cwd(),
      "src/lib/notifications/mail-dispatch-hard-watchdog-child.mjs",
    )
    : "";
const TEST_TIMEOUT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS";
const TEST_FAULT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_FAULT";
const TEST_HANDSHAKE_NAME =
  "MAIL_DISPATCH_WATCHDOG_TEST_HANDSHAKE_TIMEOUT_MS";
const TEST_FAULTS = new Set([
  "DELAY_BOUNDARY_IPC",
  "DISCONNECT_AFTER_ARMED",
  "DISCONNECT_AFTER_READY",
  "DISCONNECT_ON_ARM",
  "DISCONNECT_ON_DISARM",
  "DROP_ARM_ACK",
  "DROP_DISARM_ACK",
  "EXIT_AFTER_ARMED",
  "EXIT_BEFORE_READY",
  "MALFORMED_ARMED",
  "MALFORMED_DISARMED",
  "MALFORMED_READY",
  "SEND_CALLBACK_ERROR",
  "UNCAUGHT_AFTER_ARMED",
  "UNHANDLED_REJECTION_AFTER_ARMED",
]);

export type MailDispatchHardWatchdogErrorCode =
  | "WATCHDOG_START_FAILED"
  | "WATCHDOG_HANDSHAKE_TIMEOUT"
  | "WATCHDOG_PROTOCOL_INVALID"
  | "WATCHDOG_CHILD_FAILED"
  | "WATCHDOG_NOT_IDLE"
  | "WATCHDOG_NOT_ARMED";

export class MailDispatchHardWatchdogError extends Error {
  constructor(readonly code: MailDispatchHardWatchdogErrorCode) {
    super(
      code === "WATCHDOG_NOT_IDLE"
        ? "Mail dispatch hard watchdog is already armed or busy."
        : code === "WATCHDOG_NOT_ARMED"
          ? "Mail dispatch hard watchdog is not armed."
          : `Mail dispatch hard watchdog failed (${code}).`,
    );
    this.name = "MailDispatchHardWatchdogError";
  }
}

declare const armedMailDispatchHardWatchdogBrand: unique symbol;

export type ArmedMailDispatchHardWatchdog = Readonly<{
  [armedMailDispatchHardWatchdogBrand]: "ArmedMailDispatchHardWatchdog";
}>;

export type MailDispatchHardWatchdog = Readonly<{
  arm(): Promise<ArmedMailDispatchHardWatchdog>;
  close(): Promise<void>;
}>;

type FatalExit = (error: MailDispatchHardWatchdogError) => never;
type Phase =
  | "starting"
  | "idle"
  | "arming"
  | "armed"
  | "disarming"
  | "closing"
  | "closed"
  | "failed";
type PendingHandshake = {
  readonly expectedType: "READY" | "ARMED" | "DISARMED" | "CLOSED";
  readonly generation?: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
};
type ControllerState = {
  readonly child: ChildProcess;
  readonly fatalExit: FatalExit;
  phase: Phase;
  generation: number;
  pending?: PendingHandshake;
  capability?: ArmedMailDispatchHardWatchdog;
  expectedClose: boolean;
};
type ArmedState = Readonly<{
  capability: ArmedMailDispatchHardWatchdog;
  controller: MailDispatchHardWatchdog;
  generation: number;
  state: ControllerState;
}>;

const CONTROLLERS = new WeakMap<MailDispatchHardWatchdog, ControllerState>();
const ARMED_CAPABILITIES = new WeakMap<
  ArmedMailDispatchHardWatchdog,
  ArmedState
>();

function watchdogError(
  code: MailDispatchHardWatchdogErrorCode,
): MailDispatchHardWatchdogError {
  return new MailDispatchHardWatchdogError(code);
}

function activeTestFault(): string | undefined {
  if (process.env.NODE_ENV !== "test") return undefined;
  const fault = process.env[TEST_FAULT_NAME];
  return fault && TEST_FAULTS.has(fault) ? fault : undefined;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: Record<string, string> & {
    NODE_ENV: "production" | "test";
  } = {
    NODE_ENV: "production",
  };
  if (process.platform === "win32") {
    for (const name of ["SYSTEMROOT", "WINDIR"] as const) {
      if (process.env[name]) environment[name] = process.env[name];
    }
  }
  if (process.env.NODE_ENV !== "test") return environment;

  const testTimeout = process.env[TEST_TIMEOUT_NAME];
  const testFault = activeTestFault();
  if (
    testTimeout
    && /^[1-9][0-9]*$/u.test(testTimeout)
  ) {
    environment.NODE_ENV = "test";
    environment[TEST_TIMEOUT_NAME] = testTimeout;
  }
  if (testFault) {
    environment.NODE_ENV = "test";
    environment[TEST_FAULT_NAME] = testFault;
  }
  return environment;
}

function handshakeTimeoutMs(
  expectedType: PendingHandshake["expectedType"],
): number {
  if (process.env.NODE_ENV === "test") {
    const text = process.env[TEST_HANDSHAKE_NAME];
    const value = text && /^[1-9][0-9]*$/u.test(text)
      ? Number(text)
      : Number.NaN;
    if (
      Number.isSafeInteger(value)
      && value >= 50
      && value <= WATCHDOG_READY_TIMEOUT_MS
    ) {
      return value;
    }
  }
  return expectedType === "READY"
    ? WATCHDOG_READY_TIMEOUT_MS
    : expectedType === "ARMED"
      ? MAIL_DISPATCH_WATCHDOG_ARM_ACK_TIMEOUT_MS
      : MAIL_DISPATCH_WATCHDOG_DISARM_DELIVERY_TIMEOUT_MS;
}

function exactMessage(
  message: unknown,
  type: PendingHandshake["expectedType"],
  generation?: number,
) {
  if (
    !message
    || typeof message !== "object"
    || Array.isArray(message)
    || Object.getPrototypeOf(message) !== Object.prototype
  ) return false;
  const record = message as Record<string, unknown>;
  const expectedKeys = generation === undefined
    ? ["type"]
    : ["generation", "type"];
  const actualKeys = Object.keys(record).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && record.type === type
    && (
      generation === undefined
        ? !Object.hasOwn(record, "generation")
        : record.generation === generation
    );
}

function clearPending(state: ControllerState, error?: Error) {
  const pending = state.pending;
  if (!pending) return;
  state.pending = undefined;
  clearTimeout(pending.timeout);
  if (error) pending.reject(error);
  else pending.resolve();
}

function destroyChildBestEffort(state: ControllerState) {
  try {
    if (state.child.exitCode === null && state.child.signalCode === null) {
      state.child.kill("SIGKILL");
    }
  } catch {
    // Startup or a direct post-ready fatal hook already made progress.
  }
}

function failController(
  state: ControllerState,
  error: MailDispatchHardWatchdogError,
) {
  if (state.phase === "closed" || state.phase === "failed") return;
  const providerCouldRun = state.phase !== "starting";
  state.phase = "failed";
  if (state.capability) {
    ARMED_CAPABILITIES.delete(state.capability);
    state.capability = undefined;
  }

  if (providerCouldRun && !state.expectedClose) {
    try {
      state.fatalExit(error);
    } catch (fatalSignal) {
      clearPending(state, error);
      destroyChildBestEffort(state);
      throw fatalSignal;
    }
  }

  // Production fatalExit never returns. These operations are startup cleanup
  // or a defensive/test fallback after the direct fatal hook was invoked.
  clearPending(state, error);
  destroyChildBestEffort(state);
}

function handshake(
  state: ControllerState,
  expectedType: PendingHandshake["expectedType"],
  generation?: number,
) {
  if (state.pending) {
    throw watchdogError("WATCHDOG_PROTOCOL_INVALID");
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = watchdogError("WATCHDOG_HANDSHAKE_TIMEOUT");
      failController(state, error);
      reject(error);
    }, handshakeTimeoutMs(expectedType));
    state.pending = {
      expectedType,
      ...(generation === undefined ? {} : { generation }),
      resolve,
      reject,
      timeout,
    };
  });
}

type ControllerMessage =
  | Readonly<{ type: "ARM" | "DISARM"; generation: number }>
  | Readonly<{ type: "CLOSE" }>;

function send(
  state: ControllerState,
  message: ControllerMessage,
) {
  const sendNow = () => {
    if (!state.child.connected) {
      failController(state, watchdogError("WATCHDOG_CHILD_FAILED"));
      return;
    }
    if (
      activeTestFault() === "SEND_CALLBACK_ERROR"
      && message.type === "ARM"
    ) {
      queueMicrotask(() => {
        failController(state, watchdogError("WATCHDOG_CHILD_FAILED"));
      });
      return;
    }
    state.child.send(message, (error) => {
      if (error) {
        failController(state, watchdogError("WATCHDOG_CHILD_FAILED"));
      }
    });
  };

  if (
    activeTestFault() === "DELAY_BOUNDARY_IPC"
    && message.type === "DISARM"
  ) {
    setTimeout(sendNow, 50);
    return;
  }
  sendNow();
}

function installChildHandlers(state: ControllerState) {
  state.child.on("message", (message) => {
    const pending = state.pending;
    if (
      !pending
      || !exactMessage(
        message,
        pending.expectedType,
        pending.generation,
      )
    ) {
      failController(state, watchdogError("WATCHDOG_PROTOCOL_INVALID"));
      return;
    }
    clearPending(state);
  });
  state.child.once("error", () => {
    failController(state, watchdogError("WATCHDOG_CHILD_FAILED"));
  });
  state.child.once("exit", () => {
    if (!state.expectedClose) {
      failController(state, watchdogError("WATCHDOG_CHILD_FAILED"));
    }
  });
  state.child.once("disconnect", () => {
    if (!state.expectedClose) {
      failController(state, watchdogError("WATCHDOG_CHILD_FAILED"));
    }
  });
}

async function waitForChildExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        resolve();
      }
    }, WATCHDOG_READY_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function startMailDispatchHardWatchdog(
  input: Readonly<{ fatalExit: FatalExit }>,
): Promise<MailDispatchHardWatchdog> {
  if (!input || typeof input.fatalExit !== "function") {
    throw watchdogError("WATCHDOG_START_FAILED");
  }
  if (!WATCHDOG_CHILD_PATH) {
    throw watchdogError("WATCHDOG_START_FAILED");
  }

  let child: ChildProcess;
  try {
    const options: ForkOptions & Readonly<{ windowsHide: true }> = {
      env: childEnvironment(),
      execArgv: [],
      execPath: process.execPath,
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    };
    child = fork(
      WATCHDOG_CHILD_PATH,
      [],
      options,
    );
  } catch {
    throw watchdogError("WATCHDOG_START_FAILED");
  }
  const state: ControllerState = {
    child,
    fatalExit: input.fatalExit,
    phase: "starting",
    generation: 0,
    expectedClose: false,
  };
  installChildHandlers(state);

  const controller = Object.freeze({
    async arm(): Promise<ArmedMailDispatchHardWatchdog> {
      const current = CONTROLLERS.get(controller);
      if (!current || current.phase !== "idle") {
        throw watchdogError("WATCHDOG_NOT_IDLE");
      }
      if (current.generation >= Number.MAX_SAFE_INTEGER) {
        const error = watchdogError("WATCHDOG_PROTOCOL_INVALID");
        failController(current, error);
        throw error;
      }
      current.phase = "arming";
      current.generation += 1;
      const generation = current.generation;
      const acknowledged = handshake(current, "ARMED", generation);
      send(current, { type: "ARM", generation });
      await acknowledged;
      if (current.phase !== "arming") {
        throw watchdogError("WATCHDOG_CHILD_FAILED");
      }
      const capability = Object.freeze({}) as ArmedMailDispatchHardWatchdog;
      current.capability = capability;
      current.phase = "armed";
      ARMED_CAPABILITIES.set(capability, Object.freeze({
        capability,
        controller,
        generation,
        state: current,
      }));
      return capability;
    },
    async close(): Promise<void> {
      const current = CONTROLLERS.get(controller);
      if (!current || current.phase === "closed") return;
      if (current.phase !== "idle" && current.phase !== "failed") {
        throw watchdogError("WATCHDOG_NOT_IDLE");
      }
      if (current.phase === "failed") {
        current.expectedClose = true;
        current.phase = "closed";
        clearPending(current, watchdogError("WATCHDOG_CHILD_FAILED"));
        destroyChildBestEffort(current);
        await waitForChildExit(current.child);
        CONTROLLERS.delete(controller);
        return;
      }

      current.phase = "closing";
      const acknowledged = handshake(current, "CLOSED");
      send(current, { type: "CLOSE" });
      await acknowledged;
      if (current.phase !== "closing") {
        throw watchdogError("WATCHDOG_CHILD_FAILED");
      }
      current.expectedClose = true;
      current.phase = "closed";
      try {
        if (current.child.connected) current.child.disconnect();
      } catch {
        destroyChildBestEffort(current);
      }
      await waitForChildExit(current.child);
      CONTROLLERS.delete(controller);
    },
  }) satisfies MailDispatchHardWatchdog;
  CONTROLLERS.set(controller, state);

  try {
    const ready = handshake(state, "READY");
    await ready;
    if (state.phase !== "starting") {
      throw watchdogError("WATCHDOG_START_FAILED");
    }
    state.phase = "idle";
    return controller;
  } catch {
    state.expectedClose = true;
    state.phase = "failed";
    clearPending(state, watchdogError("WATCHDOG_START_FAILED"));
    destroyChildBestEffort(state);
    CONTROLLERS.delete(controller);
    throw watchdogError("WATCHDOG_START_FAILED");
  }
}

export function isMailDispatchHardWatchdogArmed(
  capability: ArmedMailDispatchHardWatchdog,
): boolean {
  if (!capability || typeof capability !== "object") return false;
  const armed = ARMED_CAPABILITIES.get(capability);
  return Boolean(
    armed
    && Object.isFrozen(capability)
    && armed.capability === capability
    && armed.state.capability === capability
    && armed.state.phase === "armed"
    && armed.state.generation === armed.generation
    && armed.state.child.connected
    && armed.state.child.exitCode === null
    && armed.state.child.signalCode === null,
  );
}

export async function disarmMailDispatchHardWatchdog(
  capability: ArmedMailDispatchHardWatchdog,
): Promise<void> {
  const armed = capability && typeof capability === "object"
    ? ARMED_CAPABILITIES.get(capability)
    : undefined;
  if (
    !armed
    || !isMailDispatchHardWatchdogArmed(capability)
    || armed.state.phase !== "armed"
  ) {
    throw watchdogError("WATCHDOG_NOT_ARMED");
  }
  const { state, generation } = armed;
  state.phase = "disarming";
  const acknowledged = handshake(state, "DISARMED", generation);
  send(state, { type: "DISARM", generation });
  await acknowledged;
  if (state.phase !== "disarming") {
    throw watchdogError("WATCHDOG_CHILD_FAILED");
  }
  ARMED_CAPABILITIES.delete(capability);
  state.capability = undefined;
  state.phase = "idle";
}
