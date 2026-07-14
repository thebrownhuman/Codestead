import { pool } from "@/lib/db/client";
import { RESULT_RESPONSE_KEY } from "@/lib/exams/constants";

import { ExamServiceError, finalizeExam } from "./service";
import { examFinalizationRetryDelayMs } from "./finalization-worker-policy";

export { examFinalizationRetryDelayMs } from "./finalization-worker-policy";

const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

interface ClaimedFinalization {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly attemptCount: number;
  readonly runnerRequestGeneration: number;
}

async function claimFinalizationJob(workerId: string, now: Date): Promise<ClaimedFinalization | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Existing installations may already have an active session when 0029 is
    // deployed. Backfill only recoverable sessions that lack official truth.
    await client.query(
      `insert into exam_finalization_job (exam_session_id,status,due_at,created_at,updated_at)
       select es.id,'scheduled',
              case when es.status = 'active' then es.server_deadline_at else least(es.updated_at + interval '2 minutes', $1) end,
              $1,$1
         from exam_session es
        where es.status in ('active','submitted','expired')
          and es.server_deadline_at is not null
          and not exists (select 1 from exam_finalization_job j where j.exam_session_id = es.id)
          and not exists (
            select 1 from response r where r.attempt_id = es.attempt_id and r.item_key = $2
          )
       on conflict (exam_session_id) do nothing`,
      [now, RESULT_RESPONSE_KEY],
    );
    await client.query(
      `update exam_finalization_job j
          set status = 'succeeded', lease_owner = null, lease_expires_at = null,
              completed_at = coalesce(j.completed_at,$1), last_error_code = null, updated_at = $1
         from exam_session es
        where es.id = j.exam_session_id and j.status <> 'succeeded'
          and exists (
            select 1 from response r where r.attempt_id = es.attempt_id and r.item_key = $2
          )`,
      [now, RESULT_RESPONSE_KEY],
    );
    await client.query(
      `update exam_finalization_job
          set status = 'scheduled', lease_owner = null, lease_expires_at = null, updated_at = $1
        where status = 'leased' and lease_expires_at <= $1`,
      [now],
    );
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const claimed = await client.query<{
      id: string; session_id: string; user_id: string; attempt_count: number; runner_request_generation: number;
    }>(
      `with candidate as (
         select j.id,es.id as session_id,es.user_id
           from exam_finalization_job j
           join exam_session es on es.id = j.exam_session_id
          where j.status in ('scheduled','failed') and j.due_at <= $1
            and j.runner_request_generation <= 10
            and not exists (
              select 1 from response r where r.attempt_id = es.attempt_id and r.item_key = $4
            )
            and (
              (es.status = 'active' and es.server_deadline_at <= $1)
              or (es.status in ('submitted','expired') and es.updated_at <= $1 - interval '2 minutes')
            )
          order by j.due_at,j.created_at,j.id
          for update of j skip locked
          limit 1
       )
       update exam_finalization_job j
          set status = 'leased', lease_owner = $2, lease_expires_at = $3,
              attempt_count = j.attempt_count + 1, last_error_code = null, updated_at = $1
         from candidate c where j.id = c.id
       returning j.id,c.session_id,c.user_id,j.attempt_count,j.runner_request_generation`,
      [now, workerId, leaseExpiresAt, RESULT_RESPONSE_KEY],
    );
    await client.query("commit");
    const row = claimed.rows[0];
    return row
      ? {
          id: row.id,
          sessionId: row.session_id,
          userId: row.user_id,
          attemptCount: row.attempt_count,
          runnerRequestGeneration: row.runner_request_generation,
        }
      : null;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileResultBearingJob(jobId: string, now: Date): Promise<boolean> {
  const reconciled = await pool.query(
    `update exam_finalization_job j
        set status = 'succeeded', lease_owner = null, lease_expires_at = null,
            completed_at = coalesce(j.completed_at,$2), last_error_code = null, updated_at = $2
       from exam_session es
      where j.id = $1 and es.id = j.exam_session_id
        and exists (
          select 1 from response r where r.attempt_id = es.attempt_id and r.item_key = $3
        )
      returning j.id`,
    [jobId, now, RESULT_RESPONSE_KEY],
  );
  return (reconciled.rowCount ?? 0) === 1;
}

async function completeClaim(job: ClaimedFinalization, workerId: string, now: Date): Promise<boolean> {
  const completed = await pool.query(
    `update exam_finalization_job
        set status = 'succeeded', lease_owner = null, lease_expires_at = null,
            completed_at = coalesce(completed_at,$4), last_error_code = null, updated_at = $4
      where id = $1 and status = 'leased' and lease_owner = $2 and attempt_count = $3
        and lease_expires_at > $4
      returning id`,
    [job.id, workerId, job.attemptCount, now],
  );
  if ((completed.rowCount ?? 0) === 1) return true;
  return reconcileResultBearingJob(job.id, now);
}

async function failOrRetry(
  job: ClaimedFinalization,
  workerId: string,
  errorCode: string,
  now: Date,
): Promise<"retried" | "failed" | "succeeded" | "lease-lost"> {
  if (await reconcileResultBearingJob(job.id, now)) return "succeeded";
  const indeterminate = errorCode === "RUNNER_INDETERMINATE";
  const nonRetryable = errorCode === "LEARNER_NOT_ACTIVE";
  const terminal = nonRetryable || (!indeterminate && job.runnerRequestGeneration >= MAX_ATTEMPTS);
  const dueAt = new Date(now.getTime() + examFinalizationRetryDelayMs(job.attemptCount));
  const updated = await pool.query(
    `update exam_finalization_job
        set status = $2, lease_owner = null, lease_expires_at = null,
            due_at = $3, last_error_code = $4, updated_at = $5,
            runner_request_generation = case when $8 then runner_request_generation
                                             else runner_request_generation + 1 end
      where id = $1 and status = 'leased' and lease_owner = $6 and attempt_count = $7
        and lease_expires_at > $5
      returning id`,
    [
      job.id,
      terminal ? "failed" : "scheduled",
      dueAt,
      errorCode.slice(0, 120),
      now,
      workerId,
      job.attemptCount,
      indeterminate,
    ],
  );
  if ((updated.rowCount ?? 0) === 1) return terminal ? "failed" : "retried";
  return await reconcileResultBearingJob(job.id, now) ? "succeeded" : "lease-lost";
}

export async function processExamFinalizationBatch(input: {
  readonly workerId: string;
  readonly limit?: number;
  readonly now?: Date;
  readonly clock?: () => Date;
}): Promise<{ readonly processed: number; readonly succeeded: number; readonly retried: number; readonly failed: number; readonly leaseLost: number }> {
  const limit = input.limit ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new RangeError("limit must be from 1 to 10");
  const now = input.now ?? new Date();
  const leaseClock = input.clock ?? (() => new Date());
  let processed = 0;
  let succeeded = 0;
  let retried = 0;
  let failed = 0;
  let leaseLost = 0;
  while (processed < limit) {
    const job = await claimFinalizationJob(input.workerId, now);
    if (!job) break;
    processed += 1;
    try {
      await finalizeExam(job.userId, job.sessionId, "deadline", now, {
        leaseFence: {
          jobId: job.id,
          owner: input.workerId,
          attemptCount: job.attemptCount,
          clock: leaseClock,
        },
      });
      if (await completeClaim(job, input.workerId, leaseClock())) succeeded += 1;
      else leaseLost += 1;
    } catch (error) {
      const code = error instanceof ExamServiceError ? error.code
        : error instanceof Error ? error.name
          : "UNKNOWN_FINALIZATION_ERROR";
      const disposition = await failOrRetry(job, input.workerId, code, leaseClock());
      if (disposition === "succeeded") succeeded += 1;
      else if (disposition === "failed") failed += 1;
      else if (disposition === "retried") retried += 1;
      else leaseLost += 1;
    }
  }
  return { processed, succeeded, retried, failed, leaseLost };
}
