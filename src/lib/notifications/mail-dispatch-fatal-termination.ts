import { constants as osConstants } from "node:os";
import { isMainThread } from "node:worker_threads";

const MAIL_DISPATCH_FAILURE_EXIT_CODE = 1;

type NativeProcess = NodeJS.Process & {
  reallyExit?: (code: number) => void;
  _kill?: (pid: number, signal: number) => number;
};
type NativeAtomicsWait = (
  typedArray: Int32Array,
  index: number,
  value: number,
) => "not-equal" | "ok" | "timed-out";

const nativeProcess = process as NativeProcess;
const capturedReallyExit = typeof nativeProcess.reallyExit === "function"
  ? nativeProcess.reallyExit.bind(nativeProcess)
  : undefined;
const capturedRawKill = typeof nativeProcess._kill === "function"
  ? nativeProcess._kill.bind(nativeProcess)
  : undefined;
const capturedAtomicsWait = typeof Atomics.wait === "function"
  ? Atomics.wait.bind(Atomics) as NativeAtomicsWait
  : undefined;
const capturedProcessPid = process.pid;
const capturedSigkill = osConstants.signals.SIGKILL;
const capturedIsMainThread = isMainThread;

let mailDispatchParkWord: Int32Array | undefined;
try {
  mailDispatchParkWord = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
} catch {
  // A tight loop remains the allocation-free non-returning fallback.
}

export function parkMailDispatchUntilKilled(): never {
  const waitWord = mailDispatchParkWord;
  if (capturedAtomicsWait && waitWord) {
    for (;;) {
      try {
        capturedAtomicsWait(waitWord, 0, 0);
      } catch {
        break;
      }
    }
  }

  for (;;) {
    // No allocation, event-loop turn, cleanup hook, or mutable global lookup.
  }
}

export function terminateMailDispatchImmediately(): never {
  if (capturedIsMainThread && capturedReallyExit) {
    try {
      capturedReallyExit(MAIL_DISPATCH_FAILURE_EXIT_CODE);
    } catch {
      // Fall through to the captured whole-process kill.
    }
  }

  if (capturedRawKill) {
    try {
      capturedRawKill(capturedProcessPid, capturedSigkill);
    } catch {
      // Fall through to the preallocated non-returning park.
    }
  }

  return parkMailDispatchUntilKilled();
}
