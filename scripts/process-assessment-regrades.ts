import { hostname } from "node:os";

import { processAssessmentMasteryProjectionRepairBatch } from "../src/lib/assessment-corrections/mastery-repair";
import { processAssessmentRegradeBatch } from "../src/lib/assessment-corrections/worker";
import { pool } from "../src/lib/db/client";

async function main() {
  const pollSeconds = Number.parseInt(process.env.REGRADE_POLL_SECONDS ?? "10", 10);
  const batchSize = Number.parseInt(process.env.REGRADE_BATCH_SIZE ?? "2", 10);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 2 || pollSeconds > 3_600) {
    throw new Error("REGRADE_POLL_SECONDS must be an integer from 2 to 3600.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2) {
    throw new Error("REGRADE_BATCH_SIZE must be 1 or 2 for the initial runner boundary.");
  }
  const workerId = `regrade-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 60)}`;
  const once = process.argv.includes("--once");
  do {
    const report = await processAssessmentRegradeBatch({ workerId, limit: batchSize });
    const masteryRepairs = await processAssessmentMasteryProjectionRepairBatch({ limit: 20 });
    console.info(JSON.stringify({
      event: "assessment_regrade.batch",
      processed: report.processed,
      succeeded: report.succeeded,
      failed: report.failed,
      masteryRepairs: {
        processed: masteryRepairs.processed,
        applied: masteryRepairs.applied,
        unresolved: masteryRepairs.unresolved,
      },
    }));
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, report.processed ? 500 : pollSeconds * 1_000));
  } while (true);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "assessment_regrade.worker_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
