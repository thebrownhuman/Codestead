import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    claimed: Array<Record<string, unknown>>;
    completeRowCount: number;
    retryRowCount: number;
    deadLetterRowCount: number;
  } = { claimed: [], completeRowCount: 1, retryRowCount: 1, deadLetterRowCount: 1 };
  const clientQuery = vi.fn(async (sql: string) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
    if (sql.includes("with candidates as")) return { rows: state.claimed, rowCount: state.claimed.length };
    throw new Error(`Unexpected client SQL: ${sql}`);
  });
  const poolQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    void params;
    if (sql.includes("enqueue_reward_jobs_for_")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("set status = 'complete'")) return { rows: [], rowCount: state.completeRowCount };
    if (sql.includes("set status = 'pending'")) return { rows: [], rowCount: state.retryRowCount };
    if (sql.includes("set status = 'dead_letter'")) {
      return { rows: [{ dead_lettered: state.deadLetterRowCount, signaled: state.deadLetterRowCount }], rowCount: 1 };
    }
    throw new Error(`Unexpected pool SQL: ${sql}`);
  });
  const client = { query: clientQuery, release: vi.fn() };
  return {
    state,
    clientQuery,
    poolQuery,
    client,
    connect: vi.fn(async () => client),
    reconcileAttempt: vi.fn(),
    reconcileMastery: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect, query: mocks.poolQuery },
}));

vi.mock("../service", () => ({
  reconcileAttemptReward: mocks.reconcileAttempt,
  reconcileMasteryEvidenceReward: mocks.reconcileMastery,
}));

import { processRewardReconciliationBatch } from "../worker";

const NOW = new Date("2026-07-14T00:00:00.000Z");

function row(input: Partial<Record<string, unknown>> = {}) {
  return {
    id: "51000000-0000-4000-8000-000000000001",
    user_id: "learner-1",
    operation: "reconcile_attempt",
    attempt_id: "52000000-0000-4000-8000-000000000001",
    mastery_evidence_id: null,
    generation: 3,
    attempt_count: 1,
    lease_token: "53000000-0000-4000-8000-000000000001",
    ...input,
  };
}

describe("reward reconciliation worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.claimed = [];
    mocks.state.completeRowCount = 1;
    mocks.state.retryRowCount = 1;
    mocks.state.deadLetterRowCount = 1;
    mocks.reconcileAttempt.mockResolvedValue({ replayed: false });
    mocks.reconcileMastery.mockResolvedValue({ replayed: true });
  });

  it("claims a bounded SKIP LOCKED batch and completes both evidence kinds", async () => {
    mocks.state.claimed = [
      row(),
      row({
        id: "51000000-0000-4000-8000-000000000002",
        operation: "reconcile_mastery",
        attempt_id: null,
        mastery_evidence_id: "54000000-0000-4000-8000-000000000001",
      }),
    ];
    await expect(processRewardReconciliationBatch({ limit: 2, now: NOW })).resolves.toEqual({
      processed: 2,
      succeeded: 2,
      failed: 0,
      deadLettered: 0,
      superseded: 0,
      replayed: 1,
    });
    expect(mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("with candidates as"))?.[0])
      .toContain("skip locked");
    expect(mocks.reconcileAttempt).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      attemptId: "52000000-0000-4000-8000-000000000001",
      now: NOW,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    expect(mocks.reconcileMastery).toHaveBeenCalledTimes(1);
  });

  it("dead-letters an exhausted generation and creates a content-free administrator signal", async () => {
    mocks.state.claimed = [row({ attempt_count: 8 })];
    mocks.reconcileAttempt.mockRejectedValue(
      Object.assign(new Error("private evidence detail"), { code: "EVIDENCE_SHAPE_INVALID" }),
    );

    await expect(processRewardReconciliationBatch({ limit: 1, now: NOW })).resolves.toMatchObject({
      failed: 0,
      deadLettered: 1,
      superseded: 0,
    });
    const deadLetterCall = mocks.poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes("set status = 'dead_letter'"));
    expect(deadLetterCall?.[0]).toContain("Reward reconciliation needs review");
    expect(deadLetterCall?.[0]).toContain("generation = $4");
    expect(deadLetterCall?.[0]).toContain("lease_token = $5");
    expect(deadLetterCall?.[1]).toEqual(expect.arrayContaining(["EVIDENCE_SHAPE_INVALID"]));
    expect(JSON.stringify(deadLetterCall)).not.toContain("private evidence detail");
    expect(mocks.poolQuery.mock.calls.some(([sql]) => String(sql).includes("set status = 'pending'"))).toBe(false);
  });

  it("uses the same deterministic request id when an expired lease generation is reclaimed", async () => {
    mocks.state.claimed = [row()];
    await processRewardReconciliationBatch({ limit: 1, now: NOW });
    const firstRequest = mocks.reconcileAttempt.mock.calls[0]?.[0].requestId;
    mocks.state.claimed = [row({ attempt_count: 2 })];
    await processRewardReconciliationBatch({ limit: 1, now: NOW });
    expect(mocks.reconcileAttempt.mock.calls[1]?.[0].requestId).toBe(firstRequest);
  });

  it("backs off failures without leaking error text and preserves a raced newer generation", async () => {
    mocks.state.claimed = [row()];
    mocks.reconcileAttempt.mockRejectedValue(Object.assign(new Error("secret detail"), { code: "EVIDENCE_NOT_FOUND" }));
    await expect(processRewardReconciliationBatch({ limit: 1, now: NOW })).resolves.toMatchObject({
      failed: 1,
      superseded: 0,
    });
    const retryParams = mocks.poolQuery.mock.calls.find(([sql]) => String(sql).includes("set status = 'pending'"))?.[1];
    expect(retryParams).toEqual(expect.arrayContaining(["EVIDENCE_NOT_FOUND"]));
    expect(JSON.stringify(retryParams)).not.toContain("secret detail");

    vi.clearAllMocks();
    mocks.state.claimed = [row()];
    mocks.state.completeRowCount = 0;
    mocks.reconcileAttempt.mockResolvedValue({ replayed: false });
    await expect(processRewardReconciliationBatch({ limit: 1, now: NOW })).resolves.toMatchObject({
      succeeded: 0,
      superseded: 1,
    });
  });

  it("re-opens the semantic scope after a revocation so older eligible evidence can replace it", async () => {
    mocks.state.claimed = [row()];
    mocks.state.completeRowCount = 0;
    mocks.reconcileAttempt.mockResolvedValue({ status: "revoked", replayed: false });
    await expect(processRewardReconciliationBatch({ limit: 1, now: NOW })).resolves.toMatchObject({
      superseded: 1,
    });
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      "select enqueue_reward_jobs_for_attempt_v1($1,$2,$3)",
      ["52000000-0000-4000-8000-000000000001", "learner-1", NOW],
    );
  });

  it("rejects invalid bounds before opening a database connection", async () => {
    await expect(processRewardReconciliationBatch({ limit: 0, now: NOW })).rejects.toThrow(RangeError);
    await expect(processRewardReconciliationBatch({ limit: 101, now: NOW })).rejects.toThrow(RangeError);
    await expect(processRewardReconciliationBatch({ limit: 1, now: new Date(Number.NaN) })).rejects.toThrow(RangeError);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
