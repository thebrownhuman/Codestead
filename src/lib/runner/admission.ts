import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";
import { serializeRunnerRequest, type RunnerRequest } from "@/lib/runner/client";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACTIVE_STATUSES = new Set(["queued", "leased", "running"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);
const OFFICIAL_SUBMISSION_TYPES = new Set(["exam_final_test", "assessment_correction_regrade"]);
export const RUNNER_STALE_DISPATCH_MS = 2 * 60_000;

export type RunnerAdmissionErrorCode =
  | "INVALID_INPUT"
  | "IDEMPOTENCY_MISMATCH"
  | "OFFICIAL_CAPACITY_BUSY"
  | "RECOVERY_QUARANTINED"
  | "REMOTE_JOB_ID_MISMATCH"
  | "TERMINAL_REPLAY"
  | "USER_NOT_ACTIVE"
  | "WRITE_CONFLICT";

export class RunnerAdmissionError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: RunnerAdmissionErrorCode,
    public readonly activeSubmissionId?: string,
  ) {
    super(code);
    this.name = "RunnerAdmissionError";
    this.retryable = code === "OFFICIAL_CAPACITY_BUSY";
  }
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function hashRunnerAdmissionRequest(value: unknown) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function isOfficialRunnerSubmissionType(submissionType: string) {
  return OFFICIAL_SUBMISSION_TYPES.has(submissionType);
}

export function requireFreshRunnerMutation(result: { readonly replayed: boolean }) {
  if (result.replayed) throw new RunnerAdmissionError("TERMINAL_REPLAY");
}

type AdmissionStatus = "queued" | "leased" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";

export type RunnerAdmission = Readonly<{
  submissionId: string;
  runnerJobId: string;
  userId: string;
  requestId: string;
  requestHash: string;
  submissionType: string;
  status: AdmissionStatus;
  remoteJobId: string | null;
  result: Record<string, unknown> | null;
  runtimeImageDigest: string;
  queuedAt: Date;
  duplicate: boolean;
}>;

type AdmissionInput = {
  userId: string;
  attemptId?: string | null;
  activityId?: string | null;
  language: string;
  sourceCode: string;
  sourceHash: string;
  submissionType: string;
  requestId: string;
  requestHash: string;
  testBundleId?: string | null;
  limits: Record<string, number>;
  priority?: number;
  now?: Date;
};

function validateAdmission(input: AdmissionInput, now: Date) {
  if (
    input.userId.length < 1
    || input.userId.length > 255
    || !SAFE_REQUEST_ID.test(input.requestId)
    || !SHA256.test(input.requestHash)
    || !SHA256.test(input.sourceHash)
    || input.language.length < 1
    || input.language.length > 50
    || input.submissionType.length < 1
    || input.submissionType.length > 100
    || !Number.isFinite(now.getTime())
    || input.sourceCode.length < 1
  ) throw new RunnerAdmissionError("INVALID_INPUT");
  const priority = input.priority ?? 100;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 10_000) {
    throw new RunnerAdmissionError("INVALID_INPUT");
  }
  if (Object.values(input.limits).some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RunnerAdmissionError("INVALID_INPUT");
  }
  return priority;
}

async function lockLearner(client: PoolClient, userId: string) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [`runner-learner:${userId}`]);
}

async function lockActiveUserForAdmission(client: PoolClient, userId: string) {
  // This global authority lock is always first, matching account deletion and
  // every other operation that can create or invalidate user-scoped work.
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(userId)]);
  const account = await client.query<{ status: string }>(
    `select status from "user" where id = $1 for update`,
    [userId],
  );
  if (account.rows[0]?.status !== "active") throw new RunnerAdmissionError("USER_NOT_ACTIVE");
  await lockLearner(client, userId);
}

async function existingAdmission(client: PoolClient, userId: string, requestId: string) {
  const submission = await client.query<{
    id: string;
    user_id: string;
    request_id: string;
    request_hash: string;
    submission_type: string;
    status: AdmissionStatus;
    runtime_image_digest: string;
  }>(
    `select id,user_id,request_id,request_hash,submission_type,status,runtime_image_digest
       from code_submission where user_id = $1 and request_id = $2 for update`,
    [userId, requestId],
  );
  const row = submission.rows[0];
  if (!row) return null;
  const job = await client.query<{
    id: string;
    status: AdmissionStatus;
    lease_owner: string | null;
    result: Record<string, unknown> | null;
    queued_at: Date;
  }>(
    `select id,status,lease_owner,result,queued_at
       from runner_job where submission_id = $1 for update`,
    [row.id],
  );
  const linked = job.rows[0];
  if (!linked) throw new RunnerAdmissionError("WRITE_CONFLICT");
  return { submission: row, job: linked };
}

function replayAdmission(
  replay: NonNullable<Awaited<ReturnType<typeof existingAdmission>>>,
): RunnerAdmission {
  return {
    submissionId: replay.submission.id,
    runnerJobId: replay.job.id,
    userId: replay.submission.user_id,
    requestId: replay.submission.request_id,
    requestHash: replay.submission.request_hash,
    submissionType: replay.submission.submission_type,
    status: replay.submission.status,
    remoteJobId: replay.job.lease_owner,
    result: replay.job.result,
    runtimeImageDigest: replay.submission.runtime_image_digest,
    queuedAt: replay.job.queued_at,
    duplicate: true,
  };
}

export async function refreshRunnerAdmission(admission: RunnerAdmission): Promise<RunnerAdmission> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockLearner(client, admission.userId);
    const replay = await existingAdmission(client, admission.userId, admission.requestId);
    if (
      !replay
      || replay.submission.id !== admission.submissionId
      || replay.job.id !== admission.runnerJobId
      || replay.submission.request_hash !== admission.requestHash
      || replay.submission.status !== replay.job.status
    ) throw new RunnerAdmissionError("WRITE_CONFLICT");
    await client.query("commit");
    return replayAdmission(replay);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileStaleOfficialDispatch(
  client: PoolClient,
  userId: string,
  now: Date,
) {
  const stale = await client.query<{ submission_id: string; runner_job_id: string }>(
    `select s.id as submission_id,j.id as runner_job_id
       from code_submission s
       join runner_job j on j.submission_id = s.id
      where s.user_id = $1
        and s.submission_type in ('exam_final_test','assessment_correction_regrade')
        and s.status = 'queued' and j.status = 'queued'
        and j.lease_owner is null
        and j.queued_at <= $2
      order by j.queued_at,j.id
      for update of s,j
      limit 1`,
    [userId, new Date(now.getTime() - RUNNER_STALE_DISPATCH_MS)],
  );
  const row = stale.rows[0];
  if (!row) return false;
  const job = await client.query(
    `update runner_job
        set status = 'failed',result = $2::jsonb,completed_at = $3
      where id = $1 and status = 'queued' and lease_owner is null`,
    [row.runner_job_id, JSON.stringify({
      error: "OFFICIAL_DISPATCH_STALE",
      retryable: true,
      officialEvidenceChanged: false,
    }), now],
  );
  const submission = await client.query(
    `update code_submission
        set status = 'failed',runtime_image_digest = 'runner-dispatch-stale'
      where id = $1 and status = 'queued'`,
    [row.submission_id],
  );
  if (job.rowCount !== 1 || submission.rowCount !== 1) {
    throw new RunnerAdmissionError("WRITE_CONFLICT");
  }
  return true;
}

export async function admitRunnerJob(input: AdmissionInput): Promise<RunnerAdmission> {
  const now = input.now ?? new Date();
  const priority = validateAdmission(input, now);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockActiveUserForAdmission(client, input.userId);
    await reconcileStaleOfficialDispatch(client, input.userId, now);
    const replay = await existingAdmission(client, input.userId, input.requestId);
    if (replay) {
      if (replay.submission.request_hash !== input.requestHash) {
        throw new RunnerAdmissionError("IDEMPOTENCY_MISMATCH");
      }
      if (replay.submission.status !== replay.job.status) {
        throw new RunnerAdmissionError("WRITE_CONFLICT");
      }
      await client.query("commit");
      return replayAdmission(replay);
    }
    if (isOfficialRunnerSubmissionType(input.submissionType)) {
      const active = await client.query<{ id: string }>(
        `select id from code_submission
          where user_id = $1
            and submission_type in ('exam_final_test','assessment_correction_regrade')
            and status in ('queued','leased','running')
          order by created_at,id limit 1 for update`,
        [input.userId],
      );
      if (active.rows[0]) {
        throw new RunnerAdmissionError("OFFICIAL_CAPACITY_BUSY", active.rows[0].id);
      }
    }
    const submissionId = randomUUID();
    const runnerJobId = randomUUID();
    await client.query(
      `insert into code_submission
        (id,user_id,attempt_id,activity_id,language,source_code,source_hash,
         submission_type,request_id,request_hash,runtime_image_digest,test_bundle_id,status,created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending-runner-result',$11,'queued',$12)`,
      [submissionId, input.userId, input.attemptId ?? null, input.activityId ?? null,
        input.language, input.sourceCode, input.sourceHash, input.submissionType,
        input.requestId, input.requestHash, input.testBundleId ?? null, now],
    );
    await client.query(
      `insert into runner_job
        (id,submission_id,status,priority,limits,queued_at)
       values ($1,$2,'queued',$3,$4::jsonb,$5)`,
      [runnerJobId, submissionId, priority, JSON.stringify(input.limits), now],
    );
    await client.query("commit");
    return {
      submissionId,
      runnerJobId,
      userId: input.userId,
      requestId: input.requestId,
      requestHash: input.requestHash,
      submissionType: input.submissionType,
      status: "queued",
      remoteJobId: null,
      result: null,
      runtimeImageDigest: "pending-runner-result",
      queuedAt: now,
      duplicate: false,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (
      typeof error === "object"
      && error !== null
      && "constraint" in error
      && (error as { constraint?: string }).constraint === "code_submission_one_active_official_user"
    ) throw new RunnerAdmissionError("OFFICIAL_CAPACITY_BUSY");
    throw error;
  } finally {
    client.release();
  }
}

async function lockedAdmission(client: PoolClient, input: {
  userId: string;
  submissionId: string;
  runnerJobId: string;
  requestId: string;
  requestHash: string;
}) {
  const submission = await client.query<{
    status: AdmissionStatus;
    request_id: string;
    request_hash: string;
  }>(
    `select status,request_id,request_hash from code_submission
      where id = $1 and user_id = $2 for update`,
    [input.submissionId, input.userId],
  );
  const row = submission.rows[0];
  if (!row) throw new RunnerAdmissionError("WRITE_CONFLICT");
  const job = await client.query<{
    status: AdmissionStatus;
    lease_owner: string | null;
    dispatch_request: Record<string, unknown> | null;
    recovery_state: string | null;
  }>(
    `select status,lease_owner,dispatch_request,recovery_state from runner_job where id = $1 and submission_id = $2 for update`,
    [input.runnerJobId, input.submissionId],
  );
  if (!job.rows[0] || row.request_id !== input.requestId || row.request_hash !== input.requestHash) {
    throw new RunnerAdmissionError("WRITE_CONFLICT");
  }
  if (job.rows[0].recovery_state === "quarantined") {
    throw new RunnerAdmissionError("RECOVERY_QUARANTINED");
  }
  if (row.status !== job.rows[0].status) throw new RunnerAdmissionError("WRITE_CONFLICT");
  return {
    status: row.status,
    remoteJobId: job.rows[0].lease_owner,
    dispatchRequest: job.rows[0].dispatch_request,
  };
}

/**
 * Persist the indeterminate dispatch boundary before making the remote call.
 * A crash or timeout after this commit must be recovered with the same local
 * admission and remote idempotency key; stale queued reconciliation therefore
 * cannot terminally fail it.
 */
export async function beginRunnerDispatch(input: {
  admission: RunnerAdmission;
  dispatchRequest?: RunnerRequest;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RunnerAdmissionError("INVALID_INPUT");
  let serializedDispatch: string | null = null;
  if (input.dispatchRequest) {
    if (input.dispatchRequest.submissionId !== input.admission.submissionId) {
      throw new RunnerAdmissionError("INVALID_INPUT");
    }
    try {
      serializedDispatch = serializeRunnerRequest(input.dispatchRequest);
    } catch {
      throw new RunnerAdmissionError("INVALID_INPUT");
    }
    if (Buffer.byteLength(serializedDispatch, "utf8") > 1_048_576) {
      throw new RunnerAdmissionError("INVALID_INPUT");
    }
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockActiveUserForAdmission(client, input.admission.userId);
    const current = await lockedAdmission(client, input.admission);
    if (serializedDispatch && current.dispatchRequest) {
      let persisted: string;
      try {
        persisted = serializeRunnerRequest(current.dispatchRequest as unknown as RunnerRequest);
      } catch {
        throw new RunnerAdmissionError("WRITE_CONFLICT");
      }
      if (persisted !== serializedDispatch) throw new RunnerAdmissionError("IDEMPOTENCY_MISMATCH");
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      await client.query("commit");
      return { replayed: true, remoteJobId: current.remoteJobId } as const;
    }
    if (!ACTIVE_STATUSES.has(current.status)) throw new RunnerAdmissionError("WRITE_CONFLICT");
    const nextStatus = current.status === "running" ? "running" : "leased";
    const job = await client.query(
      `update runner_job set status = $2,started_at = coalesce(started_at,$3),
          dispatch_request = coalesce(dispatch_request,$4::jsonb),
          recovery_state = case when $4::jsonb is null then recovery_state else coalesce(recovery_state,'ready') end
        where id = $1 and status in ('queued','leased','running')`,
      [input.admission.runnerJobId, nextStatus, now, serializedDispatch],
    );
    const submission = await client.query(
      `update code_submission set status = $2
        where id = $1 and status in ('queued','leased','running')`,
      [input.admission.submissionId, nextStatus],
    );
    if (job.rowCount !== 1 || submission.rowCount !== 1) {
      throw new RunnerAdmissionError("WRITE_CONFLICT");
    }
    await client.query("commit");
    return { replayed: false, remoteJobId: current.remoteJobId } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordRunnerDispatch(input: {
  admission: RunnerAdmission;
  remoteJobId: string;
  status: "queued" | "running";
  now?: Date;
}) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.remoteJobId)) {
    throw new RunnerAdmissionError("INVALID_INPUT");
  }
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockLearner(client, input.admission.userId);
    const current = await lockedAdmission(client, {
      ...input.admission,
      requestId: input.admission.requestId,
      requestHash: input.admission.requestHash,
    });
    if (current.remoteJobId !== null && current.remoteJobId !== input.remoteJobId) {
      throw new RunnerAdmissionError("REMOTE_JOB_ID_MISMATCH");
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      await client.query("commit");
      return { replayed: true } as const;
    }
    if (!ACTIVE_STATUSES.has(current.status)) throw new RunnerAdmissionError("WRITE_CONFLICT");
    const nextStatus = current.status === "running" || input.status === "running" ? "running" : "queued";
    const job = await client.query(
      `update runner_job set status = $2,lease_owner = coalesce(lease_owner,$3),
          started_at = coalesce(started_at,$4)
        where id = $1 and status in ('queued','leased','running')
          and (lease_owner is null or lease_owner = $3)`,
      [input.admission.runnerJobId, nextStatus, input.remoteJobId, now],
    );
    const submission = await client.query(
      `update code_submission set status = $2
        where id = $1 and status in ('queued','leased','running')`,
      [input.admission.submissionId, nextStatus],
    );
    if (job.rowCount !== 1 || submission.rowCount !== 1) {
      throw new RunnerAdmissionError("WRITE_CONFLICT");
    }
    await client.query("commit");
    return { replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function settleRunnerJob(input: {
  admission: RunnerAdmission;
  status: "succeeded" | "failed" | "timed_out";
  runtimeImageDigest: string;
  result: Record<string, unknown>;
  remoteJobId?: string | null;
  startedAt?: Date;
  completedAt?: Date;
}) {
  const completedAt = input.completedAt ?? new Date();
  if (
    !Number.isFinite(completedAt.getTime())
    || input.runtimeImageDigest.length < 1
    || (input.remoteJobId !== undefined
      && input.remoteJobId !== null
      && !/^[A-Za-z0-9._:-]{1,128}$/.test(input.remoteJobId))
  ) {
    throw new RunnerAdmissionError("INVALID_INPUT");
  }
  if (input.status !== "failed" && !input.remoteJobId) {
    throw new RunnerAdmissionError("REMOTE_JOB_ID_MISMATCH");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockLearner(client, input.admission.userId);
    const current = await lockedAdmission(client, {
      ...input.admission,
      requestId: input.admission.requestId,
      requestHash: input.admission.requestHash,
    });
    const suppliedRemoteJobId = input.remoteJobId ?? null;
    if (
      (current.remoteJobId !== null && current.remoteJobId !== suppliedRemoteJobId)
      || (TERMINAL_STATUSES.has(current.status)
        && current.remoteJobId === null
        && suppliedRemoteJobId !== null)
    ) {
      throw new RunnerAdmissionError("REMOTE_JOB_ID_MISMATCH");
    }
    if (TERMINAL_STATUSES.has(current.status)) {
      await client.query("commit");
      return { replayed: true } as const;
    }
    if (!ACTIVE_STATUSES.has(current.status)) throw new RunnerAdmissionError("WRITE_CONFLICT");
    const job = await client.query(
      `update runner_job set status = $2,lease_owner = coalesce($3,lease_owner),
          result = $4::jsonb,started_at = coalesce(started_at,$5),completed_at = $6
        where id = $1 and status in ('queued','leased','running')
          and (lease_owner is null or lease_owner = $3)`,
      [input.admission.runnerJobId, input.status, input.remoteJobId ?? null,
        JSON.stringify(input.result), input.startedAt ?? completedAt, completedAt],
    );
    const submission = await client.query(
      `update code_submission set status = $2,runtime_image_digest = $3
        where id = $1 and status in ('queued','leased','running')`,
      [input.admission.submissionId, input.status, input.runtimeImageDigest],
    );
    if (job.rowCount !== 1 || submission.rowCount !== 1) {
      throw new RunnerAdmissionError("WRITE_CONFLICT");
    }
    await client.query("commit");
    return { replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
