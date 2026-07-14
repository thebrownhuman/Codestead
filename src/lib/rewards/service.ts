import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";

import {
  CHALLENGE_POLICY_VERSION,
  COINS_ENABLED,
  COIN_POLICY_NOTE,
  REWARD_POLICY_VERSION,
  challengePeriod,
  deriveAttemptReward,
  deriveChallengeProgress,
  deriveLevel,
  deriveMasteryReward,
  type ChallengeKind,
  type RewardDecision,
  type RewardableAttemptKind,
} from "./policy";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RewardOperation = "reconcile_attempt" | "reconcile_mastery";
export type RewardReconciliationStatus = "granted" | "revoked" | "unchanged";

export type RewardReconciliationResult = Readonly<{
  status: RewardReconciliationStatus;
  eventId: string | null;
  xpDelta: number;
  coinDelta: 0;
  reason: string;
  policyVersion: string;
  replayed: boolean;
}>;

type EvidenceReference = Readonly<{
  enrollmentId: string;
  attemptId: string | null;
  masteryEvidenceId: string | null;
  evidenceOccurredAt: Date;
}>;

type ActiveGrant = EvidenceReference & Readonly<{
  id: string;
  rewardCode: string;
  scopeKey: string;
  xpDelta: number;
  coinDelta: number;
  policyVersion: string;
}>;

export class RewardServiceError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "EVIDENCE_NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "CORRUPT_LEDGER") {
    super(code);
    this.name = "RewardServiceError";
  }
}

function assertUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new RewardServiceError("INVALID_INPUT");
}

function operationHash(operation: RewardOperation, userId: string, evidenceId: string) {
  return createHash("sha256")
    .update(JSON.stringify({ operation, userId, evidenceId, policyVersion: REWARD_POLICY_VERSION }))
    .digest("hex");
}

function parseReceiptResult(value: unknown): Omit<RewardReconciliationResult, "replayed"> {
  if (!value || typeof value !== "object") throw new RewardServiceError("CORRUPT_LEDGER");
  const candidate = value as Record<string, unknown>;
  if (
    !["granted", "revoked", "unchanged"].includes(String(candidate.status))
    || !(candidate.eventId === null || typeof candidate.eventId === "string")
    || !Number.isInteger(candidate.xpDelta)
    || candidate.coinDelta !== 0
    || typeof candidate.reason !== "string"
    || typeof candidate.policyVersion !== "string"
  ) throw new RewardServiceError("CORRUPT_LEDGER");
  return candidate as Omit<RewardReconciliationResult, "replayed">;
}

async function replayReceipt(
  client: PoolClient,
  userId: string,
  requestId: string,
  inputHash: string,
): Promise<RewardReconciliationResult | null> {
  const receipt = await client.query<{ input_hash: string; result: unknown }>(
    `select input_hash,result from reward_operation_receipt
      where user_id = $1 and request_id = $2 for update`,
    [userId, requestId],
  );
  const row = receipt.rows[0];
  if (!row) return null;
  if (row.input_hash !== inputHash) throw new RewardServiceError("IDEMPOTENCY_CONFLICT");
  return { ...parseReceiptResult(row.result), replayed: true };
}

async function activeGrantForScope(client: PoolClient, userId: string, scopeKey: string) {
  const result = await client.query<{
    id: string;
    reward_code: string;
    scope_key: string;
    enrollment_id: string;
    attempt_id: string | null;
    mastery_evidence_id: string | null;
    xp_delta: number;
    coin_delta: number;
    policy_version: string;
    evidence_occurred_at: Date;
  }>(
    `select g.id,g.reward_code,g.scope_key,g.enrollment_id,g.attempt_id,
            g.mastery_evidence_id,g.xp_delta,g.coin_delta,g.policy_version,
            g.evidence_occurred_at
       from reward_ledger g
      where g.user_id = $1 and g.scope_key = $2 and g.event_kind = 'grant'
        and not exists (select 1 from reward_ledger r where r.source_event_id = g.id)
      order by g.occurred_at,g.id
      limit 1 for update`,
    [userId, scopeKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    rewardCode: row.reward_code,
    scopeKey: row.scope_key,
    enrollmentId: row.enrollment_id,
    attemptId: row.attempt_id,
    masteryEvidenceId: row.mastery_evidence_id,
    xpDelta: row.xp_delta,
    coinDelta: row.coin_delta,
    policyVersion: row.policy_version,
    evidenceOccurredAt: row.evidence_occurred_at,
  } satisfies ActiveGrant;
}

async function persistReceipt(
  client: PoolClient,
  input: {
    userId: string;
    requestId: string;
    operation: RewardOperation;
    inputHash: string;
    eventId: string | null;
    result: Omit<RewardReconciliationResult, "replayed">;
    now: Date;
  },
) {
  await client.query(
    `insert into reward_operation_receipt
      (user_id,request_id,operation,input_hash,event_id,result,created_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      input.userId,
      input.requestId,
      input.operation,
      input.inputHash,
      input.eventId,
      JSON.stringify(input.result),
      input.now,
    ],
  );
}

async function reconcileDecision(
  client: PoolClient,
  input: {
    userId: string;
    requestId: string;
    operation: RewardOperation;
    inputHash: string;
    evidence: EvidenceReference;
    decision: RewardDecision;
    now: Date;
  },
): Promise<RewardReconciliationResult> {
  if (input.evidence.evidenceOccurredAt.getTime() > input.now.getTime()) {
    throw new RewardServiceError("INVALID_INPUT");
  }
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `reward-scope:${input.userId}:${input.decision.scopeKey}`,
  ]);
  const active = await activeGrantForScope(client, input.userId, input.decision.scopeKey);
  const activeComesFromThisEvidence = active !== null
    && active.attemptId === input.evidence.attemptId
    && active.masteryEvidenceId === input.evidence.masteryEvidenceId;
  let result: Omit<RewardReconciliationResult, "replayed">;
  if (input.decision.eligible && !active) {
    const inserted = await client.query<{ id: string }>(
      `insert into reward_ledger
        (user_id,enrollment_id,event_kind,reward_code,scope_key,attempt_id,mastery_evidence_id,
         source_event_id,xp_delta,coin_delta,policy_version,request_id,request_hash,reason,
         evidence_occurred_at,occurred_at)
       values ($1,$2,'grant',$3,$4,$5,$6,null,$7,0,$8,$9,$10,$11,$12,$13)
       returning id`,
      [
        input.userId,
        input.evidence.enrollmentId,
        input.decision.rewardCode,
        input.decision.scopeKey,
        input.evidence.attemptId,
        input.evidence.masteryEvidenceId,
        input.decision.xp,
        input.decision.policyVersion,
        input.requestId,
        input.inputHash,
        input.decision.reason,
        input.evidence.evidenceOccurredAt,
        input.now,
      ],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) throw new RewardServiceError("CORRUPT_LEDGER");
    result = {
      status: "granted",
      eventId,
      xpDelta: input.decision.xp,
      coinDelta: 0,
      reason: input.decision.reason,
      policyVersion: input.decision.policyVersion,
    };
  } else if (!input.decision.eligible && active && activeComesFromThisEvidence) {
    const inserted = await client.query<{ id: string }>(
      `insert into reward_ledger
        (user_id,enrollment_id,event_kind,reward_code,scope_key,attempt_id,mastery_evidence_id,
         source_event_id,xp_delta,coin_delta,policy_version,request_id,request_hash,reason,
         evidence_occurred_at,occurred_at)
       values ($1,$2,'revocation',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       returning id`,
      [
        input.userId,
        active.enrollmentId,
        active.rewardCode,
        active.scopeKey,
        active.attemptId,
        active.masteryEvidenceId,
        active.id,
        -active.xpDelta,
        -active.coinDelta,
        active.policyVersion,
        input.requestId,
        input.inputHash,
        `Revoked after authoritative evidence reconciliation: ${input.decision.reason}`,
        active.evidenceOccurredAt,
        input.now,
      ],
    );
    const eventId = inserted.rows[0]?.id;
    if (!eventId) throw new RewardServiceError("CORRUPT_LEDGER");
    result = {
      status: "revoked",
      eventId,
      xpDelta: -active.xpDelta,
      coinDelta: 0,
      reason: `Revoked after authoritative evidence reconciliation: ${input.decision.reason}`,
      policyVersion: active.policyVersion,
    };
  } else {
    result = {
      status: "unchanged",
      eventId: null,
      xpDelta: 0,
      coinDelta: 0,
      reason: input.decision.eligible
        ? "This reward scope already has one active grant; replay cannot farm another reward."
        : active && !activeComesFromThisEvidence
          ? "This evidence is ineligible, but it cannot revoke another qualifying source in the same reward scope."
        : input.decision.reason,
      policyVersion: input.decision.policyVersion,
    };
  }
  await persistReceipt(client, { ...input, eventId: result.eventId, result });
  return { ...result, replayed: false };
}

async function inSerializableTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level serializable");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileAttemptReward(input: {
  userId: string;
  attemptId: string;
  requestId: string;
  now?: Date;
}): Promise<RewardReconciliationResult> {
  assertUuid(input.attemptId);
  assertUuid(input.requestId);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || input.userId.length < 1) throw new RewardServiceError("INVALID_INPUT");
  const operation: RewardOperation = "reconcile_attempt";
  const inputHash = operationHash(operation, input.userId, input.attemptId);
  return inSerializableTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(input.userId)]);
    const replay = await replayReceipt(client, input.userId, input.requestId, inputHash);
    if (replay) return replay;
    const evidence = await client.query<{
      enrollment_id: string;
      kind: RewardableAttemptKind;
      status: string;
      passed: boolean | null;
      mastery_awarded: boolean | null;
      infrastructure_failure: boolean;
      assistance_level: string;
      solution_revealed: boolean;
      activity_id: string | null;
      content_version: string;
      effective_result: Record<string, unknown> | null;
      evidence_occurred_at: Date | null;
    }>(
      `select a.enrollment_id,a.kind::text,a.status::text,a.passed,a.mastery_awarded,
              a.infrastructure_failure,a.assistance_level,a.solution_revealed,a.activity_id,
              a.content_version,er.result effective_result,
              case when er.attempt_id is not null then er.updated_at else a.graded_at end evidence_occurred_at
         from attempt a
         join enrollment e on e.id = a.enrollment_id and e.user_id = a.user_id
         join "user" u on u.id = a.user_id and u.status = 'active'
         left join assessment_attempt_effective_result er
           on er.attempt_id = a.id and er.user_id = a.user_id
        where a.id = $2 and a.user_id = $1
        for update of a`,
      [input.userId, input.attemptId],
    );
    const row = evidence.rows[0];
    if (!row) throw new RewardServiceError("EVIDENCE_NOT_FOUND");
    const decision = deriveAttemptReward({
      kind: row.kind,
      status: row.status,
      passed: row.passed,
      masteryAwarded: row.mastery_awarded,
      infrastructureFailure: row.infrastructure_failure,
      assistanceLevel: row.assistance_level,
      solutionRevealed: row.solution_revealed,
      activityId: row.activity_id,
      contentVersion: row.content_version,
      evidenceOccurredAt: row.evidence_occurred_at,
      effectiveResult: row.effective_result,
    });
    return reconcileDecision(client, {
      userId: input.userId,
      requestId: input.requestId,
      operation,
      inputHash,
      evidence: {
        enrollmentId: row.enrollment_id,
        attemptId: input.attemptId,
        masteryEvidenceId: null,
        evidenceOccurredAt: row.evidence_occurred_at ?? now,
      },
      decision,
      now,
    });
  });
}

export async function reconcileMasteryEvidenceReward(input: {
  userId: string;
  masteryEvidenceId: string;
  requestId: string;
  now?: Date;
}): Promise<RewardReconciliationResult> {
  assertUuid(input.masteryEvidenceId);
  assertUuid(input.requestId);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || input.userId.length < 1) throw new RewardServiceError("INVALID_INPUT");
  const operation: RewardOperation = "reconcile_mastery";
  const inputHash = operationHash(operation, input.userId, input.masteryEvidenceId);
  return inSerializableTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(input.userId)]);
    const replay = await replayReceipt(client, input.userId, input.requestId, inputHash);
    if (replay) return replay;
    const evidence = await client.query<{
      enrollment_id: string;
      concept_id: string;
      language_context: string;
      validity: string;
      score: number;
      weight: number;
      recorded_by: string | null;
      source_type: string;
      recorded_at: Date;
      source_attempt_id: string | null;
      source_attempt_status: string | null;
      source_attempt_passed: boolean | null;
      source_attempt_mastery_awarded: boolean | null;
      source_attempt_infrastructure_failure: boolean | null;
      source_attempt_assistance_level: string | null;
      source_attempt_solution_revealed: boolean | null;
      source_attempt_concept_bound: boolean;
      source_attempt_effective_result: Record<string, unknown> | null;
    }>(
      `select m.enrollment_id,m.concept_id,m.language_context,m.validity,m.score,m.weight,m.recorded_by,
              m.source_type,m.recorded_at,source_attempt.id source_attempt_id,
              source_attempt.status::text source_attempt_status,
              source_attempt.passed source_attempt_passed,
              source_attempt.mastery_awarded source_attempt_mastery_awarded,
              source_attempt.infrastructure_failure source_attempt_infrastructure_failure,
              source_attempt.assistance_level source_attempt_assistance_level,
              source_attempt.solution_revealed source_attempt_solution_revealed,
              coalesce(source_activity.concept_id = m.concept_id
                or (repair.projection_evidence_id = m.id and repair.concept_id = m.concept_id
                  and repair.status = 'applied'), false) source_attempt_concept_bound,
              source_effective.result source_attempt_effective_result
         from mastery_evidence m
         join enrollment e on e.id = m.enrollment_id and e.user_id = m.user_id
         join "user" u on u.id = m.user_id and u.status = 'active'
         left join assessment_mastery_projection_repair repair
           on repair.projection_evidence_id = m.id and repair.user_id = m.user_id
         left join attempt source_attempt
           on source_attempt.id = case
             when m.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               then m.source_id::uuid
             else repair.attempt_id
           end
          and source_attempt.user_id = m.user_id
          and source_attempt.enrollment_id = m.enrollment_id
         left join activity source_activity on source_activity.id = source_attempt.activity_id
         left join assessment_attempt_effective_result source_effective
           on source_effective.attempt_id = source_attempt.id
          and source_effective.user_id = source_attempt.user_id
        where m.id = $2 and m.user_id = $1
        for update of m`,
      [input.userId, input.masteryEvidenceId],
    );
    const row = evidence.rows[0];
    if (!row) throw new RewardServiceError("EVIDENCE_NOT_FOUND");
    const decision = deriveMasteryReward({
      enrollmentId: row.enrollment_id,
      conceptId: row.concept_id,
      languageContext: row.language_context,
      validity: row.validity,
      score: row.score,
      weight: row.weight,
      recordedBy: row.recorded_by,
      sourceType: row.source_type,
      sourceAttemptId: row.source_attempt_id,
      sourceAttemptStatus: row.source_attempt_status,
      sourceAttemptPassed: row.source_attempt_passed,
      sourceAttemptMasteryAwarded: row.source_attempt_mastery_awarded,
      sourceAttemptInfrastructureFailure: row.source_attempt_infrastructure_failure,
      sourceAttemptAssistanceLevel: row.source_attempt_assistance_level,
      sourceAttemptSolutionRevealed: row.source_attempt_solution_revealed,
      sourceAttemptConceptBound: row.source_attempt_concept_bound,
      sourceAttemptEffectiveResult: row.source_attempt_effective_result,
    });
    return reconcileDecision(client, {
      userId: input.userId,
      requestId: input.requestId,
      operation,
      inputHash,
      evidence: {
        enrollmentId: row.enrollment_id,
        attemptId: null,
        masteryEvidenceId: input.masteryEvidenceId,
        evidenceOccurredAt: row.recorded_at,
      },
      decision,
      now,
    });
  });
}

async function periodTotals(
  client: PoolClient,
  userId: string,
  kind: ChallengeKind,
  now: Date,
  timezone: string,
) {
  const period = challengePeriod(kind, now, timezone);
  const totals = await client.query<{ earned_xp: number; qualifying_rewards: number }>(
    `select
       coalesce(sum(case when reversal.id is null then grant_event.xp_delta else 0 end),0)::int earned_xp,
       count(*) filter (where reversal.id is null)::int qualifying_rewards
     from reward_ledger grant_event
     left join reward_ledger reversal on reversal.source_event_id = grant_event.id
     where grant_event.user_id = $1 and grant_event.event_kind = 'grant'
       and grant_event.evidence_occurred_at >= ($2::date::timestamp at time zone $4)
       and grant_event.evidence_occurred_at < ($3::date::timestamp at time zone $4)`,
    [userId, period.startLocalDate, period.endLocalDateExclusive, period.timezone],
  );
  const row = totals.rows[0] ?? { earned_xp: 0, qualifying_rewards: 0 };
  return deriveChallengeProgress({
    kind,
    period,
    earnedXp: row.earned_xp,
    qualifyingRewards: row.qualifying_rewards,
  });
}

export async function loadRewardProgress(userId: string, now = new Date()) {
  if (!Number.isFinite(now.getTime()) || userId.length < 1) throw new RewardServiceError("INVALID_INPUT");
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const owner = await client.query<{ timezone: string }>(
      `select timezone from "user" where id = $1 and status = 'active'`,
      [userId],
    );
    if (!owner.rows[0]) throw new RewardServiceError("EVIDENCE_NOT_FOUND");
    const balance = await client.query<{ total_xp: number; coin_balance: number; event_count: number }>(
      `select coalesce(sum(xp_delta),0)::int total_xp,
              coalesce(sum(coin_delta),0)::int coin_balance,
              count(*)::int event_count
         from reward_ledger where user_id = $1`,
      [userId],
    );
    const totals = balance.rows[0] ?? { total_xp: 0, coin_balance: 0, event_count: 0 };
    if (totals.total_xp < 0 || totals.coin_balance !== 0) throw new RewardServiceError("CORRUPT_LEDGER");
    // A node-postgres client owns one connection. Keep its read-only snapshot
    // queries sequential instead of pretending the wire can run in parallel.
    const weekly = await periodTotals(client, userId, "weekly", now, owner.rows[0].timezone);
    const monthly = await periodTotals(client, userId, "monthly", now, owner.rows[0].timezone);
    await client.query("commit");
    return {
      rewardPolicyVersion: REWARD_POLICY_VERSION,
      challengePolicyVersion: CHALLENGE_POLICY_VERSION,
      totalXp: totals.total_xp,
      level: deriveLevel(totals.total_xp),
      coins: {
        enabled: COINS_ENABLED,
        balance: 0 as const,
        policyNote: COIN_POLICY_NOTE,
      },
      eventCount: totals.event_count,
      challenges: { weekly, monthly },
    } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
