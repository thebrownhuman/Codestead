import { writeSync } from "node:fs";

import {
  startMailDispatchHardWatchdog,
} from "../../mail-dispatch-hard-watchdog.ts";

process.exitCode = 0;
process.on("beforeExit", () => {
  writeSync(1, "BEFORE_EXIT_CLEANUP\n");
});
process.on("exit", () => {
  writeSync(1, "EXIT_CLEANUP\n");
});
process.on("uncaughtException", () => {
  writeSync(1, "UNCAUGHT_CLEANUP\n");
});
process.on("unhandledRejection", () => {
  writeSync(1, "UNHANDLED_CLEANUP\n");
});

const watchdog = await startMailDispatchHardWatchdog();
await watchdog.arm();
writeSync(1, "RESUMED\n");
