import type { RunnerJobResponse } from "@/lib/runner/client";

import type { ExamRunnerResult } from "./contracts";

// The runner response validator does not check these optional measurements,
// so only well-formed values are stored; anything else keeps the old defaults.
function measuredWallTimeMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function measuredExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function normalizedRunnerResult(
  job: RunnerJobResponse,
  sourceHash: string,
  fallbackRuntimeVersion: string,
  startedAt: Date,
  finishedAt: Date,
): ExamRunnerResult | null {
  const raw = job.result;
  if (!raw) return null;
  const statuses = new Set<ExamRunnerResult["status"]>([
    "COMPILE_ONLY", "ACCEPTED", "WRONG_ANSWER", "COMPILE_ERROR", "RUNTIME_ERROR",
    "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT", "INFRASTRUCTURE_ERROR",
  ]);
  const compileStatuses = new Set<ExamRunnerResult["compile"]["status"]>([
    "OK", "COMPILE_ERROR", "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT", "INFRASTRUCTURE_ERROR",
  ]);
  const testStatuses = new Set<ExamRunnerResult["tests"][number]["status"]>([
    "PASSED", "FAILED", "RUNTIME_ERROR", "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT",
    "INFRASTRUCTURE_ERROR",
  ]);
  const status = statuses.has(raw.status as ExamRunnerResult["status"])
    ? raw.status as ExamRunnerResult["status"]
    : "INFRASTRUCTURE_ERROR";
  const compileStatus = compileStatuses.has(raw.compile.status as ExamRunnerResult["compile"]["status"])
    ? raw.compile.status as ExamRunnerResult["compile"]["status"]
    : "INFRASTRUCTURE_ERROR";
  return {
    status,
    requestHash: job.requestHash,
    sourceHash,
    runtimeVersion: raw.runtimeVersion ?? fallbackRuntimeVersion,
    imageDigest: raw.imageDigest,
    compile: {
      status: compileStatus,
      exitCode: raw.compile.exitCode,
      stdout: raw.compile.stdout,
      stderr: raw.compile.stderr,
      wallTimeMs: measuredWallTimeMs(raw.compile.wallTimeMs),
    },
    ...(raw.run ? { run: { ...raw.run } } : {}),
    tests: raw.tests.map((test) => ({
      id: test.id,
      visibility: test.visibility === "HIDDEN" ? "HIDDEN" : "VISIBLE",
      category: test.category,
      status: testStatuses.has(test.status as ExamRunnerResult["tests"][number]["status"])
        ? test.status as ExamRunnerResult["tests"][number]["status"]
        : "INFRASTRUCTURE_ERROR",
      feedbackCode: test.feedbackCode,
      exitCode: measuredExitCode(test.exitCode),
      wallTimeMs: measuredWallTimeMs(test.wallTimeMs),
    })),
    totals: raw.totals,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}
