import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import {
  activity,
  attempt,
  concept,
  course,
  courseModule,
  courseVersion,
  enrollment,
  lesson,
  masteryEvidence,
  user,
} from "@/lib/db/schema";
import {
  RewardServiceError,
  loadRewardProgress,
  reconcileAttemptReward,
  reconcileMasteryEvidenceReward,
} from "@/lib/rewards/service";
import { processRewardReconciliationBatch } from "@/lib/rewards/worker";

const LEARNER = "reward-ledger-integration-learner";
const OTHER = "reward-ledger-integration-other";
const COURSE = "71000000-0000-4000-8000-000000000001";
const VERSION = "71000000-0000-4000-8000-000000000002";
const MODULE = "71000000-0000-4000-8000-000000000003";
const CONCEPT = "71000000-0000-4000-8000-000000000004";
const LESSON = "71000000-0000-4000-8000-000000000005";
const ACTIVITY = "71000000-0000-4000-8000-000000000006";
const LEARNER_ENROLLMENT = "71000000-0000-4000-8000-000000000007";
const OTHER_ENROLLMENT = "71000000-0000-4000-8000-000000000008";
const ATTEMPT_ONE = "71000000-0000-4000-8000-000000000009";
const ATTEMPT_TWO = "71000000-0000-4000-8000-000000000010";
const OTHER_ATTEMPT = "71000000-0000-4000-8000-000000000011";
const MASTERY = "71000000-0000-4000-8000-000000000012";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Reward-ledger integration requires the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values([
    {
      id: LEARNER,
      publicId: "72000000-0000-4000-8000-000000000001",
      name: "Reward Learner",
      email: "reward-learner@integration.invalid",
      role: "learner",
      status: "active",
      timezone: "Asia/Kolkata",
    },
    {
      id: OTHER,
      publicId: "72000000-0000-4000-8000-000000000002",
      name: "Other Reward Learner",
      email: "reward-other@integration.invalid",
      role: "learner",
      status: "active",
      timezone: "UTC",
    },
  ]);
  await db.insert(course).values({
    id: COURSE,
    slug: "reward-python",
    title: "Reward Python",
    summary: "Disposable reward-ledger fixture.",
    domain: "programming",
  });
  await db.insert(courseVersion).values({
    id: VERSION,
    courseId: COURSE,
    version: "reward-v1",
    stage: "beta",
    scopeStatement: "Disposable reward evidence only.",
    contentHash: "reward-ledger-integration-content",
  });
  await db.insert(courseModule).values({
    id: MODULE,
    courseVersionId: VERSION,
    slug: "reward-module",
    title: "Reward module",
    objective: "Exercise authoritative reward accounting.",
    position: 1,
    estimatedMinutes: 10,
  });
  await db.insert(concept).values({
    id: CONCEPT,
    slug: "reward.python.variables",
    title: "Variables",
    domain: "programming",
    description: "Disposable reward concept.",
    critical: true,
  });
  await db.insert(lesson).values({
    id: LESSON,
    moduleId: MODULE,
    slug: "reward-variables",
    title: "Reward variables",
    objective: "Complete one independently graded checkpoint.",
    estimatedMinutes: 10,
    difficulty: "beginner",
    position: 1,
    contentStatus: "beta",
  });
  await db.insert(activity).values({
    id: ACTIVITY,
    lessonId: LESSON,
    conceptId: CONCEPT,
    slug: "reward-variables-check",
    type: "quiz",
    instructions: "Complete the reviewed checkpoint.",
    specification: { fixture: true },
    difficulty: "beginner",
    maxPoints: 1,
  });
  await db.insert(enrollment).values([
    { id: LEARNER_ENROLLMENT, userId: LEARNER, courseVersionId: VERSION, status: "active" },
    { id: OTHER_ENROLLMENT, userId: OTHER, courseVersionId: VERSION, status: "active" },
  ]);
  await db.insert(attempt).values([
    {
      id: ATTEMPT_ONE,
      userId: LEARNER,
      activityId: ACTIVITY,
      enrollmentId: LEARNER_ENROLLMENT,
      kind: "quiz",
      attemptNumber: 1,
      status: "graded",
      policyVersion: "assessment-v1",
      contentVersion: "reward-v1",
      score: 1,
      passed: true,
      masteryAwarded: true,
      infrastructureFailure: false,
      assistanceLevel: "A0",
      solutionRevealed: false,
      gradedAt: new Date("2026-07-06T04:00:00.000Z"),
    },
    {
      id: ATTEMPT_TWO,
      userId: LEARNER,
      activityId: ACTIVITY,
      enrollmentId: LEARNER_ENROLLMENT,
      kind: "quiz",
      attemptNumber: 2,
      status: "graded",
      policyVersion: "assessment-v1",
      contentVersion: "reward-v1",
      score: 1,
      passed: true,
      masteryAwarded: true,
      infrastructureFailure: false,
      assistanceLevel: "A0",
      solutionRevealed: false,
      gradedAt: new Date("2026-07-06T04:05:00.000Z"),
    },
    {
      id: OTHER_ATTEMPT,
      userId: OTHER,
      activityId: ACTIVITY,
      enrollmentId: OTHER_ENROLLMENT,
      kind: "quiz",
      attemptNumber: 1,
      status: "graded",
      policyVersion: "assessment-v1",
      contentVersion: "reward-v1",
      score: 1,
      passed: true,
      masteryAwarded: true,
      infrastructureFailure: false,
      assistanceLevel: "A0",
      solutionRevealed: false,
      gradedAt: new Date("2026-07-06T04:10:00.000Z"),
    },
  ]);
  await db.insert(masteryEvidence).values({
    id: MASTERY,
    userId: LEARNER,
    enrollmentId: LEARNER_ENROLLMENT,
    conceptId: CONCEPT,
    languageContext: "python",
    evidenceType: "deterministic-check",
    sourceType: "attempt",
    sourceId: ATTEMPT_ONE,
    score: 0.95,
    weight: 1,
    validity: "valid",
    policyVersion: "mastery-v1",
    recordedBy: "verified-runner",
    recordedAt: new Date("2026-07-06T04:00:00.000Z"),
  });
});

afterAll(async () => {
  await pool.end();
});

describe("append-only reward ledger PostgreSQL contract", () => {
  async function drainRewardJobs(now: Date) {
    let processed = 0;
    for (let index = 0; index < 10; index += 1) {
      const report = await processRewardReconciliationBatch({ limit: 20, now });
      processed += report.processed;
      if (report.processed === 0) return processed;
    }
    const open = await pool.query(
      `select operation,status,generation,attempt_count,last_error_code,attempt_id,mastery_evidence_id
         from reward_reconciliation_job where status <> 'complete' order by operation,id`,
    );
    throw new Error(`Reward reconciliation queue did not drain: ${JSON.stringify(open.rows)}`);
  }

  it("is idempotent and prevents replay farming across attempts for one activity scope", async () => {
    const first = await reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000001",
      now: new Date("2026-07-06T05:00:00.000Z"),
    });
    expect(first).toMatchObject({ status: "granted", xpDelta: 20, replayed: false });
    await expect(reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000001",
      now: new Date("2026-07-06T05:01:00.000Z"),
    })).resolves.toMatchObject({ status: "granted", eventId: first.eventId, replayed: true });
    await expect(reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_TWO,
      requestId: "73000000-0000-4000-8000-000000000002",
      now: new Date("2026-07-06T05:02:00.000Z"),
    })).resolves.toMatchObject({ status: "unchanged", xpDelta: 0, replayed: false });

    const state = await pool.query<{ grants: string; receipts: string; xp: string }>(`
      select
        (select count(*)::text from reward_ledger where user_id = $1 and event_kind = 'grant') grants,
        (select count(*)::text from reward_operation_receipt where user_id = $1) receipts,
        (select coalesce(sum(xp_delta),0)::text from reward_ledger where user_id = $1) xp
    `, [LEARNER]);
    expect(state.rows[0]).toEqual({ grants: "1", receipts: "2", xp: "20" });
  });

  it("appends an exact correction reversal and permits one later replacement grant", async () => {
    const first = await reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000003",
      now: new Date("2026-07-06T05:00:00.000Z"),
    });
    await pool.query(
      `update attempt set passed = false, mastery_awarded = false where id = $1 and user_id = $2`,
      [ATTEMPT_ONE, LEARNER],
    );
    await expect(reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000004",
      now: new Date("2026-07-06T05:05:00.000Z"),
    })).resolves.toMatchObject({ status: "revoked", xpDelta: -20 });
    await expect(reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_TWO,
      requestId: "73000000-0000-4000-8000-000000000005",
      now: new Date("2026-07-06T05:10:00.000Z"),
    })).resolves.toMatchObject({ status: "granted", xpDelta: 20 });

    const rows = await pool.query<{
      event_kind: string;
      source_event_id: string | null;
      xp_delta: number;
    }>(`select event_kind,source_event_id,xp_delta from reward_ledger where user_id = $1 order by occurred_at,id`, [LEARNER]);
    expect(rows.rows).toEqual([
      { event_kind: "grant", source_event_id: null, xp_delta: 20 },
      { event_kind: "revocation", source_event_id: first.eventId, xp_delta: -20 },
      { event_kind: "grant", source_event_id: null, xp_delta: 20 },
    ]);
  });

  it("enforces owner/evidence/delta/coin constraints and append-only history against direct SQL", async () => {
    const granted = await reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000006",
    });
    const base = [
      OTHER,
      LEARNER_ENROLLMENT,
      "attempt_completion",
      `activity:${ACTIVITY}`,
      ATTEMPT_ONE,
      20,
      "reward-ledger-2026-07.v1",
      "73000000-0000-4000-8000-000000000007",
      "a".repeat(64),
      "Synthetic direct SQL abuse should be rejected.",
    ];
    await expect(pool.query(
      `insert into reward_ledger
        (user_id,enrollment_id,event_kind,reward_code,scope_key,attempt_id,xp_delta,coin_delta,
         policy_version,request_id,request_hash,reason)
       values ($1,$2,'grant',$3,$4,$5,$6,0,$7,$8,$9,$10)`,
      base,
    )).rejects.toMatchObject({ code: "23503" });

    await expect(pool.query(
      `insert into reward_ledger
        (user_id,enrollment_id,event_kind,reward_code,scope_key,attempt_id,xp_delta,coin_delta,
         policy_version,request_id,request_hash,reason)
       values ($1,$2,'grant',$3,$4,$5,999,0,$6,$7,$8,$9)`,
      [LEARNER, LEARNER_ENROLLMENT, "attempt_completion", `activity:${ACTIVITY}`, ATTEMPT_ONE,
        "reward-ledger-2026-07.v1", "73000000-0000-4000-8000-000000000008", "b".repeat(64),
        "Fabricated XP amount must fail the policy trigger."],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      `insert into reward_ledger
        (user_id,enrollment_id,event_kind,reward_code,scope_key,attempt_id,xp_delta,coin_delta,
         policy_version,request_id,request_hash,reason)
       values ($1,$2,'grant','attempt_completion',$3,$4,20,1,$5,$6,$7,$8)`,
      [OTHER, OTHER_ENROLLMENT, `activity:${ACTIVITY}`, OTHER_ATTEMPT,
        "reward-ledger-2026-07.v1", "73000000-0000-4000-8000-000000000014", "c".repeat(64),
        "Coins remain disabled until a reviewed purpose exists."],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      `insert into reward_ledger
        (user_id,enrollment_id,event_kind,reward_code,scope_key,attempt_id,source_event_id,
         xp_delta,coin_delta,policy_version,request_id,request_hash,reason)
       values ($1,$2,'revocation','attempt_completion',$3,$4,$5,-19,0,$6,$7,$8,$9)`,
      [LEARNER, LEARNER_ENROLLMENT, `activity:${ACTIVITY}`, ATTEMPT_ONE, granted.eventId,
        "reward-ledger-2026-07.v1", "73000000-0000-4000-8000-000000000015", "d".repeat(64),
        "An inexact reversal must be rejected by the ledger trigger."],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(`update reward_ledger set xp_delta = 21 where id = $1`, [granted.eventId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(`delete from reward_ledger where id = $1`, [granted.eventId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(
      `update reward_operation_receipt set result = '{}'::jsonb where user_id = $1 and request_id = $2`,
      [LEARNER, "73000000-0000-4000-8000-000000000006"],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps cross-user service reads indistinguishable and rejects request-id input drift", async () => {
    await expect(reconcileAttemptReward({
      userId: OTHER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000009",
    })).rejects.toEqual(new RewardServiceError("EVIDENCE_NOT_FOUND"));
    await reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000010",
    });
    await expect(reconcileMasteryEvidenceReward({
      userId: LEARNER,
      masteryEvidenceId: MASTERY,
      requestId: "73000000-0000-4000-8000-000000000010",
    })).rejects.toEqual(new RewardServiceError("IDEMPOTENCY_CONFLICT"));
  });

  it("derives levels and local challenge progress from net authoritative events with coins honestly disabled", async () => {
    await reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000011",
      now: new Date("2026-07-06T04:30:00.000Z"),
    });
    await reconcileMasteryEvidenceReward({
      userId: LEARNER,
      masteryEvidenceId: MASTERY,
      requestId: "73000000-0000-4000-8000-000000000012",
      now: new Date("2026-07-06T04:31:00.000Z"),
    });
    await expect(loadRewardProgress(LEARNER, new Date("2026-07-06T05:00:00.000Z"))).resolves.toMatchObject({
      totalXp: 80,
      level: { level: 1, xpIntoLevel: 80, xpToNextLevel: 20 },
      coins: { enabled: false, balance: 0, policyNote: expect.stringContaining("zero coins") },
      challenges: {
        weekly: {
          period: { timezone: "Asia/Kolkata", startLocalDate: "2026-07-06" },
          earnedXp: 80,
          qualifyingRewards: 2,
          completed: false,
        },
        monthly: { earnedXp: 80, qualifyingRewards: 2, completed: false },
      },
    });
  });

  it("runs live, bounded reconciliation and revokes/regrants from authoritative source changes", async () => {
    // Queue due-times are written by PostgreSQL's real clock. Keep the injected
    // worker clock deterministically ahead of that value so this fixture does
    // not become time-dependent as the calendar advances.
    const now = new Date("2099-07-14T05:00:00.000Z");
    expect(await drainRewardJobs(now)).toBeGreaterThanOrEqual(4);
    await expect(loadRewardProgress(LEARNER, now)).resolves.toMatchObject({ totalXp: 80 });

    await pool.query(`update mastery_evidence set validity = 'revoked-by-review' where id = $1`, [MASTERY]);
    await drainRewardJobs(new Date("2099-07-14T05:05:00.000Z"));
    await expect(loadRewardProgress(LEARNER, now)).resolves.toMatchObject({ totalXp: 20 });

    await pool.query(
      `update attempt set passed = false, mastery_awarded = false where id in ($1,$2)`,
      [ATTEMPT_ONE, ATTEMPT_TWO],
    );
    await drainRewardJobs(new Date("2099-07-14T05:10:00.000Z"));
    await expect(loadRewardProgress(LEARNER, now)).resolves.toMatchObject({ totalXp: 0 });

    await pool.query(
      `update attempt set passed = true, mastery_awarded = true where id = $1`,
      [ATTEMPT_TWO],
    );
    await drainRewardJobs(new Date("2099-07-14T05:15:00.000Z"));
    await expect(loadRewardProgress(LEARNER, now)).resolves.toMatchObject({ totalXp: 20 });

    await pool.query(`update mastery_evidence set validity = 'valid' where id = $1`, [MASTERY]);
    await pool.query(
      `update attempt set passed = true, mastery_awarded = true where id = $1`,
      [ATTEMPT_ONE],
    );
    await drainRewardJobs(new Date("2099-07-14T05:20:00.000Z"));
    await expect(loadRewardProgress(LEARNER, now)).resolves.toMatchObject({ totalXp: 80 });

    const queue = await pool.query<{ open: string }>(
      `select count(*)::text open from reward_reconciliation_job where status <> 'complete'`,
    );
    expect(queue.rows[0]?.open).toBe("0");
  });

  it("rejects mastery XP at the database boundary when its source attempt becomes assisted", async () => {
    await pool.query(
      `update attempt set assistance_level = 'A2' where id = $1`,
      [ATTEMPT_ONE],
    );
    const evidence = await pool.query<{ recorded_at: Date }>(
      `select recorded_at from mastery_evidence where id = $1`,
      [MASTERY],
    );
    await expect(pool.query(
      `insert into reward_ledger
        (user_id,enrollment_id,event_kind,reward_code,scope_key,mastery_evidence_id,
         xp_delta,coin_delta,policy_version,request_id,request_hash,reason,
         evidence_occurred_at,occurred_at)
       values ($1,$2,'grant','concept_mastery',$3,$4,60,0,$5,$6,$7,$8,$9,$10)`,
      [LEARNER, LEARNER_ENROLLMENT, `mastery:${LEARNER_ENROLLMENT}:${CONCEPT}:python`, MASTERY,
        "reward-ledger-2026-07.v1", "73000000-0000-4000-8000-000000000016", "e".repeat(64),
        "Assisted source evidence must never mint concept mastery XP.", evidence.rows[0]!.recorded_at,
        new Date("2026-07-06T05:00:00.000Z")],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(reconcileMasteryEvidenceReward({
      userId: LEARNER,
      masteryEvidenceId: MASTERY,
      requestId: "73000000-0000-4000-8000-000000000017",
      now: new Date("2026-07-06T05:00:00.000Z"),
    })).resolves.toMatchObject({ status: "unchanged", xpDelta: 0 });
  });

  it("attributes weekly/monthly challenges to evidence time across delayed backfill and DST", async () => {
    await reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000018",
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    await expect(loadRewardProgress(LEARNER, new Date("2026-07-14T12:01:00.000Z"))).resolves.toMatchObject({
      challenges: {
        weekly: { earnedXp: 0, qualifyingRewards: 0 },
        monthly: { earnedXp: 20, qualifyingRewards: 1 },
      },
    });
    const delayed = await pool.query<{ evidence_occurred_at: Date; occurred_at: Date }>(
      `select evidence_occurred_at,occurred_at from reward_ledger where user_id = $1 and event_kind = 'grant'`,
      [LEARNER],
    );
    expect(delayed.rows[0]!.evidence_occurred_at.toISOString()).toBe("2026-07-06T04:00:00.000Z");
    expect(delayed.rows[0]!.occurred_at.toISOString()).toBe("2026-07-14T12:00:00.000Z");

  });

  it("keeps learner-local challenge boundaries correct through a DST transition", async () => {
    await pool.query(`update "user" set timezone = 'America/New_York' where id = $1`, [LEARNER]);
    await pool.query(
      `update attempt set graded_at = $1 where id = $2`,
      [new Date("2026-03-08T06:30:00.000Z"), ATTEMPT_ONE],
    );
    await reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000019",
      now: new Date("2026-03-08T07:30:00.000Z"),
    });
    await expect(loadRewardProgress(LEARNER, new Date("2026-03-08T08:00:00.000Z"))).resolves.toMatchObject({
      challenges: { weekly: { period: { startLocalDate: "2026-03-02" }, earnedXp: 20 } },
    });
    await expect(loadRewardProgress(LEARNER, new Date("2026-03-09T05:00:00.000Z"))).resolves.toMatchObject({
      challenges: { weekly: { period: { startLocalDate: "2026-03-09" }, earnedXp: 0 } },
    });
  });

  it("allows explicit account-deletion authority to erase receipts before the ledger", async () => {
    await reconcileAttemptReward({
      userId: LEARNER,
      attemptId: ATTEMPT_ONE,
      requestId: "73000000-0000-4000-8000-000000000013",
    });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.account_deletion_authorized', '1', true)");
      await client.query("delete from reward_operation_receipt where user_id = $1", [LEARNER]);
      await client.query("delete from reward_ledger where user_id = $1", [LEARNER]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    expect((await pool.query(`select 1 from reward_ledger where user_id = $1`, [LEARNER])).rows).toEqual([]);
    expect((await pool.query(`select 1 from reward_operation_receipt where user_id = $1`, [LEARNER])).rows).toEqual([]);
  });
});
