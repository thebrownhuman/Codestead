import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  poolQuery: vi.fn(),
  finalizeExam: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: {
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.release })),
    query: mocks.poolQuery,
  },
}));
vi.mock("./service", () => {
  class ExamServiceError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) { super(message); }
  }
  return { ExamServiceError, finalizeExam: mocks.finalizeExam };
});

import { processExamFinalizationBatch } from "./finalization-worker";
import { ExamServiceError } from "./service";

describe("exam finalization lease fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("with candidate as")) {
        return {
          rows: [{
            id: "job-1",
            session_id: "session-1",
            user_id: "learner-1",
            attempt_count: 3,
            runner_request_generation: 3,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    // Simulate another worker reclaiming attempt 3 before this worker settles.
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.finalizeExam.mockResolvedValue({ outcome: "NOT_PASSED" });
  });

  it.each([0, 11, 1.5])("rejects an invalid batch limit of %s before claiming", async (limit) => {
    await expect(processExamFinalizationBatch({ workerId: "invalid-worker", limit }))
      .rejects.toThrow("limit must be from 1 to 10");
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it("cannot overwrite a reclaimed lease and reports the lost ownership", async () => {
    await expect(processExamFinalizationBatch({
      workerId: "expired-worker", limit: 1, now: new Date("2026-07-12T10:00:00.000Z"),
    })).resolves.toEqual({ processed: 1, succeeded: 0, retried: 0, failed: 0, leaseLost: 1 });

    const settlement = mocks.poolQuery.mock.calls.find(([statement]) =>
      String(statement).includes("completed_at = coalesce") && String(statement).includes("status = 'leased'"),
    );
    expect(settlement?.[0]).toContain("lease_owner = $2 and attempt_count = $3");
    expect(settlement?.[0]).toContain("lease_expires_at > $4");
    expect(settlement?.[1]).toEqual(["job-1", "expired-worker", 3, expect.any(Date)]);
  });

  it("fences retry/failure writes by the exact owner and lease generation", async () => {
    mocks.finalizeExam.mockRejectedValue(new Error("synthetic crash"));
    await processExamFinalizationBatch({
      workerId: "expired-worker", limit: 1, now: new Date("2026-07-12T10:00:00.000Z"),
    });
    const retry = mocks.poolQuery.mock.calls.find(([statement]) =>
      String(statement).includes("last_error_code = $4") && String(statement).includes("lease_owner = $6"),
    );
    expect(retry?.[0]).toContain("attempt_count = $7");
    expect(retry?.[0]).toContain("lease_expires_at > $5");
    expect(retry?.[0]).toContain("else runner_request_generation + 1");
    expect(retry?.[1]?.[5]).toBe("expired-worker");
    expect(retry?.[1]?.[6]).toBe(3);
    expect(retry?.[1]?.[7]).toBe(false);
  });

  it("schedules a fresh stable runner generation after retryable official capacity", async () => {
    mocks.finalizeExam.mockRejectedValue(new ExamServiceError(
      "Official runner capacity is busy.",
      503,
      "RUNNER_CAPACITY_BUSY",
    ));
    mocks.poolQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("last_error_code = $4") && statement.includes("lease_owner = $6")) {
        return { rows: [{ id: "job-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(processExamFinalizationBatch({
      workerId: "capacity-worker", limit: 1, now: new Date("2026-07-12T10:00:00.000Z"),
    })).resolves.toEqual({ processed: 1, succeeded: 0, retried: 1, failed: 0, leaseLost: 0 });
    expect(mocks.finalizeExam).toHaveBeenCalledWith(
      "learner-1",
      "session-1",
      "deadline",
      expect.any(Date),
      {
        leaseFence: {
          jobId: "job-1",
          owner: "capacity-worker",
          attemptCount: 3,
          clock: expect.any(Function),
        },
      },
    );
  });

  it("preserves the runner generation after an indeterminate dispatch while advancing the lease fence", async () => {
    mocks.clientQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("with candidate as")) {
        return {
          rows: [{
            id: "job-1",
            session_id: "session-1",
            user_id: "learner-1",
            attempt_count: 9,
            runner_request_generation: 3,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    mocks.finalizeExam.mockRejectedValue(new ExamServiceError(
      "Runner dispatch may have reached the remote service.",
      503,
      "RUNNER_INDETERMINATE",
    ));
    mocks.poolQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("last_error_code = $4") && statement.includes("lease_owner = $6")) {
        return { rows: [{ id: "job-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(processExamFinalizationBatch({
      workerId: "retry-worker",
      limit: 1,
      now: new Date("2026-07-12T10:00:00.000Z"),
      clock: () => new Date("2026-07-12T10:00:00.000Z"),
    })).resolves.toEqual({ processed: 1, succeeded: 0, retried: 1, failed: 0, leaseLost: 0 });

    const retry = mocks.poolQuery.mock.calls.find(([statement]) =>
      String(statement).includes("runner_request_generation = case when $8"),
    );
    expect(retry?.[1]?.[2]).toEqual(new Date("2026-07-12T10:10:00.000Z"));
    expect(retry?.[1]?.[6]).toBe(9);
    expect(retry?.[1]?.[7]).toBe(true);
    expect(mocks.finalizeExam).toHaveBeenCalledWith(
      "learner-1",
      "session-1",
      "deadline",
      expect.any(Date),
      expect.objectContaining({
        leaseFence: expect.objectContaining({ attemptCount: 9 }),
      }),
    );
  });

  it("dead-letters an inactive learner without retrying or writing official evidence", async () => {
    mocks.finalizeExam.mockRejectedValue(new ExamServiceError(
      "Learner is not active.",
      409,
      "LEARNER_NOT_ACTIVE",
    ));
    mocks.poolQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("last_error_code = $4") && statement.includes("lease_owner = $6")) {
        return { rows: [{ id: "job-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(processExamFinalizationBatch({
      workerId: "inactive-worker",
      limit: 1,
      now: new Date("2026-07-12T10:00:00.000Z"),
    })).resolves.toEqual({ processed: 1, succeeded: 0, retried: 0, failed: 1, leaseLost: 0 });

    const terminal = mocks.poolQuery.mock.calls.find(([statement]) =>
      String(statement).includes("last_error_code = $4") && String(statement).includes("lease_owner = $6"),
    );
    expect(terminal?.[1]?.[1]).toBe("failed");
    expect(terminal?.[1]?.[3]).toBe("LEARNER_NOT_ACTIVE");
  });
});
