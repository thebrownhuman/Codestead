import { hostname } from "node:os";

import { processExamFinalizationBatch } from "../src/app/api/exams/_lib/finalization-worker";
import { pool } from "../src/lib/db/client";
import { createWorkerHealthReporter } from "./lib/worker-health";

let healthReporter: ReturnType<typeof createWorkerHealthReporter> | undefined;

async function main() {
  const pollSeconds = Number.parseInt(process.env.EXAM_FINALIZATION_POLL_SECONDS ?? "5", 10);
  const batchSize = Number.parseInt(process.env.EXAM_FINALIZATION_BATCH_SIZE ?? "2", 10);
  if (!Number.isInteger(pollSeconds) || pollSeconds < 2 || pollSeconds > 3_600) {
    throw new Error("EXAM_FINALIZATION_POLL_SECONDS must be an integer from 2 to 3600.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) {
    throw new Error("EXAM_FINALIZATION_BATCH_SIZE must be an integer from 1 to 10.");
  }
  const workerId = `exam-finalizer-${hostname().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 60)}`;
  const once = process.argv.includes("--once");
  healthReporter = createWorkerHealthReporter({ worker: "exam-finalization-worker" });
  do {
    const report = await processExamFinalizationBatch({ workerId, limit: batchSize });
    console.info(JSON.stringify({ event: "exam_finalization.batch", ...report }));
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
      event: "exam_finalization.worker_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
