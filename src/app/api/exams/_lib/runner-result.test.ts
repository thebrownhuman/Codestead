import { describe, expect, it } from "vitest";

import type { RunnerJobResponse } from "@/lib/runner/client";
import { normalizedRunnerResult } from "./runner-result";

const STARTED = new Date("2026-11-01T00:00:00.000Z");
const FINISHED = new Date("2026-11-01T00:00:02.000Z");

function job(result: NonNullable<RunnerJobResponse["result"]>): RunnerJobResponse {
  return {
    jobId: "job-1",
    submissionId: "submission-1",
    correlationId: "correlation-1",
    requestHash: "a".repeat(64),
    state: "COMPLETED",
    queuePosition: null,
    result,
  };
}

function test(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1", visibility: "VISIBLE", category: "basic", status: "FAILED", feedbackCode: "WRONG_OUTPUT",
    ...overrides,
  } as NonNullable<RunnerJobResponse["result"]>["tests"][number];
}

describe("normalizedRunnerResult", () => {
  it("keeps the exit codes and wall times the runner measured", () => {
    const result = normalizedRunnerResult(job({
      status: "WRONG_ANSWER",
      imageDigest: "sha256:image",
      runtimeVersion: "python-3.12",
      compile: { status: "OK", stdout: "", stderr: "", exitCode: 0, wallTimeMs: 412 },
      tests: [
        test({ id: "t1", exitCode: 1, wallTimeMs: 37 }),
        test({ id: "t2", status: "TIMEOUT", exitCode: null, wallTimeMs: 5000 }),
      ],
      totals: { passed: 0, failed: 2, total: 2 },
    }), "b".repeat(64), "fallback", STARTED, FINISHED);

    expect(result?.compile).toMatchObject({ exitCode: 0, wallTimeMs: 412 });
    expect(result?.tests.map(({ id, exitCode, wallTimeMs }) => ({ id, exitCode, wallTimeMs }))).toEqual([
      { id: "t1", exitCode: 1, wallTimeMs: 37 },
      { id: "t2", exitCode: null, wallTimeMs: 5000 },
    ]);
  });

  it("falls back to 0 and null when the runner reports nothing usable", () => {
    const result = normalizedRunnerResult(job({
      status: "WRONG_ANSWER",
      imageDigest: "sha256:image",
      runtimeVersion: "python-3.12",
      compile: { status: "OK", stdout: "", stderr: "", exitCode: 0 },
      tests: [
        test({ id: "t1" }),
        test({ id: "t2", exitCode: 1.5, wallTimeMs: -4 }),
        test({ id: "t3", exitCode: "1", wallTimeMs: Number.NaN }),
      ],
      totals: { passed: 0, failed: 3, total: 3 },
    }), "b".repeat(64), "fallback", STARTED, FINISHED);

    expect(result?.compile.wallTimeMs).toBe(0);
    expect(result?.tests.map(({ exitCode, wallTimeMs }) => ({ exitCode, wallTimeMs }))).toEqual([
      { exitCode: null, wallTimeMs: 0 },
      { exitCode: null, wallTimeMs: 0 },
      { exitCode: null, wallTimeMs: 0 },
    ]);
  });

  it("returns null without a runner result", () => {
    const pending = { ...job({} as never), result: undefined };
    expect(normalizedRunnerResult(pending, "b".repeat(64), "fallback", STARTED, FINISHED)).toBeNull();
  });
});
