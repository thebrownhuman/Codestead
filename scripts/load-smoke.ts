import { runProductionLoadCliFromProcess } from "./lib/production-load-cli";

void runProductionLoadCliFromProcess()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    process.stdout.write(`${JSON.stringify({ verdict: "NOT_RUN" })}\n`);
    process.exitCode = 1;
  });
