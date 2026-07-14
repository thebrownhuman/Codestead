import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Receipt = { input_hash: string; result: unknown };
  const state: {
    receipt: Receipt | null;
    attempt: Record<string, unknown> | null;
    mastery: Record<string, unknown> | null;
    activeGrant: Record<string, unknown> | null;
    totalXp: number;
    coinBalance: number;
    eventCount: number;
    periodRows: Array<{ earned_xp: number; qualifying_rewards: number }>;
    timezone: string | null;
    nextEvent: number;
  } = {
    receipt: null,
    attempt: null,
    mastery: null,
    activeGrant: null,
    totalXp: 0,
    coinBalance: 0,
    eventCount: 0,
    periodRows: [],
    timezone: "UTC",
    nextEvent: 1,
  };
  const query = vi.fn(async (statement: string, params: unknown[] = []) => {
    if (/^(begin|commit|rollback)/.test(statement) || statement.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (statement.includes("from reward_operation_receipt") && statement.includes("for update")) {
      return { rows: state.receipt ? [state.receipt] : [] };
    }
    if (statement.includes("from attempt a") && statement.includes("effective_result")) {
      return { rows: state.attempt ? [state.attempt] : [] };
    }
    if (statement.includes("from mastery_evidence m") && statement.includes("for update")) {
      return { rows: state.mastery ? [state.mastery] : [] };
    }
    if (statement.includes("from reward_ledger g") && statement.includes("limit 1 for update")) {
      return { rows: state.activeGrant ? [state.activeGrant] : [] };
    }
    if (statement.includes("insert into reward_ledger")) {
      return { rows: [{ id: `event-${state.nextEvent++}` }] };
    }
    if (statement.includes("insert into reward_operation_receipt")) {
      state.receipt = { input_hash: String(params[3]), result: JSON.parse(String(params[5])) };
      return { rows: [] };
    }
    if (statement.includes("select timezone from")) return { rows: state.timezone ? [{ timezone: state.timezone }] : [] };
    if (statement.includes("coalesce(sum(xp_delta)")) {
      return { rows: [{ total_xp: state.totalXp, coin_balance: state.coinBalance, event_count: state.eventCount }] };
    }
    if (statement.includes("qualifying_rewards")) {
      return { rows: [state.periodRows.shift() ?? { earned_xp: 0, qualifying_rewards: 0 }] };
    }
    throw new Error(`Unexpected SQL in reward service test: ${statement}`);
  });
  const client = { query, release: vi.fn() };
  return { state, query, client, connect: vi.fn(async () => client) };
});

vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect } }));

import {
  RewardServiceError,
  loadRewardProgress,
  reconcileAttemptReward,
  reconcileMasteryEvidenceReward,
} from "../service";

const USER_ID = "learner-1";
const ATTEMPT_ID = "11000000-0000-4000-8000-000000000001";
const MASTERY_ID = "12000000-0000-4000-8000-000000000001";
const REQUEST_ID = "13000000-0000-4000-8000-000000000001";
const ENROLLMENT_ID = "14000000-0000-4000-8000-000000000001";
const ACTIVITY_ID = "15000000-0000-4000-8000-000000000001";
const CONCEPT_ID = "16000000-0000-4000-8000-000000000001";

const attempt = {
  enrollment_id: ENROLLMENT_ID,
  kind: "quiz",
  status: "graded",
  passed: true,
  mastery_awarded: true,
  infrastructure_failure: false,
  assistance_level: "A0",
  solution_revealed: false,
  activity_id: ACTIVITY_ID,
  content_version: "python-v1",
  effective_result: null,
  evidence_occurred_at: new Date("2026-07-06T04:00:00.000Z"),
};

const mastery = {
  enrollment_id: ENROLLMENT_ID,
  concept_id: CONCEPT_ID,
  language_context: "python",
  validity: "valid",
  score: 0.9,
  weight: 1,
  recorded_by: "verified-runner",
  source_type: "verified_runner",
  recorded_at: new Date("2026-07-06T04:00:00.000Z"),
  source_attempt_id: ATTEMPT_ID,
  source_attempt_status: "graded",
  source_attempt_passed: true,
  source_attempt_mastery_awarded: true,
  source_attempt_infrastructure_failure: false,
  source_attempt_assistance_level: "A0",
  source_attempt_solution_revealed: false,
  source_attempt_concept_bound: true,
  source_attempt_effective_result: null,
};

describe("reward reconciliation service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.state, {
      receipt: null,
      attempt: { ...attempt },
      mastery: { ...mastery },
      activeGrant: null,
      totalXp: 0,
      coinBalance: 0,
      eventCount: 0,
      periodRows: [],
      timezone: "UTC",
      nextEvent: 1,
    });
  });

  it("creates one evidence-bound attempt grant and replays its receipt", async () => {
    await expect(reconcileAttemptReward({ userId: USER_ID, attemptId: ATTEMPT_ID, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "granted",
      eventId: "event-1",
      xpDelta: 20,
      coinDelta: 0,
      replayed: false,
    });
    await expect(reconcileAttemptReward({ userId: USER_ID, attemptId: ATTEMPT_ID, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "granted",
      eventId: "event-1",
      replayed: true,
    });
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("insert into reward_ledger"))).toHaveLength(1);
    expect(mocks.client.release).toHaveBeenCalledTimes(2);
  });

  it("detects a reused request id with different immutable input", async () => {
    await reconcileAttemptReward({ userId: USER_ID, attemptId: ATTEMPT_ID, requestId: REQUEST_ID });
    await expect(reconcileMasteryEvidenceReward({
      userId: USER_ID,
      masteryEvidenceId: MASTERY_ID,
      requestId: REQUEST_ID,
    })).rejects.toEqual(new RewardServiceError("IDEMPOTENCY_CONFLICT"));
    expect(mocks.query).toHaveBeenCalledWith("rollback");
  });

  it("records an idempotent no-op for practice instead of minting replay XP", async () => {
    mocks.state.attempt = { ...attempt, kind: "practice" };
    await expect(reconcileAttemptReward({ userId: USER_ID, attemptId: ATTEMPT_ID, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unchanged",
      eventId: null,
      xpDelta: 0,
      reason: expect.stringContaining("do not earn"),
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("insert into reward_ledger"))).toBe(false);
    expect(mocks.state.receipt).not.toBeNull();
  });

  it("prevents a second grant for an already-active semantic scope", async () => {
    mocks.state.activeGrant = {
      id: "active-1",
      reward_code: "attempt_completion",
      scope_key: `activity:${ACTIVITY_ID}`,
      enrollment_id: ENROLLMENT_ID,
      attempt_id: ATTEMPT_ID,
      mastery_evidence_id: null,
      xp_delta: 20,
      coin_delta: 0,
      policy_version: "reward-ledger-2026-07.v1",
      evidence_occurred_at: new Date("2026-07-06T04:00:00.000Z"),
    };
    await expect(reconcileAttemptReward({ userId: USER_ID, attemptId: ATTEMPT_ID, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "unchanged",
      reason: expect.stringContaining("cannot farm"),
    });
  });

  it("appends an exact reversal after evidence becomes ineligible", async () => {
    mocks.state.attempt = { ...attempt, passed: false, mastery_awarded: false };
    mocks.state.activeGrant = {
      id: "active-1",
      reward_code: "attempt_completion",
      scope_key: `activity:${ACTIVITY_ID}`,
      enrollment_id: ENROLLMENT_ID,
      attempt_id: ATTEMPT_ID,
      mastery_evidence_id: null,
      xp_delta: 20,
      coin_delta: 0,
      policy_version: "reward-ledger-2026-07.v1",
      evidence_occurred_at: new Date("2026-07-06T04:00:00.000Z"),
    };
    await expect(reconcileAttemptReward({ userId: USER_ID, attemptId: ATTEMPT_ID, requestId: REQUEST_ID })).resolves.toMatchObject({
      status: "revoked",
      eventId: "event-1",
      xpDelta: -20,
      replayed: false,
    });
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into reward_ledger"));
    expect(insert?.[0]).toContain("'revocation'");
    expect(insert?.[1]).toEqual(expect.arrayContaining(["active-1", -20]));
  });

  it("never lets an ineligible sibling revoke another qualifying source in the same scope", async () => {
    mocks.state.attempt = { ...attempt, passed: false, mastery_awarded: false };
    mocks.state.activeGrant = {
      id: "active-2",
      reward_code: "attempt_completion",
      scope_key: `activity:${ACTIVITY_ID}`,
      enrollment_id: ENROLLMENT_ID,
      attempt_id: "11000000-0000-4000-8000-000000000099",
      mastery_evidence_id: null,
      xp_delta: 20,
      coin_delta: 0,
      policy_version: "reward-ledger-2026-07.v1",
      evidence_occurred_at: new Date("2026-07-06T03:00:00.000Z"),
    };
    await expect(reconcileAttemptReward({
      userId: USER_ID,
      attemptId: ATTEMPT_ID,
      requestId: REQUEST_ID,
    })).resolves.toMatchObject({
      status: "unchanged",
      xpDelta: 0,
      reason: expect.stringContaining("cannot revoke another qualifying source"),
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("'revocation'"))).toBe(false);
  });

  it("grants trusted concept mastery and rejects cross-owner/missing evidence without leaking it", async () => {
    await expect(reconcileMasteryEvidenceReward({
      userId: USER_ID,
      masteryEvidenceId: MASTERY_ID,
      requestId: REQUEST_ID,
    })).resolves.toMatchObject({ status: "granted", xpDelta: 60 });

    mocks.state.receipt = null;
    mocks.state.mastery = null;
    await expect(reconcileMasteryEvidenceReward({
      userId: "other-learner",
      masteryEvidenceId: MASTERY_ID,
      requestId: "13000000-0000-4000-8000-000000000002",
    })).rejects.toEqual(new RewardServiceError("EVIDENCE_NOT_FOUND"));
    expect(mocks.query).toHaveBeenCalledWith("rollback");
  });

  it("rejects malformed ids and timestamps before acquiring a connection", async () => {
    await expect(reconcileAttemptReward({ userId: USER_ID, attemptId: "bad", requestId: REQUEST_ID })).rejects.toEqual(
      new RewardServiceError("INVALID_INPUT"),
    );
    await expect(reconcileMasteryEvidenceReward({
      userId: USER_ID,
      masteryEvidenceId: MASTERY_ID,
      requestId: REQUEST_ID,
      now: new Date(Number.NaN),
    })).rejects.toEqual(new RewardServiceError("INVALID_INPUT"));
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("authoritative reward read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.state, {
      receipt: null,
      totalXp: 360,
      coinBalance: 0,
      eventCount: 5,
      periodRows: [
        { earned_xp: 260, qualifying_rewards: 4 },
        { earned_xp: 360, qualifying_rewards: 5 },
      ],
      timezone: "Asia/Kolkata",
    });
  });

  it("derives level and learner-local weekly/monthly progress from unreversed ledger rows", async () => {
    await expect(loadRewardProgress(USER_ID, new Date("2026-07-07T00:00:00.000Z"))).resolves.toMatchObject({
      totalXp: 360,
      level: { level: 3, xpIntoLevel: 60, xpToNextLevel: 240 },
      coins: { enabled: false, balance: 0, policyNote: expect.stringContaining("zero coins") },
      eventCount: 5,
      challenges: {
        weekly: { earnedXp: 260, qualifyingRewards: 4, completed: true },
        monthly: { earnedXp: 360, qualifyingRewards: 5, completed: false },
      },
    });
    const periodCalls = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("qualifying_rewards"));
    expect(periodCalls).toHaveLength(2);
    expect(periodCalls.every(([, params]) => Array.isArray(params) && params[3] === "Asia/Kolkata")).toBe(true);
  });

  it("fails closed for another/inactive owner or a corrupt negative/nonzero-coin balance", async () => {
    mocks.state.timezone = null;
    await expect(loadRewardProgress("missing")).rejects.toEqual(new RewardServiceError("EVIDENCE_NOT_FOUND"));
    mocks.state.timezone = "UTC";
    mocks.state.totalXp = -1;
    await expect(loadRewardProgress(USER_ID)).rejects.toEqual(new RewardServiceError("CORRUPT_LEDGER"));
    mocks.state.totalXp = 1;
    mocks.state.coinBalance = 1;
    await expect(loadRewardProgress(USER_ID)).rejects.toEqual(new RewardServiceError("CORRUPT_LEDGER"));
    expect(mocks.client.release).toHaveBeenCalledTimes(3);
  });
});
