import process from "node:process";

const PRODUCTION_TIMEOUT_MS = 55_000;
const TEST_TIMEOUT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS";
const TEST_FAULT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_FAULT";
const TEST_FAULTS = new Set([
  "DELAY_BOUNDARY_IPC",
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
]);
const FORBIDDEN_ENVIRONMENT = Object.freeze([
  "DATABASE_URL",
  "DATABASE_URL_FILE",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_ID_FILE",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_CLIENT_SECRET_FILE",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_REFRESH_TOKEN_FILE",
  "DELETION_TOMBSTONE_KEY",
  "DELETION_TOMBSTONE_KEY_FILE",
  "LOST_DEVICE_PROOF_KEY",
  "LOST_DEVICE_PROOF_KEY_FILE",
]);

function fail(code) {
  process.exit(code);
}

function watchdogTimeoutMs() {
  if (process.env.NODE_ENV !== "test") return PRODUCTION_TIMEOUT_MS;
  const text = process.env[TEST_TIMEOUT_NAME];
  if (!text || !/^[1-9][0-9]*$/u.test(text)) return PRODUCTION_TIMEOUT_MS;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 50 && value <= 5_000
    ? value
    : PRODUCTION_TIMEOUT_MS;
}

function activeTestFault() {
  if (process.env.NODE_ENV !== "test") return undefined;
  const fault = process.env[TEST_FAULT_NAME];
  return fault && TEST_FAULTS.has(fault) ? fault : undefined;
}

function exactMessage(message, keys) {
  if (
    !message
    || typeof message !== "object"
    || Array.isArray(message)
    || Object.getPrototypeOf(message) !== Object.prototype
  ) return false;
  const actual = Object.keys(message).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validGeneration(value) {
  return Number.isSafeInteger(value) && value > 0;
}

for (const name of FORBIDDEN_ENVIRONMENT) {
  if (Object.hasOwn(process.env, name)) fail(64);
}
if (
  typeof process.send !== "function"
  || !process.connected
  || process.argv.length !== 2
  || !Number.isSafeInteger(process.ppid)
  || process.ppid <= 1
) {
  fail(65);
}

const parentPid = process.ppid;
const timeoutMs = watchdogTimeoutMs();
const testFault = activeTestFault();
let generation = 0;
let phase = "idle";
let killTimer;
let killRetry;

function parentIdentityIsLive() {
  return process.connected && process.ppid === parentPid;
}

function clearWatchdogTimers() {
  if (killTimer !== undefined) clearTimeout(killTimer);
  if (killRetry !== undefined) clearInterval(killRetry);
  killTimer = undefined;
  killRetry = undefined;
}

function killParent() {
  if (phase !== "armed") return;
  phase = "firing";
  if (!parentIdentityIsLive()) {
    clearWatchdogTimers();
    fail(0);
  }
  const terminate = () => {
    if (!parentIdentityIsLive()) {
      clearWatchdogTimers();
      fail(0);
    }
    try {
      process.kill(parentPid, "SIGKILL");
    } catch {
      clearWatchdogTimers();
      fail(70);
    }
  };
  terminate();
  killRetry = setInterval(terminate, 25);
}

function send(message, afterSend) {
  process.send(message, (error) => {
    if (error) fail(66);
    afterSend?.();
  });
}

function disconnect() {
  if (process.connected) process.disconnect();
}

process.on("disconnect", () => {
  clearWatchdogTimers();
  fail(0);
});
process.on("message", (message) => {
  if (message?.type === "ARM") {
    if (
      phase !== "idle"
      || !exactMessage(message, ["type", "generation"])
      || !validGeneration(message.generation)
      || message.generation <= generation
    ) {
      fail(67);
    }
    generation = message.generation;
    phase = "armed";
    killTimer = setTimeout(killParent, timeoutMs);

    if (testFault === "MALFORMED_ARMED") {
      send({ type: "ARMED", generation, unexpected: true });
      return;
    }
    if (testFault === "DROP_ARM_ACK") return;
    if (testFault === "DISCONNECT_ON_ARM") {
      disconnect();
      return;
    }
    if (testFault === "DELAY_BOUNDARY_IPC") {
      setTimeout(() => send({ type: "ARMED", generation }), 50);
      return;
    }
    if (testFault === "EXIT_AFTER_ARMED") {
      send(
        { type: "ARMED", generation },
        () => setTimeout(() => fail(81), 25),
      );
      return;
    }
    send({ type: "ARMED", generation });
    return;
  }
  if (message?.type === "DISARM") {
    if (
      phase !== "armed"
      || !exactMessage(message, ["type", "generation"])
      || message.generation !== generation
    ) {
      fail(68);
    }
    phase = "idle";
    clearWatchdogTimers();

    if (testFault === "MALFORMED_DISARMED") {
      send({ type: "DISARMED", generation, unexpected: true });
      return;
    }
    if (testFault === "DROP_DISARM_ACK") return;
    if (testFault === "DISCONNECT_ON_DISARM") {
      disconnect();
      return;
    }
    send({ type: "DISARMED", generation });
    return;
  }
  fail(69);
});

if (testFault === "EXIT_BEFORE_READY") {
  fail(80);
} else if (testFault === "MALFORMED_READY") {
  send({ type: "READY", unexpected: true });
} else if (testFault === "DISCONNECT_AFTER_READY") {
  send({ type: "READY" }, () => setTimeout(disconnect, 25));
} else {
  send({ type: "READY" });
}
