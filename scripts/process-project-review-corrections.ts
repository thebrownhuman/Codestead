import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { pool } from "../src/lib/db/client";
import { processProjectReviewCorrectionBatch } from "../src/lib/projects/review-correction-service";
import { createWorkerHealthReporter } from "./lib/worker-health";

let healthReporter: ReturnType<typeof createWorkerHealthReporter> | undefined;

function boundedInteger(name: string, fallback: string, minimum: number, maximum: number) {
  const value = Number.parseInt(process.env[name] ?? fallback, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

async function main() {
  const pollSeconds = boundedInteger("PROJECT_REVIEW_CORRECTION_POLL_SECONDS", "10", 2, 3_600);
  const batchSize = boundedInteger("PROJECT_REVIEW_CORRECTION_BATCH_SIZE", "2", 1, 10);
  const workerId = [
    "project-review",
    hostname().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 48),
    process.pid,
    randomUUID().slice(0, 8),
  ].join("-");
  const once = process.argv.includes("--once");
  healthReporter = createWorkerHealthReporter({ worker: "project-review-correction-worker" });
  do {
    const report = await processProjectReviewCorrectionBatch({ workerId, limit: batchSize });
    console.info(JSON.stringify({ event: "project_review_correction.batch", ...report }));
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
      event: "project_review_correction.worker_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
