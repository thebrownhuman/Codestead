import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ContentRepository, type CodeAssessmentItem } from "../src/lib/content";
import { AI_CODE_TASKS } from "./content-seeds/ai-code-tasks";
import {
  executePinnedCurriculumReference,
  normalizeProgramOutput,
  PINNED_CURRICULUM_RUNTIMES,
  pinnedDockerAvailable,
  pinnedImageId,
} from "./pinned-curriculum-runtime";

const root = process.cwd();

function sourceHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function main(): Promise<void> {
  const authored = await new ContentRepository({ contentRoot: path.join(root, "content") })
    .getAuthoredContentSet();
  const codeItems = authored.assessmentBanks
    .filter((bank) => bank.courseId === "ai")
    .flatMap((bank) => bank.items)
    .filter((item): item is CodeAssessmentItem => item.kind === "code");
  const tasks = Object.entries(AI_CODE_TASKS).sort(([left], [right]) => left.localeCompare(right));
  const matched: Array<{ skillId: string; item: CodeAssessmentItem }> = [];
  const issues: string[] = [];
  for (const [skillId, task] of tasks) {
    const candidates = codeItems.filter((item) => item.skillId === skillId);
    if (candidates.length !== 1) {
      issues.push(`${skillId}: expected exactly one AI code item, received ${candidates.length}`);
      continue;
    }
    const item = candidates[0]!;
    if (item.runtime.engine !== "isolated-runner" || item.runtime.language !== "python") {
      issues.push(`${skillId}: runtime is not the pinned isolated Python runner`);
      continue;
    }
    const runtime = PINNED_CURRICULUM_RUNTIMES.python;
    if (item.runtime.version !== runtime.version) issues.push(`${skillId}: runtime version mismatch`);
    if (item.runtime.entrypoint !== runtime.entrypoint) issues.push(`${skillId}: entrypoint mismatch`);
    if (item.runtime.imageDigest !== runtime.imageDigest) issues.push(`${skillId}: image digest mismatch`);
    if (item.answer.referenceSolution !== task.referenceSolution) issues.push(`${skillId}: reference solution drift`);
    if (item.tests.length !== task.tests.length || !item.tests.every((test, index) => {
      const expected = task.tests[index];
      return expected !== undefined &&
        test.stdin === expected.stdin &&
        test.expectedStdout === expected.expectedStdout &&
        test.category === expected.category &&
        test.comparison === "trimmed" &&
        test.visibility === (index === 0 ? "visible" : "hidden");
    })) issues.push(`${skillId}: visible/hidden test contract drift`);
    if (item.examEligibility.eligible) issues.push(`${skillId}: unreviewed item is exam eligible`);
    matched.push({ skillId, item });
  }
  if (issues.length) throw new Error(`AI authored runtime structure failed:\n${issues.join("\n")}`);

  const structureOnly = process.argv.includes("--structure-only");
  const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
  const limit = limitArgument ? Number.parseInt(limitArgument.split("=")[1]!, 10) : matched.length;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
  const selected = matched.slice(0, limit);
  const actualImage = pinnedImageId("python");
  const imageEvidence = {
    tag: PINNED_CURRICULUM_RUNTIMES.python.tag,
    expected: PINNED_CURRICULUM_RUNTIMES.python.imageDigest,
    actual: actualImage,
    matches: actualImage === PINNED_CURRICULUM_RUNTIMES.python.imageDigest,
  };
  if (!structureOnly && !pinnedDockerAvailable()) {
    throw new Error("Docker is unavailable; --structure-only is permitted only when runtime execution is intentionally deferred.");
  }
  if (!structureOnly && !imageEvidence.matches) {
    throw new Error(`Pinned AI Python runtime image mismatch: ${JSON.stringify(imageEvidence)}`);
  }

  const jobs = selected.flatMap(({ skillId, item }) => item.tests.map((test) => ({ skillId, item, test })));
  const results: Array<{
    skillId: string;
    itemId: string;
    testId: string;
    visibility: string;
    status: "passed" | "failed";
    durationMs: number;
    sourceHash: string;
    failure?: string;
  }> = [];
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const { skillId, item, test } = jobs[index]!;
      const started = Date.now();
      try {
        if (item.runtime.engine !== "isolated-runner") throw new Error("runtime changed after validation");
        const executed = await executePinnedCurriculumReference({
          language: "python",
          source: item.answer.referenceSolution,
          stdin: test.stdin,
          timeLimitMs: item.runtime.timeLimitMs,
          memoryLimitMb: item.runtime.memoryLimitMb,
        });
        if (
          executed.timedOut ||
          executed.code !== 0 ||
          normalizeProgramOutput(executed.stdout) !== normalizeProgramOutput(test.expectedStdout)
        ) {
          throw new Error(executed.timedOut ? "timeout" : executed.code !== 0 ? `runner exit ${executed.code}` : "stdout mismatch");
        }
        results.push({
          skillId,
          itemId: item.id,
          testId: test.id,
          visibility: test.visibility,
          status: "passed",
          durationMs: Date.now() - started,
          sourceHash: sourceHash(item.answer.referenceSolution),
        });
      } catch (error) {
        results.push({
          skillId,
          itemId: item.id,
          testId: test.id,
          visibility: test.visibility,
          status: "failed",
          durationMs: Date.now() - started,
          sourceHash: sourceHash(item.answer.referenceSolution),
          failure: error instanceof Error ? error.message : String(error),
        });
      }
      if (results.length % 16 === 0 || results.length === jobs.length) {
        console.log(`AI pinned-runtime progress: ${results.length}/${jobs.length} cases.`);
      }
    }
  }
  if (!structureOnly) await Promise.all([worker(), worker()]);
  results.sort((left, right) => left.itemId.localeCompare(right.itemId) || left.testId.localeCompare(right.testId));
  const failures = results.filter((result) => result.status === "failed");
  const fullRuntimeRun = !structureOnly && selected.length === matched.length;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: "AI course deterministic offline Python labs pinned-runtime evidence",
    status: failures.length === 0 && fullRuntimeRun ? "verified" : structureOnly ? "structure-only" : "failed-or-partial",
    counts: {
      declaredTasks: matched.length,
      selectedTasks: selected.length,
      executedCases: results.length,
      passedCases: results.length - failures.length,
      failedCases: failures.length,
    },
    fullRuntimeRun,
    externalProviderCalls: 0,
    imageEvidence,
    results,
    limitations: [
      "These are bounded deterministic offline labs, not live-model quality, safety, deployment, or provider evidence.",
      "All items remain AI-assisted drafts with null human reviewer and zero formal-exam eligibility.",
      "Local Docker image ID evidence does not replace production KVM/NUC and CVE verification.",
    ],
  };
  const reportPath = path.join(
    root,
    "docs",
    "evidence",
    structureOnly
      ? "ai-code-executable-structure-2026-07-12.json"
      : fullRuntimeRun
        ? "ai-code-executable-runtime-2026-07-12.json"
        : "ai-code-executable-sample-2026-07-12.json",
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`AI code ${structureOnly ? "structure" : "runtime"} verification: ${matched.length} tasks, ${results.length} cases, ${failures.length} failures, full=${fullRuntimeRun}.`);
  if (failures.length || (process.argv.includes("--check") && !structureOnly && !fullRuntimeRun)) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
