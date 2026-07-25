import { writeSync } from "node:fs";
import { constants as osConstants } from "node:os";
import process from "node:process";

const originalRawKill = typeof process._kill === "function"
  ? process._kill.bind(process)
  : undefined;

if (!originalRawKill) {
  process.reallyExit(64);
}

process._kill = (pid, signal) => {
  if (pid === process.ppid && signal !== 0) {
    writeSync(
      1,
      signal === osConstants.signals.SIGKILL
        ? "PARENT_RAW_SIGKILL\n"
        : "WRONG_PARENT_SIGNAL\n",
    );
    return 0;
  }
  return originalRawKill(pid, signal);
};
