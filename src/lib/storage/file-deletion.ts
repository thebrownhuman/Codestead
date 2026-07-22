import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { FILE_ERASURE_JOB_TYPE } from "@/lib/data-lifecycle/file-erasure";

type DeletionPool = {
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
};

type ObjectRow = {
  id: string;
  storage_key: string;
  size_bytes: string | number;
  deleted_at: Date | null;
};

export class FileDeletionInvariantError extends Error {
  constructor(message = "Durable file deletion idempotency evidence does not match.") {
    super(message);
    this.name = "FileDeletionInvariantError";
  }
}

function safeBytes(value: string | number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new FileDeletionInvariantError();
  return parsed;
}

export class FileDeletionCommitAmbiguousError extends Error {
  constructor(options?: ErrorOptions) {
    super("The file deletion commit outcome is ambiguous; retry the same object deletion.", options);
    this.name = "FileDeletionCommitAmbiguousError";
  }
}

function exactUserDeletePayload(
  value: unknown,
  objectId: string,
  storageKey: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return Object.keys(payload).length === 3
    && payload.operation === "user_file_delete"
    && payload.objectId === objectId
    && payload.storageKey === storageKey;
}

function releaseFailure(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

function protocolFailure(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code ?? "";
  return ["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "57P01", "57P02", "57P03"].includes(code)
    || (error instanceof Error && /protocol|connection terminated/i.test(error.message));
}

async function boundedRollback(rollback: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: Error }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: new Error("File deletion rollback timed out.") }), timeoutMs);
  });
  const settled = rollback.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error: releaseFailure(error, "File deletion rollback failed.") }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function deleteUserFile(
  input: { ownerUserId: string; objectId: string; now?: Date },
  database: DeletionPool = pool,
  options: { rollbackTimeoutMs?: number } = {},
): Promise<{ id: string; replayed: boolean } | null> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("A valid deletion timestamp is required.");
  const client = await database.connect();
  let releaseError: Error | undefined;
  let transactionStarted = false;
  let commitIssued = false;
  try {
    await client.query("begin");
    transactionStarted = true;
    const selected = await client.query<ObjectRow>(
      `select id, storage_key, size_bytes::text, deleted_at
         from stored_object
        where id = $1 and owner_user_id = $2
        for update`,
      [input.objectId, input.ownerUserId],
    );
    const object = selected.rows[0];
    if (!object) {
      commitIssued = true;
      await client.query("commit");
      return null;
    }
    const sizeBytes = safeBytes(object.size_bytes);
    const replayed = object.deleted_at !== null;
    if (!replayed) {
      const tombstoned = await client.query(
        `update stored_object
            set deleted_at = $3, scan_status = 'deleted', updated_at = $3
          where id = $1 and owner_user_id = $2 and deleted_at is null`,
        [input.objectId, input.ownerUserId, now],
      );
      if ((tombstoned.rowCount ?? 0) !== 1) throw new FileDeletionInvariantError();
    }

    const quotaKey = `delete:${input.objectId}`;
    await client.query(
      `insert into quota_ledger
        (user_id, object_id, operation, bytes, idempotency_key)
       values ($1,$2,'release',$3,$4)
       on conflict (user_id, idempotency_key) do nothing`,
      [input.ownerUserId, input.objectId, -sizeBytes, quotaKey],
    );
    const quota = await client.query<{
      object_id: string;
      operation: string;
      bytes: string | number;
    }>(
      `select object_id, operation, bytes::text
         from quota_ledger
        where user_id = $1 and idempotency_key = $2`,
      [input.ownerUserId, quotaKey],
    );
    const quotaRow = quota.rows[0];
    if (
      !quotaRow
      || quotaRow.object_id !== input.objectId
      || quotaRow.operation !== "release"
      || Number(quotaRow.bytes) !== -sizeBytes
    ) throw new FileDeletionInvariantError();

    const payload = {
      operation: "user_file_delete",
      objectId: input.objectId,
      storageKey: object.storage_key,
    } as const;
    const jobKey = `file-erasure:user-file-delete:${input.objectId}`;
    await client.query(
      `insert into background_job
        (type, payload, status, priority, attempt_count, max_attempts,
         idempotency_key, run_after, created_at, updated_at)
       values ($1,$2::jsonb,'queued',10,0,100,$3,$4,$4,$4)
       on conflict (idempotency_key) do nothing`,
      [FILE_ERASURE_JOB_TYPE, JSON.stringify(payload), jobKey, now],
    );
    const job = await client.query<{ type: string; payload: unknown }>(
      `select type, payload
         from background_job
        where idempotency_key = $1`,
      [jobKey],
    );
    const jobRow = job.rows[0];
    if (
      !jobRow
      || jobRow.type !== FILE_ERASURE_JOB_TYPE
      || !exactUserDeletePayload(jobRow.payload, input.objectId, object.storage_key)
    ) throw new FileDeletionInvariantError();

    commitIssued = true;
    await client.query("commit");
    return { id: object.id, replayed };
  } catch (error) {
    if (commitIssued) {
      releaseError = releaseFailure(error, "File deletion commit failed ambiguously.");
      throw new FileDeletionCommitAmbiguousError({ cause: error });
    }
    if (transactionStarted) {
      const rollback = await boundedRollback(
        client.query("rollback"),
        options.rollbackTimeoutMs ?? 5_000,
      );
      if (!rollback.ok) releaseError = rollback.error;
    }
    if (protocolFailure(error)) releaseError = releaseFailure(error, "File deletion protocol failed.");
    throw error;
  } finally {
    if (releaseError) client.release(releaseError);
    else client.release();
  }
}
