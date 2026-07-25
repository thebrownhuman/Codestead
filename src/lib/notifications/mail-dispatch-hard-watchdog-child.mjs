import { constants as osConstants } from "node:os";
import process from "node:process";

const PRODUCTION_TIMEOUT_MS = 55_000;
const TEST_TIMEOUT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_TIMEOUT_MS";
const TEST_FAULT_NAME = "MAIL_DISPATCH_WATCHDOG_TEST_FAULT";
const TEST_FAULTS = new Set([
  "DELAY_BOUNDARY_IPC",
  "DISCONNECT_AFTER_ARMED",
  "DISCONNECT_AFTER_READY",
  "DISCONNECT_ON_ARM",
  "DISCONNECT_ON_DISARM",
  "DROP_ARM_ACK",
  "DROP_DISARM_ACK",
  "EXIT_AFTER_ARMED",
  "EXIT_AFTER_ARMED_WITH_MUTATED_KILL",
  "EXIT_BEFORE_READY",
  "MALFORMED_ARMED",
  "MALFORMED_DISARMED",
  "MALFORMED_READY",
  "SEND_CALLBACK_ERROR",
  "SEND_SYNC_THROW",
  "UNCAUGHT_AFTER_ARMED",
  "UNHANDLED_REJECTION_AFTER_ARMED",
]);
const NONLETHAL_IN_PROCESS_TEST_DISCONNECTS = new Set([
  "DISCONNECT_AFTER_READY",
  "DISCONNECT_ON_ARM",
  "DISCONNECT_ON_DISARM",
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

const capturedReallyExit = typeof process.reallyExit === "function"
  ? process.reallyExit.bind(process)
  : undefined;
const capturedRawKill = typeof process._kill === "function"
  ? process._kill.bind(process)
  : undefined;
const capturedAtomicsWait = typeof Atomics.wait === "function"
  ? Atomics.wait.bind(Atomics)
  : undefined;
const capturedSelfPid = process.pid;
const capturedSigkill = osConstants.signals.SIGKILL;
let parkWord;
try {
  parkWord = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
} catch {
  // The final tight loop below remains allocation-free and non-returning.
}

function parkUntilKilled() {
  if (capturedAtomicsWait && parkWord) {
    for (;;) {
      try {
        capturedAtomicsWait(parkWord, 0, 0);
      } catch {
        break;
      }
    }
  }
  for (;;) {
    // Never re-enter the event loop or run cleanup after a fatal boundary.
  }
}

function startupFail(code) {
  if (capturedReallyExit) {
    try {
      capturedReallyExit(code);
    } catch {
      // Fall through to the captured raw whole-process kill.
    }
  }
  if (capturedRawKill) {
    try {
      capturedRawKill(capturedSelfPid, capturedSigkill);
    } catch {
      // Fall through to the preallocated park.
    }
  }
  parkUntilKilled();
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
  if (Object.hasOwn(process.env, name)) startupFail(64);
}
if (
  typeof process.send !== "function"
  || !process.connected
  || process.argv.length !== 2
  || !Number.isSafeInteger(process.ppid)
  || process.ppid <= 1
) {
  startupFail(65);
}

const parentPid = process.ppid;
const timeoutMs = watchdogTimeoutMs();
const testFault = activeTestFault();
let generation = 0;
let phase = "idle";
let readySent = false;
let killTimer;

function capturedParentMatches() {
  return process.ppid === parentPid && parentPid > 1;
}

function parentIdentityIsLive() {
  return process.connected && capturedParentMatches();
}

function clearWatchdogTimers() {
  if (killTimer !== undefined) clearTimeout(killTimer);
  killTimer = undefined;
}

function killCapturedParentForFailure(code) {
  if (phase === "fatal") return;
  const failedPhase = phase;
  phase = "fatal";
  clearWatchdogTimers();
  if (
    !readySent
    || !capturedParentMatches()
    || (
      (failedPhase === "armed" || failedPhase === "firing")
      && !validGeneration(generation)
    )
  ) {
    startupFail(code);
  }

  if (!capturedParentMatches()) {
    clearWatchdogTimers();
    startupFail(0);
  }
  try {
    if (!capturedRawKill || capturedRawKill(parentPid, capturedSigkill) !== 0) {
      clearWatchdogTimers();
      startupFail(70);
    }
  } catch {
    clearWatchdogTimers();
    startupFail(70);
  }
  // One successful numeric kill is authoritative, especially on Windows:
  // retrying could target an unrelated process after PID reuse.
  clearWatchdogTimers();
  startupFail(code);
}

function fail(code) {
  if (!readySent || phase === "closing" || phase === "closed") {
    startupFail(code);
  }
  killCapturedParentForFailure(code);
}

function killParentOnTimeout() {
  if (phase !== "armed") return;
  if (!parentIdentityIsLive()) {
    clearWatchdogTimers();
    startupFail(0);
  }
  phase = "firing";
  killCapturedParentForFailure(71);
}

function send(message, afterSend) {
  process.send(message, (error) => {
    if (error) {
      fail(66);
      return;
    }
    afterSend?.();
  });
}

function disconnect() {
  if (process.connected) process.disconnect();
}

// A direct external SIGKILL of this sole watchdog is outside the single-child
// fault model; covering it requires an independent redundant supervisor.
process.on("exit", () => {
  if (
    !readySent
    || phase === "closing"
    || phase === "closed"
    || phase === "fatal"
    || !capturedParentMatches()
    || (
      (phase === "armed" || phase === "firing")
      && !validGeneration(generation)
    )
  ) {
    return;
  }
  try {
    // The exit event is synchronous: no timer, promise, logging, or cleanup
    // may run before this last-resort signal is sent.
    if (capturedRawKill) {
      capturedRawKill(parentPid, capturedSigkill);
    }
  } catch {
    // There is no safe asynchronous fallback once ordinary exit has begun.
  }
});
process.on("uncaughtException", () => fail(72));
process.on("unhandledRejection", () => fail(73));
process.on("SIGHUP", () => fail(75));
process.on("SIGINT", () => fail(76));
process.on("SIGTERM", () => fail(77));
process.on("disconnect", () => {
  if (phase === "closing" || phase === "closed" || phase === "fatal") {
    clearWatchdogTimers();
    startupFail(0);
  }
  if (
    process.env.NODE_ENV === "test"
    && testFault
    && NONLETHAL_IN_PROCESS_TEST_DISCONNECTS.has(testFault)
  ) {
    phase = "closed";
    clearWatchdogTimers();
    startupFail(0);
  }
  killCapturedParentForFailure(74);
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
    readySent = true;
    generation = message.generation;
    phase = "armed";
    if (testFault === "MALFORMED_ARMED") {
      send({ type: "ARMED", generation, unexpected: true });
      return;
    }
    if (testFault === "DROP_ARM_ACK") return;
    killTimer = setTimeout(killParentOnTimeout, timeoutMs);
    if (testFault === "DISCONNECT_ON_ARM") {
      disconnect();
      return;
    }
    if (testFault === "DELAY_BOUNDARY_IPC") {
      setTimeout(() => send({ type: "ARMED", generation }), 50);
      return;
    }
    if (
      testFault === "EXIT_AFTER_ARMED"
      || testFault === "EXIT_AFTER_ARMED_WITH_MUTATED_KILL"
    ) {
      send(
        { type: "ARMED", generation },
        () => {
          if (testFault === "EXIT_AFTER_ARMED_WITH_MUTATED_KILL") {
            process.kill = () => false;
            process._kill = () => 1;
          }
          setTimeout(() => {
            process.exitCode = 0;
            process.exit(81);
          }, 25);
        },
      );
      return;
    }
    if (testFault === "DISCONNECT_AFTER_ARMED") {
      send(
        { type: "ARMED", generation },
        () => setTimeout(disconnect, 25),
      );
      return;
    }
    if (
      testFault === "UNCAUGHT_AFTER_ARMED"
      || testFault === "UNHANDLED_REJECTION_AFTER_ARMED"
    ) {
      send(
        { type: "ARMED", generation },
        () => setTimeout(
          testFault === "UNCAUGHT_AFTER_ARMED"
            ? () => {
              throw new Error("Injected watchdog child exception.");
            }
            : () => {
              void Promise.reject(
                new Error("Injected watchdog child rejection."),
              );
            },
          25,
        ),
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
  if (message?.type === "CLOSE") {
    if (
      phase !== "idle"
      || !exactMessage(message, ["type"])
    ) {
      fail(69);
    }
    phase = "closing";
    clearWatchdogTimers();
    send({ type: "CLOSED" }, () => {
      phase = "closed";
      // Disconnect only after Node confirms the CLOSED frame was delivered.
      disconnect();
    });
    return;
  }
  fail(69);
});

if (testFault === "EXIT_BEFORE_READY") {
  startupFail(80);
} else if (testFault === "MALFORMED_READY") {
  send({ type: "READY", unexpected: true });
} else if (testFault === "DISCONNECT_AFTER_READY") {
  send({ type: "READY" }, () => {
    readySent = true;
    setTimeout(disconnect, 25);
  });
} else {
  send({ type: "READY" }, () => {
    readySent = true;
  });
}
