import process from "node:process";

import { pool } from "../src/lib/db/client";
import { evaluateCurriculumPublicationGate } from "../src/lib/curriculum-publication/gate";

async function main() {
  const courseVersionId = process.argv[2];
  const targetStage = process.argv[3];
  if (!courseVersionId || (targetStage !== "beta" && targetStage !== "verified")) {
    throw new Error("Usage: npm run curriculum:gate -- <course-version-uuid> <beta|verified>");
  }
  const report = await evaluateCurriculumPublicationGate({ courseVersionId, targetStage });
  console.info(JSON.stringify(report, null, 2));
  if (!report.allowed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
