import process from "node:process";

import { pool } from "../src/lib/db/client";
import {
  buildFilesystemCurriculumCandidates,
  stageFilesystemCurriculum,
} from "../src/lib/curriculum-publication/staging";

async function main() {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    const candidates = await buildFilesystemCurriculumCandidates();
    const artifacts = candidates.reduce((total, candidate) => total + candidate.artifacts.length, 0);
    const aiAssistedArtifacts = candidates.reduce(
      (total, candidate) => total + candidate.artifacts.filter((artifact) => artifact.aiAssisted).length,
      0,
    );
    console.info(JSON.stringify({
      event: "curriculum.stage.preview",
      courses: candidates.length,
      artifacts,
      aiAssistedArtifacts,
      publicationStage: "draft",
      mutated: false,
    }));
    return;
  }
  const report = await stageFilesystemCurriculum();
  console.info(JSON.stringify({ event: "curriculum.stage.applied", ...report, publicationStage: "draft" }));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ event: "curriculum.stage.failed", code: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
