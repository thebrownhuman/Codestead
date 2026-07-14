import { hostname } from "node:os";

import { pool } from "../src/lib/db/client";
import { processPracticeRunnerRecoveryBatch } from "../src/lib/runner/practice-recovery";

async function main() {
  const pollSeconds = Number.parseInt(process.env.PRACTICE_RECOVERY_POLL_SECONDS ?? "5", 10);
  const batchSize = Number.parseInt(process.env.PRACTICE_RECOVERY_BATCH_SIZE ?? "2", 10);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 2 || pollSeconds > 3_600) {
    throw new Error("PRACTICE_RECOVERY_POLL_SECONDS must be an integer from 2 to 3600.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) {
    throw new Error("PRACTICE_RECOVERY_BATCH_SIZE must be an integer from 1 to 10.");
  }
  const worker = `practice-recovery-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 60)}`;
  const once = process.argv.includes("--once");
  do {
    const report = await processPracticeRunnerRecoveryBatch({ limit: batchSize });
    console.info(JSON.stringify({ event: "practice_runner_recovery.batch", worker, ...report }));
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, report.processed ? 500 : pollSeconds * 1_000));
  } while (true);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "practice_runner_recovery.worker_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
