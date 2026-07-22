import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";

import {
  beginRunnerDispatch,
  recordRunnerDispatch,
  refreshRunnerAdmission,
  RunnerAdmissionError,
  settleRunnerJob,
  type RunnerAdmission,
} from "./admission";
import {
  configuredRunnerClient,
  RunnerIndeterminateError,
  type RunnerClient,
} from "./client";
import {
  PracticeDispatchSnapshotError,
  validatePracticeDispatchSnapshot,
} from "./practice-dispatch";

export const PRACTICE_RECOVERY_STALE_MS = 2 * 60_000;

type ActiveStatus = "queued" | "leased" | "running";

type RecoveryRow = Readonly<{
  runner_job_id: string;
  submission_id: string;
  user_id: string;
  request_id: string;
  request_hash: string;
  submission_type: string;
  submission_status: string;
  job_status: string;
  runtime_image_digest: string;
  source_code: string;
  source_hash: string;
  language: string;
  remote_job_id: string | null;
  result: Record<string, unknown> | null;
  limits: Record<string, number>;
  dispatch_request: Record<string, unknown>;
  recovery_state: "ready" | "retry_wait" | "quarantined";
  recovery_attempt_count: number;
  recovery_next_attempt_at: Date | null;
  queued_at: Date;
}>;

export type PracticeRecoveryRunner = Pick<RunnerClient, "submit" | "waitForJob" | "waitFrom">;

export type PracticeRecoveryReport = Readonly<{
  cancelledUndispatched: number;
  processed: number;
  reconciled: number;
  indeterminate: number;
  corrupt: number;
  skipped: number;
}>;

type RecoveryOutcome = "reconciled" | "indeterminate" | "corrupt" | "skipped";

function activeStatus(value: string): value is ActiveStatus {
  return value === "queued" || value === "leased" || value === "running";
}

async function loadRecoveryRow(client: PoolClient, jobId: string): Promise<RecoveryRow | null> {
  const result = await client.query<RecoveryRow>(
    `select j.id runner_job_id, s.id submission_id, s.user_id, s.request_id,
            s.request_hash, s.submission_type, s.status submission_status,
            j.status job_status, s.runtime_image_digest, s.source_code,
            s.source_hash, s.language, j.lease_owner remote_job_id, j.result,
            j.limits, j.dispatch_request, j.queued_at
            ,j.recovery_state,j.recovery_attempt_count,j.recovery_next_attempt_at
       from runner_job j
       join code_submission s on s.id = j.submission_id
      where j.id = $1
        and s.submission_type in ('server_compile','server_run')
        and (s.status in ('queued','leased','running') or j.status in ('queued','leased','running'))
        and j.dispatch_request is not null
        and not exists (
          select 1 from runner_power_rehearsal_event rehearsal
           where rehearsal.state in ('armed','filled')
             and (rehearsal.slot_one_runner_job_id = j.id
               or rehearsal.slot_two_runner_job_id = j.id)
        )
        and j.recovery_state in ('ready','retry_wait','quarantined')`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.submission_status !== row.job_status) throw new PracticeDispatchSnapshotError("SNAPSHOT_BINDING_MISMATCH");
  if (!activeStatus(row.submission_status) || !activeStatus(row.job_status)) return null;
  return row as RecoveryRow & { submission_status: ActiveStatus; job_status: ActiveStatus };
}

function retryDelayMs(attempt: number) {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8));
}

async function recordRecoveryDisposition(
  client: PoolClient,
  jobId: string,
  outcome: RecoveryOutcome,
  now: Date,
) {
  if (outcome === "corrupt") {
    await client.query(
      `update runner_job
          set recovery_state = 'quarantined',
              recovery_attempt_count = least(recovery_attempt_count + 1, 2147483647),
              recovery_next_attempt_at = null,
              recovery_last_error_code = 'PRACTICE_DISPATCH_SNAPSHOT_INVALID'
        where id = $1 and recovery_state in ('ready','retry_wait','quarantined')`,
      [jobId],
    );
  } else if (outcome === "indeterminate") {
    const current = await client.query<{ recovery_attempt_count: number }>(
      `select recovery_attempt_count from runner_job where id = $1 for update`,
      [jobId],
    );
    const attempt = Math.min((current.rows[0]?.recovery_attempt_count ?? 0) + 1, 2_147_483_647);
    await client.query(
      `update runner_job
          set recovery_state = 'retry_wait', recovery_attempt_count = $2,
              recovery_next_attempt_at = $3,
              recovery_last_error_code = 'PRACTICE_RUNNER_INDETERMINATE'
        where id = $1 and status in ('queued','leased','running')`,
      [jobId, attempt, new Date(now.getTime() + retryDelayMs(attempt))],
    );
  }
}

function admissionFrom(row: RecoveryRow): RunnerAdmission {
  return {
    submissionId: row.submission_id,
    runnerJobId: row.runner_job_id,
    userId: row.user_id,
    requestId: row.request_id,
    requestHash: row.request_hash,
    submissionType: row.submission_type,
    status: row.submission_status as ActiveStatus,
    remoteJobId: row.remote_job_id,
    result: row.result,
    runtimeImageDigest: row.runtime_image_digest,
    queuedAt: row.queued_at,
    duplicate: true,
  };
}

async function reconcileRow(input: {
  row: RecoveryRow;
  runner: PracticeRecoveryRunner;
  clock: () => Date;
}): Promise<RecoveryOutcome> {
  const { row, runner, clock } = input;
  let request;
  try {
    request = validatePracticeDispatchSnapshot({
      snapshot: row.dispatch_request,
      submissionId: row.submission_id,
      userId: row.user_id,
      requestId: row.request_id,
      requestHash: row.request_hash,
      submissionType: row.submission_type,
      language: row.language,
      sourceCode: row.source_code,
      sourceHash: row.source_hash,
    });
  } catch (error) {
    if (error instanceof PracticeDispatchSnapshotError) return "corrupt";
    throw error;
  }
  const admission = admissionFrom(row);
  // A persisted leased/running row is exactly the crash ambiguity: POST may
  // have happened even when no remote id made it back into PostgreSQL.
  let remoteBoundaryCrossed = row.job_status !== "queued" || row.remote_job_id !== null;
  try {
    const boundary = await beginRunnerDispatch({
      admission,
      dispatchRequest: request,
      now: clock(),
    });
    if (boundary.replayed) return "reconciled";
    const submitted = boundary.remoteJobId
      ? await runner.waitForJob(boundary.remoteJobId, request)
      : await runner.submit(request, admission.requestId);
    remoteBoundaryCrossed = true;
    if (!boundary.remoteJobId && submitted.state !== "FAILED") {
      const dispatch = await recordRunnerDispatch({
        admission,
        remoteJobId: submitted.jobId,
        status: submitted.state === "QUEUED" ? "queued" : "running",
        now: clock(),
      });
      if (dispatch.replayed) {
        await refreshRunnerAdmission(admission);
        return "reconciled";
      }
    }
    const completed = !boundary.remoteJobId
      && (submitted.state === "QUEUED" || submitted.state === "RUNNING")
      ? await runner.waitFrom(submitted, request)
      : submitted;
    const result = completed.result;
    await settleRunnerJob({
      admission,
      status: completed.state === "COMPLETED" && result ? "succeeded" : "failed",
      runtimeImageDigest: result?.imageDigest ?? "runner-infrastructure-error",
      result: result ?? { error: completed.error?.code ?? "UNKNOWN" },
      remoteJobId: completed.jobId,
      completedAt: clock(),
    });
    return "reconciled";
  } catch (error) {
    if (
      remoteBoundaryCrossed
      || error instanceof RunnerIndeterminateError
      || error instanceof RunnerAdmissionError
    ) return "indeterminate";
    // This branch is reachable only for a pre-dispatch local/configuration
    // failure. The persisted crash boundary normally makes recovery errors
    // indeterminate and therefore non-terminal.
    return "indeterminate";
  }
}

async function processOne(input: {
  jobId: string;
  runner: PracticeRecoveryRunner;
  clock: () => Date;
}): Promise<RecoveryOutcome> {
  const guard = await pool.connect();
  const lockName = `practice-runner-recovery:${input.jobId}`;
  let locked = false;
  try {
    const acquired = await guard.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) acquired",
      [lockName],
    );
    locked = acquired.rows[0]?.acquired === true;
    if (!locked) return "skipped";
    let row: RecoveryRow | null;
    try {
      row = await loadRecoveryRow(guard, input.jobId);
    } catch (error) {
      if (error instanceof PracticeDispatchSnapshotError) {
        await recordRecoveryDisposition(guard, input.jobId, "corrupt", input.clock());
        return "corrupt";
      }
      throw error;
    }
    if (!row) return "skipped";
    const outcome = await reconcileRow({ row, runner: input.runner, clock: input.clock });
    await recordRecoveryDisposition(guard, input.jobId, outcome, input.clock());
    return outcome;
  } finally {
    if (locked) {
      await guard.query("select pg_advisory_unlock(hashtext($1))", [lockName]).catch(() => undefined);
    }
    guard.release();
  }
}

export async function processPracticeRunnerRecoveryBatch(input: {
  limit?: number;
  now?: Date;
  clock?: () => Date;
  runner?: PracticeRecoveryRunner;
} = {}): Promise<PracticeRecoveryReport> {
  const limit = input.limit ?? 2;
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !Number.isFinite(now.getTime())) {
    throw new Error("Practice recovery requires a valid timestamp and a limit from 1 to 10.");
  }
  const staleCutoff = new Date(now.getTime() - PRACTICE_RECOVERY_STALE_MS);
  const undispatched = await pool.query<{ submission_id: string }>(
    `with stale as (
       select s.id submission_id,j.id runner_job_id
         from code_submission s join runner_job j on j.submission_id = s.id
        where s.submission_type in ('server_compile','server_run')
          and s.status = 'queued' and j.status = 'queued'
          and j.lease_owner is null and j.dispatch_request is null
          and j.queued_at <= $1
        order by j.queued_at,j.id
        for update of s,j skip locked
        limit $2
     ), failed_jobs as (
       update runner_job j
          set status = 'failed', result = $3::jsonb, completed_at = $4,
              recovery_last_error_code = 'PRACTICE_PRE_DISPATCH_STALE'
         from stale where j.id = stale.runner_job_id
         returning j.submission_id
     )
     update code_submission s
        set status = 'failed',runtime_image_digest = 'practice-pre-dispatch-stale'
       from failed_jobs where s.id = failed_jobs.submission_id
     returning s.id submission_id`,
    [staleCutoff, limit, JSON.stringify({
      error: "PRACTICE_PRE_DISPATCH_STALE",
      retryable: true,
      officialEvidenceChanged: false,
    }), now],
  );
  const candidates = await pool.query<{ id: string }>(
    `select j.id
       from runner_job j
       join code_submission s on s.id = j.submission_id
      where s.submission_type in ('server_compile','server_run')
        and (s.status in ('queued','leased','running') or j.status in ('queued','leased','running'))
        and j.dispatch_request is not null
        and (
          (j.recovery_state = 'ready' and coalesce(j.started_at,j.queued_at) <= $1)
          or (j.recovery_state = 'retry_wait' and j.recovery_next_attempt_at <= $2)
        )
        and not exists (
          select 1 from runner_power_rehearsal_event rehearsal
           where rehearsal.state in ('armed','filled')
             and (rehearsal.slot_one_runner_job_id = j.id
               or rehearsal.slot_two_runner_job_id = j.id)
        )
      order by coalesce(j.recovery_next_attempt_at,j.started_at,j.queued_at),j.id
      limit $3`,
    [staleCutoff, now, limit],
  );
  if (!candidates.rows.length) {
    return {
      cancelledUndispatched: undispatched.rowCount ?? undispatched.rows.length,
      processed: 0,
      reconciled: 0,
      indeterminate: 0,
      corrupt: 0,
      skipped: 0,
    };
  }
  const runner = input.runner ?? configuredRunnerClient();
  const clock = input.clock ?? (() => new Date());
  const outcomes: RecoveryOutcome[] = [];
  for (const candidate of candidates.rows) {
    outcomes.push(await processOne({ jobId: candidate.id, runner, clock }));
  }
  return {
    cancelledUndispatched: undispatched.rowCount ?? undispatched.rows.length,
    processed: outcomes.length,
    reconciled: outcomes.filter((outcome) => outcome === "reconciled").length,
    indeterminate: outcomes.filter((outcome) => outcome === "indeterminate").length,
    corrupt: outcomes.filter((outcome) => outcome === "corrupt").length,
    skipped: outcomes.filter((outcome) => outcome === "skipped").length,
  };
}
