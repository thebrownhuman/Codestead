import { pool } from "../src/lib/db/client";
import { runRunnerPowerRehearsalCli } from "./lib/runner-power-rehearsal-cli";

runRunnerPowerRehearsalCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    console.error(JSON.stringify({ event: "runner_power_rehearsal_control.failed", code: "INTERNAL_ERROR" }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
