import { writeSync } from "node:fs";

// Make the parent's fatal path park after its shorter ACK bound. The process
// can then terminate only if the child armed its independent kill timer before
// deliberately dropping the ARMED acknowledgement.
process.reallyExit = () => undefined;
process._kill = () => 0;

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

const {
  startMailDispatchHardWatchdog,
} = await import("../../mail-dispatch-hard-watchdog.ts");

const watchdog = await startMailDispatchHardWatchdog();
await watchdog.arm();
writeSync(1, "RESUMED\n");
