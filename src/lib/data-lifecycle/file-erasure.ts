import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import type { PoolClient, QueryResult } from "pg";

import { pool } from "@/lib/db/client";
import { NodeDurableObjectStore } from "@/lib/storage/durable-object-store";

const JOB_TYPE = "storage.file_erasure.v1";
const ALREADY_ABSENT = "FILE_ALREADY_ABSENT";
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;

type Queryable = Pick<PoolClient, "query">;

export type FileErasureObject = Readonly<{
  id: string;
  storageKey: string;
}>;

type ClaimedJob = Readonly<{
  id: string;
  payload: {
    lifecycleRunId?: string;
    objectId: string;
    storageKey: string;
    operation: "account_deletion" | "retention" | "user_file_delete";
  };
}>;

export type FileErasureSummary = Readonly<{
  total: number;
  removed: number;
  alreadyAbsent: number;
  failed: number;
  pending: number;
  complete: boolean;
}>;

export class FileErasureError extends Error {
  constructor(
    public readonly code: "FILE_ERASURE_FAILED" | "FILE_ERASURE_INCOMPLETE",
  ) {
    super(code);
  }
}

function safeFailureCode(error: unknown) {
  const discriminator = error instanceof Error
    ? `${error.name}:${(error as NodeJS.ErrnoException).code ?? "unknown"}`
    : "UnknownError";
  return `FILE_ERASURE_${createHash("sha256").update(discriminator).digest("hex").slice(0, 12)}`;
}

/**
 * Enqueue file erasure in the same transaction that removes the corresponding
 * stored_object metadata. The payload deliberately contains neither an owner
 * id nor a filename, so an account-deletion queue is not itself new learner
 * profile data. The opaque storage key is removed with the completed job.
 */
export async function enqueueFileErasures(
  client: Queryable,
  input: {
    lifecycleRunId: string;
    operation: "account_deletion" | "retention";
    objects: readonly FileErasureObject[];
    now: Date;
  },
) {
  if (!input.objects.length) return 0;
  const payload = input.objects.map((object) => ({
    object_id: object.id,
    storage_key: object.storageKey,
  }));
  const inserted = await client.query(
    `insert into background_job
       (type, payload, status, priority, attempt_count, max_attempts,
        idempotency_key, run_after, created_at, updated_at)
     select $1,
            jsonb_build_object(
              'lifecycleRunId', $2::text,
              'operation', $3::text,
              'objectId', source.object_id,
              'storageKey', source.storage_key
            ),
            'queued', 10, 0, 100,
            'file-erasure:' || $2::text || ':' || source.object_id,
            $5, $5, $5
       from jsonb_to_recordset($4::jsonb)
         as source(object_id text, storage_key text)
     on conflict (idempotency_key) do nothing`,
    [JOB_TYPE, input.lifecycleRunId, input.operation, JSON.stringify(payload), input.now],
  );
  const mismatched = await client.query<{ count: string }>(
    `select count(*)::text as count
       from background_job
      where type = $1 and payload ->> 'lifecycleRunId' = $2
        and idempotency_key like 'file-erasure:' || $2 || ':%'
        and not exists (
          select 1 from jsonb_to_recordset($3::jsonb)
            as source(object_id text, storage_key text)
           where source.object_id = background_job.payload ->> 'objectId'
             and source.storage_key = background_job.payload ->> 'storageKey'
        )`,
    [JOB_TYPE, input.lifecycleRunId, JSON.stringify(payload)],
  );
  if (Number(mismatched.rows[0]?.count ?? 0) !== 0) {
    throw new Error("File-erasure idempotency payload mismatch.");
  }
  return inserted.rowCount ?? 0;
}

async function claimNextJob(
  client: Queryable,
  input: { lifecycleRunId: string; workerId: string; now: Date; leaseMs: number },
) {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const result = await client.query<ClaimedJob>(
    `with candidate as (
       select id
         from background_job
        where type = $1 and payload ->> 'lifecycleRunId' = $2
          and payload ->> 'operation' in ('account_deletion', 'retention')
          and attempt_count < max_attempts and run_after <= $3
          and (
            status in ('queued', 'failed')
            or (status in ('leased', 'running') and lease_expires_at <= $3)
          )
        order by created_at asc, id asc
        for update skip locked
        limit 1
     )
     update background_job job
        set status = 'leased', lease_owner = $4, lease_expires_at = $5,
            completed_at = null, updated_at = $3
       from candidate
      where job.id = candidate.id
      returning job.id, job.payload`,
    [JOB_TYPE, input.lifecycleRunId, input.now, input.workerId, leaseExpiresAt],
  );
  return result.rows[0] ?? null;
}

async function claimNextGlobalJob(
  client: Queryable,
  input: { workerId: string; now: Date; leaseMs: number },
) {
  const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
  const result = await client.query<ClaimedJob>(
    `with candidate as (
       select id
         from background_job
         where type = $1
           and payload ->> 'operation' in ('user_file_delete', 'retention', 'account_deletion')
          and attempt_count < max_attempts and run_after <= $2
          and (
            status in ('queued', 'failed')
            or (status in ('leased', 'running') and lease_expires_at <= $2)
          )
        order by created_at asc, id asc
        for update skip locked
        limit 1
     )
     update background_job job
        set status = 'leased', lease_owner = $3, lease_expires_at = $4,
            completed_at = null, updated_at = $2
       from candidate
      where job.id = candidate.id
      returning job.id, job.payload`,
    [JOB_TYPE, input.now, input.workerId, leaseExpiresAt],
  );
  return result.rows[0] ?? null;
}

export async function fileErasureSummary(
  client: Queryable,
  lifecycleRunId: string,
): Promise<FileErasureSummary> {
  const result = await client.query<{
    total: number;
    removed: number;
    already_absent: number;
    failed: number;
    pending: number;
  }>(
    `select count(*)::int total,
            count(*) filter (where status = 'succeeded' and last_error_code is null)::int removed,
            count(*) filter (where status = 'succeeded' and last_error_code = $3)::int already_absent,
            count(*) filter (where status = 'failed')::int failed,
            count(*) filter (where status not in ('succeeded', 'failed'))::int pending
       from background_job
      where type = $1 and payload ->> 'lifecycleRunId' = $2`,
    [JOB_TYPE, lifecycleRunId, ALREADY_ABSENT],
  );
  const row = result.rows[0] ?? {
    total: 0,
    removed: 0,
    already_absent: 0,
    failed: 0,
    pending: 0,
  };
  return {
    total: Number(row.total),
    removed: Number(row.removed),
    alreadyAbsent: Number(row.already_absent),
    failed: Number(row.failed),
    pending: Number(row.pending),
    complete: Number(row.total) === Number(row.removed) + Number(row.already_absent)
      && Number(row.failed) === 0
      && Number(row.pending) === 0,
  };
}

/**
 * Drain one lifecycle run under a PostgreSQL advisory lock. A process crash
 * releases the lock; an expired row lease can then be reclaimed. unlink is
 * idempotent because ENOENT is a successful terminal outcome.
 */
export async function processFileErasures(input: {
  lifecycleRunId: string;
  objectStorageRoot: string;
  now?: Date;
  leaseMs?: number;
  /** Test seam; production always uses node:fs/promises unlink. */
  unlinkFile?: typeof unlink;
  /** Test seam; production always performs realpath/lstat containment checks. */
  preparePath?: (root: string, storageKey: string) => Promise<string>;
  /** Test seam; production sync is performed through a pinned directory handle. */
  syncParentDirectory?: (root: string, storageKey: string) => Promise<void>;
}): Promise<FileErasureSummary> {
  const startedAt = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(startedAt.getTime()) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) {
    throw new Error("A valid file-erasure timestamp and lease are required.");
  }
  const workerId = `file-erasure:${randomUUID()}`;
  const durableStore = new NodeDurableObjectStore({ root: input.objectStorageRoot });
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [`file-erasure:${input.lifecycleRunId}`]);
    locked = true;
    while (true) {
      const now = new Date();
      const job = await claimNextJob(client, {
        lifecycleRunId: input.lifecycleRunId,
        workerId,
        now,
        leaseMs,
      });
      if (!job) break;
      try {
        let resultCode: string | null = null;
        if (input.preparePath || input.unlinkFile || input.syncParentDirectory) {
          if (!input.preparePath || !input.unlinkFile || !input.syncParentDirectory) {
            throw new Error("A complete file-erasure test seam is required.");
          }
          // Root/parent preparation is intentionally outside the ENOENT catch:
          // only absence of the already-verified final file is terminal success.
          const candidate = await input.preparePath(
            input.objectStorageRoot,
            job.payload.storageKey,
          );
          try {
            await input.unlinkFile(candidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") resultCode = ALREADY_ABSENT;
            else throw error;
          }
          await input.syncParentDirectory(input.objectStorageRoot, job.payload.storageKey);
        } else {
          const erased = await durableStore.erase(job.payload.storageKey);
          if (erased.alreadyAbsent) resultCode = ALREADY_ABSENT;
        }
        const completed = await client.query(
          `update background_job
              set status = 'succeeded', attempt_count = attempt_count + 1,
                  lease_owner = null, lease_expires_at = null,
                  last_error_code = $3, completed_at = $4, updated_at = $4
            where id = $1 and status = 'leased' and lease_owner = $2`,
          [job.id, workerId, resultCode, new Date()],
        );
        if ((completed.rowCount ?? 0) !== 1) throw new FileErasureError("FILE_ERASURE_INCOMPLETE");
      } catch (error) {
        await client.query(
          `update background_job
              set status = 'failed', attempt_count = attempt_count + 1,
                  lease_owner = null, lease_expires_at = null,
                  last_error_code = $3, completed_at = null, updated_at = $4,
                  run_after = $5
            where id = $1 and status = 'leased' and lease_owner = $2`,
          [job.id, workerId, safeFailureCode(error), new Date(), new Date(Date.now() + 30_000)],
        ).catch(() => undefined);
        if (error instanceof FileErasureError) throw error;
        throw new FileErasureError("FILE_ERASURE_FAILED");
      }
    }
    const summary = await fileErasureSummary(client, input.lifecycleRunId);
    if (!summary.complete) throw new FileErasureError("FILE_ERASURE_INCOMPLETE");
    return summary;
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(hashtext($1))", [`file-erasure:${input.lifecycleRunId}`])
        .catch(() => undefined);
    }
    client.release();
  }
}

export async function processUserFileErasures(input: {
  objectStorageRoot: string;
  limit?: number;
  now?: Date;
  leaseMs?: number;
  eraseObject?: (storageKey: string) => Promise<{ alreadyAbsent: boolean }>;
}): Promise<{ processed: number; removed: number; alreadyAbsent: number; failed: number; exhausted: number }> {
  const startedAt = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const limit = input.limit ?? 25;
  if (
    !Number.isFinite(startedAt.getTime())
    || !Number.isSafeInteger(leaseMs)
    || leaseMs < 1_000
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 100
  ) throw new Error("Valid bounded file-erasure worker settings are required.");
  const workerId = `file-erasure:global:${randomUUID()}`;
  const store = new NodeDurableObjectStore({ root: input.objectStorageRoot });
  if (!input.eraseObject) await store.assertReady();
  const eraseObject = input.eraseObject ?? ((storageKey: string) => store.erase(storageKey));
  const client = await pool.connect();
  let processed = 0;
  let removed = 0;
  let alreadyAbsent = 0;
  try {
    while (processed < limit) {
      const now = new Date();
      const job = await claimNextGlobalJob(client, { workerId, now, leaseMs });
      if (!job) break;
      processed += 1;
      try {
        const result = await eraseObject(job.payload.storageKey);
        const completed = job.payload.operation === "user_file_delete"
          ? await client.query(
            `delete from background_job
              where id = $1 and status = 'leased' and lease_owner = $2`,
            [job.id, workerId],
          )
          : await client.query(
            `update background_job
                set status = 'succeeded', attempt_count = attempt_count + 1,
                    lease_owner = null, lease_expires_at = null,
                    last_error_code = $3, completed_at = $4, updated_at = $4
              where id = $1 and status = 'leased' and lease_owner = $2`,
            [job.id, workerId, result.alreadyAbsent ? ALREADY_ABSENT : null, new Date()],
          );
        if ((completed.rowCount ?? 0) !== 1) throw new FileErasureError("FILE_ERASURE_INCOMPLETE");
        if (result.alreadyAbsent) alreadyAbsent += 1;
        else removed += 1;
      } catch (error) {
        const failedAt = new Date();
        await client.query(
          `update background_job
              set status = 'failed', attempt_count = attempt_count + 1,
                  lease_owner = null, lease_expires_at = null,
                  last_error_code = $3, completed_at = null, updated_at = $4,
                  run_after = $5
            where id = $1 and status = 'leased' and lease_owner = $2`,
          [job.id, workerId, safeFailureCode(error), failedAt, new Date(failedAt.getTime() + 30_000)],
        ).catch(() => undefined);
      }
    }
    const backlog = await client.query<{ failed: number; exhausted: number }>(
      `select count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (
                where status <> 'succeeded' and attempt_count >= max_attempts
              )::int as exhausted
         from background_job
        where type = $1
          and payload ->> 'operation' in ('user_file_delete', 'retention', 'account_deletion')`,
      [JOB_TYPE],
    );
    return {
      processed,
      removed,
      alreadyAbsent,
      failed: Number(backlog.rows[0]?.failed ?? 0),
      exhausted: Number(backlog.rows[0]?.exhausted ?? 0),
    };
  } finally {
    client.release();
  }
}

/** Remove opaque storage keys only in the transaction that publishes success. */
export async function purgeCompletedFileErasureJobs(
  client: Queryable,
  lifecycleRunId: string,
) {
  const summary = await fileErasureSummary(client, lifecycleRunId);
  if (!summary.complete) throw new FileErasureError("FILE_ERASURE_INCOMPLETE");
  const deleted: QueryResult = await client.query(
    `delete from background_job
      where type = $1 and payload ->> 'lifecycleRunId' = $2 and status = 'succeeded'`,
    [JOB_TYPE, lifecycleRunId],
  );
  return deleted.rowCount ?? 0;
}

export const FILE_ERASURE_JOB_TYPE = JOB_TYPE;
