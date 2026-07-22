import type { PoolClient, QueryResult } from "pg";

import { pool } from "@/lib/db/client";

import { DEFAULT_STORAGE_QUOTA_BYTES, uploadWouldExceedQuota } from "./policy";
import { StorageQuotaExceededError } from "./quota-store";
import {
  UploadCommitAmbiguousError,
  UploadIdempotencyConflictError,
  type DurableUploadObject,
  type UploadReceipt,
  type UploadReceiptRepository,
} from "./upload-service";

type Queryable = Pick<PoolClient, "query">;
type UploadPool = Queryable & {
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
};

type ReceiptRow = {
  request_hash: string;
  id: string;
  original_name: string;
  media_type: string;
  size_bytes: string | number;
  storage_key: string;
  sha256: string;
  scan_status: string;
  deleted_at: Date | string | null;
};

const RECEIPT_SELECT = `select receipt.request_hash,
       object.id, object.original_name, object.media_type,
       object.size_bytes::text, object.storage_key, object.sha256,
       object.scan_status, object.deleted_at
  from upload_receipt receipt
  join stored_object object on object.id = receipt.object_id
 where receipt.owner_user_id = $1 and receipt.idempotency_key = $2`;

function safeSize(value: string | number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Stored upload size is outside the safe integer range.");
  }
  return parsed;
}

function receiptFromRow(row: ReceiptRow): UploadReceipt {
  return {
    requestHash: row.request_hash,
    object: {
      id: row.id,
      name: row.original_name,
      mediaType: row.media_type,
      sizeBytes: safeSize(row.size_bytes),
      storageKey: row.storage_key,
      sha256: row.sha256,
      scanStatus: row.scan_status,
    },
    tombstoned: row.deleted_at !== null,
  };
}

function exactHash(left: string, right: string) {
  return /^v1:[0-9a-f]{64}$/.test(left)
    && /^v1:[0-9a-f]{64}$/.test(right)
    && left === right;
}

function errorForRelease(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

function isProtocolFailure(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code ?? "";
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "57P01",
    "57P02",
    "57P03",
  ].includes(code) || (error instanceof Error && /protocol|connection terminated/i.test(error.message));
}

async function boundedRollback(
  rollback: Promise<unknown>,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: Error }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: new Error("PostgreSQL rollback timed out.") }), timeoutMs);
  });
  const settled = rollback.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error: errorForRelease(error, "PostgreSQL rollback failed.") }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

export class PostgresUploadReceiptRepository implements UploadReceiptRepository {
  private readonly rollbackTimeoutMs: number;

  constructor(
    private readonly database: UploadPool = pool,
    options: { rollbackTimeoutMs?: number } = {},
  ) {
    this.rollbackTimeoutMs = options.rollbackTimeoutMs ?? 5_000;
  }

  async find(ownerUserId: string, idempotencyKey: string) {
    const result = await this.database.query<ReceiptRow>(RECEIPT_SELECT, [
      ownerUserId,
      idempotencyKey,
    ]);
    return result.rows[0] ? receiptFromRow(result.rows[0]) : null;
  }

  async commit(input: {
    ownerUserId: string;
    idempotencyKey: string;
    requestHash: string;
    object: DurableUploadObject;
  }) {
    const client = await this.database.connect();
    let commitIssued = false;
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      await client.query("begin");
      transactionStarted = true;
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [input.ownerUserId]);
      const prior = await client.query<ReceiptRow>(RECEIPT_SELECT, [
        input.ownerUserId,
        input.idempotencyKey,
      ]);
      if (prior.rows[0]) {
        const receipt = receiptFromRow(prior.rows[0]);
        if (!exactHash(receipt.requestHash, input.requestHash)) {
          throw new UploadIdempotencyConflictError();
        }
        commitIssued = true;
        await client.query("commit");
        return {
          disposition: receipt.tombstoned ? "tombstoned" as const : "replay" as const,
          object: receipt.object,
        };
      }

      const quota = await client.query<{
        quota_bytes: string | number;
        used_bytes: string | number;
      }>(
        `select coalesce(
             (select storage_quota_bytes from learner_profile where user_id = $1),
             $2::bigint
           )::text as quota_bytes,
           coalesce(
             (select sum(size_bytes) from stored_object
               where owner_user_id = $1 and deleted_at is null),
             0
           )::text as used_bytes`,
        [input.ownerUserId, DEFAULT_STORAGE_QUOTA_BYTES],
      );
      const quotaBytes = safeSize(quota.rows[0]?.quota_bytes ?? DEFAULT_STORAGE_QUOTA_BYTES);
      const usedBytes = safeSize(quota.rows[0]?.used_bytes ?? 0);
      if (uploadWouldExceedQuota(usedBytes, input.object.sizeBytes, quotaBytes)) {
        throw new StorageQuotaExceededError();
      }

      await client.query(
        `insert into stored_object
          (id, owner_user_id, storage_key, original_name, media_type,
           size_bytes, sha256, scan_status)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.object.id,
          input.ownerUserId,
          input.object.storageKey,
          input.object.name,
          input.object.mediaType,
          input.object.sizeBytes,
          input.object.sha256,
          input.object.scanStatus,
        ],
      );
      await client.query(
        `insert into quota_ledger
          (user_id, object_id, operation, bytes, idempotency_key)
         values ($1,$2,'reserve_and_finalize',$3,$4)`,
        [
          input.ownerUserId,
          input.object.id,
          input.object.sizeBytes,
          `upload:${input.idempotencyKey}`,
        ],
      );
      await client.query(
        `insert into upload_receipt
          (owner_user_id, idempotency_key, request_hash, object_id)
         values ($1,$2,$3,$4)`,
        [
          input.ownerUserId,
          input.idempotencyKey,
          input.requestHash,
          input.object.id,
        ],
      );
      commitIssued = true;
      await client.query("commit");
      return { disposition: "created" as const, object: input.object };
    } catch (error) {
      if (commitIssued) {
        releaseError = errorForRelease(error, "PostgreSQL commit outcome is ambiguous.");
        if (error instanceof UploadCommitAmbiguousError) throw error;
        throw new UploadCommitAmbiguousError({ cause: error });
      }
      if (transactionStarted) {
        const rollback = await boundedRollback(
          client.query("rollback"),
          this.rollbackTimeoutMs,
        );
        if (!rollback.ok) releaseError = rollback.error;
      }
      if (isProtocolFailure(error)) {
        releaseError = errorForRelease(error, "PostgreSQL protocol failure.");
      }
      throw error;
    } finally {
      if (releaseError) client.release(releaseError);
      else client.release();
    }
  }
}

export function uploadReceiptFromQuery(result: QueryResult<ReceiptRow>) {
  return result.rows[0] ? receiptFromRow(result.rows[0]) : null;
}
