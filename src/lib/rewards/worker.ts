import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { deterministicUuid } from "@/lib/learning-service/ids";

import {
  reconcileAttemptReward,
  reconcileMasteryEvidenceReward,
  type RewardReconciliationResult,
} from "./service";

type RewardJobOperation = "reconcile_attempt" | "reconcile_mastery";

type ClaimedRewardJob = Readonly<{
  id: string;
  userId: string;
  operation: RewardJobOperation;
  attemptId: string | null;
  masteryEvidenceId: string | null;
  generation: number;
  attemptCount: number;
  leaseToken: string;
}>;

export type RewardWorkerReport = Readonly<{
  processed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  superseded: number;
  replayed: number;
}>;

const MAX_BATCH_SIZE = 100;
const LEASE_MILLISECONDS = 5 * 60_000;
export const MAX_REWARD_RECONCILIATION_ATTEMPTS = 8;

function assertWorkerInput(limit: number, now: Date) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new RangeError(`Reward worker limit must be an integer from 1 to ${MAX_BATCH_SIZE}.`);
  }
  if (!Number.isFinite(now.getTime())) throw new RangeError("Reward worker requires a valid timestamp.");
}

async function claimRewardJobs(
  client: PoolClient,
  input: { limit: number; now: Date; leaseToken: string },
): Promise<readonly ClaimedRewardJob[]> {
  const leaseExpiresAt = new Date(input.now.getTime() + LEASE_MILLISECONDS);
  const claimed = await client.query<{
    id: string;
    user_id: string;
    operation: RewardJobOperation;
    attempt_id: string | null;
    mastery_evidence_id: string | null;
    generation: number;
    attempt_count: number;
    lease_token: string;
  }>(
    `with candidates as (
       select job.id
         from reward_reconciliation_job job
        where (job.status = 'pending' and job.next_attempt_at <= $1)
           or (job.status = 'running' and job.lease_expires_at <= $1)
        order by job.next_attempt_at, job.updated_at, job.id
        for update of job skip locked
        limit $2
     )
     update reward_reconciliation_job job
        set status = 'running', attempt_count = job.attempt_count + 1,
            lease_token = $3, lease_expires_at = $4, updated_at = $1
       from candidates
      where job.id = candidates.id
      returning job.id,job.user_id,job.operation,job.attempt_id,
                job.mastery_evidence_id,job.generation,job.attempt_count,job.lease_token`,
    [input.now, input.limit, input.leaseToken, leaseExpiresAt],
  );
  return claimed.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    operation: row.operation,
    attemptId: row.attempt_id,
    masteryEvidenceId: row.mastery_evidence_id,
    generation: row.generation,
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
  }));
}

async function claimBatch(input: { limit: number; now: Date; leaseToken: string }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const jobs = await claimRewardJobs(client, input);
    await client.query("commit");
    return jobs;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function requestIdFor(job: ClaimedRewardJob) {
  return deterministicUuid(
    "reward-reconciliation-job",
    `${job.id}:${job.generation}:${job.operation}`,
  );
}

async function reconcileJob(job: ClaimedRewardJob, now: Date): Promise<RewardReconciliationResult> {
  const requestId = requestIdFor(job);
  if (job.operation === "reconcile_attempt" && job.attemptId) {
    return reconcileAttemptReward({ userId: job.userId, attemptId: job.attemptId, requestId, now });
  }
  if (job.operation === "reconcile_mastery" && job.masteryEvidenceId) {
    return reconcileMasteryEvidenceReward({
      userId: job.userId,
      masteryEvidenceId: job.masteryEvidenceId,
      requestId,
      now,
    });
  }
  throw new Error("REWARD_JOB_EVIDENCE_SHAPE_INVALID");
}

async function completeJob(job: ClaimedRewardJob, now: Date) {
  const completed = await pool.query(
    `update reward_reconciliation_job
        set status = 'complete', lease_token = null, lease_expires_at = null,
            last_error_code = null, updated_at = $1
      where id = $2 and generation = $3 and status = 'running' and lease_token = $4`,
    [now, job.id, job.generation, job.leaseToken],
  );
  return completed.rowCount === 1;
}

async function requeueRewardScope(job: ClaimedRewardJob, now: Date) {
  if (job.operation === "reconcile_attempt" && job.attemptId) {
    await pool.query("select enqueue_reward_jobs_for_attempt_v1($1,$2,$3)", [
      job.attemptId,
      job.userId,
      now,
    ]);
    return;
  }
  if (job.operation === "reconcile_mastery" && job.masteryEvidenceId) {
    await pool.query("select enqueue_reward_jobs_for_mastery_scope_v1($1,$2,$3)", [
      job.masteryEvidenceId,
      job.userId,
      now,
    ]);
    return;
  }
  throw new Error("REWARD_JOB_EVIDENCE_SHAPE_INVALID");
}

function safeErrorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120);
  }
  return error instanceof Error
    ? error.name.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120)
    : "UNKNOWN";
}

async function retryJob(job: ClaimedRewardJob, now: Date, error: unknown) {
  const delaySeconds = Math.min(3_600, 5 * (2 ** Math.min(job.attemptCount - 1, 9)));
  const retryAt = new Date(now.getTime() + delaySeconds * 1_000);
  const retried = await pool.query(
    `update reward_reconciliation_job
        set status = 'pending', lease_token = null, lease_expires_at = null,
            next_attempt_at = $1, last_error_code = $2, updated_at = $3
      where id = $4 and generation = $5 and status = 'running' and lease_token = $6`,
    [retryAt, safeErrorCode(error), now, job.id, job.generation, job.leaseToken],
  );
  return retried.rowCount === 1;
}

async function deadLetterJob(job: ClaimedRewardJob, now: Date, error: unknown) {
  const notificationId = deterministicUuid(
    "reward-reconciliation-dead-letter",
    `${job.id}:${job.generation}`,
  );
  const result = await pool.query<{ dead_lettered: number; signaled: number }>(
    `with dead_lettered as (
       update reward_reconciliation_job
          set status = 'dead_letter', lease_token = null, lease_expires_at = null,
              last_error_code = $1, updated_at = $2
        where id = $3 and generation = $4 and status = 'running' and lease_token = $5
        returning id
     ), admin_target as (
       select id from "user"
        where role = 'admin' and status = 'active'
        order by created_at, id
        limit 1
     ), signal as (
       insert into notification (id,user_id,type,title,body,action_url,created_at)
       select $6,admin_target.id,'reward-reconciliation-dead-letter',
              'Reward reconciliation needs review',
              'A durable reward job exhausted its bounded retry budget. No reward value was guessed.',
              '/admin', $2
         from dead_lettered cross join admin_target
       on conflict (id) do nothing
       returning id
     )
     select (select count(*)::int from dead_lettered) dead_lettered,
            (select count(*)::int from signal) signaled`,
    [safeErrorCode(error), now, job.id, job.generation, job.leaseToken, notificationId],
  );
  return (result.rows[0]?.dead_lettered ?? 0) === 1;
}

/**
 * Claims and reconciles at most `limit` jobs. Generation fencing guarantees a
 * source update that races a worker remains pending, while the deterministic
 * per-generation request id makes lease recovery an exact idempotent replay.
 */
export async function processRewardReconciliationBatch(input: {
  limit?: number;
  now?: Date;
} = {}): Promise<RewardWorkerReport> {
  const limit = input.limit ?? 20;
  const now = input.now ?? new Date();
  assertWorkerInput(limit, now);
  const jobs = await claimBatch({ limit, now, leaseToken: randomUUID() });
  let succeeded = 0;
  let failed = 0;
  let deadLettered = 0;
  let superseded = 0;
  let replayed = 0;
  for (const job of jobs) {
    try {
      const result = await reconcileJob(job, now);
      if (result.replayed) replayed += 1;
      // A revocation may expose another already-finalized evidence row in the
      // same anti-farming scope. Re-open that whole scope before completing
      // this generation so replacement truth is discovered on the next pass.
      if (result.status === "revoked") await requeueRewardScope(job, now);
      if (await completeJob(job, now)) succeeded += 1;
      else superseded += 1;
    } catch (error) {
      if (job.attemptCount >= MAX_REWARD_RECONCILIATION_ATTEMPTS) {
        if (await deadLetterJob(job, now, error)) deadLettered += 1;
        else superseded += 1;
      } else if (await retryJob(job, now, error)) failed += 1;
      else superseded += 1;
    }
  }
  return { processed: jobs.length, succeeded, failed, deadLettered, superseded, replayed };
}
