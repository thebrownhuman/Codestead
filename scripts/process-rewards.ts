import { hostname } from "node:os";

import { pool } from "../src/lib/db/client";
import { processRewardReconciliationBatch } from "../src/lib/rewards/worker";
import { createWorkerHealthReporter } from "./lib/worker-health";

let healthReporter: ReturnType<typeof createWorkerHealthReporter> | undefined;

async function main() {
  const pollSeconds = Number.parseInt(process.env.REWARD_POLL_SECONDS ?? "5", 10);
  const batchSize = Number.parseInt(process.env.REWARD_BATCH_SIZE ?? "20", 10);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 2 || pollSeconds > 3_600) {
    throw new Error("REWARD_POLL_SECONDS must be an integer from 2 to 3600.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("REWARD_BATCH_SIZE must be an integer from 1 to 100.");
  }
  const worker = `reward-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 60)}`;
  const once = process.argv.includes("--once");
  healthReporter = createWorkerHealthReporter({ worker: "reward-worker" });
  do {
    const report = await processRewardReconciliationBatch({ limit: batchSize });
    console.info(JSON.stringify({ event: "reward_reconciliation.batch", worker, ...report }));
    healthReporter.success();
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, report.processed ? 500 : pollSeconds * 1_000));
  } while (true);
}

main()
  .catch((error) => {
    healthReporter?.retry(error);
    healthReporter?.terminalFailure(error);
    console.error(JSON.stringify({
      event: "reward_reconciliation.worker_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
