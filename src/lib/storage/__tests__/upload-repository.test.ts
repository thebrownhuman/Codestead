import { beforeEach, describe, expect, it, vi } from "vitest";

import { StorageQuotaExceededError } from "../quota-store";
import {
  PostgresUploadReceiptRepository,
} from "../upload-repository";
import {
  UploadCommitAmbiguousError,
  UploadIdempotencyConflictError,
  type DurableUploadObject,
} from "../upload-service";

const OWNER = "learner-1";
const KEY = "c1000000-0000-4000-8000-000000000001";
const HASH = `v1:${"a".repeat(64)}`;
const OBJECT_ID = "c2000000-0000-4000-8000-000000000001";
const object: DurableUploadObject = {
  id: OBJECT_ID,
  name: "main.py",
  mediaType: "text/plain",
  sizeBytes: 5,
  storageKey: `${"c".repeat(64)}/${OBJECT_ID}`,
  sha256: "b".repeat(64),
  scanStatus: "pending",
};

function receiptRow(requestHash = HASH) {
  return {
    request_hash: requestHash,
    id: object.id,
    original_name: object.name,
    media_type: object.mediaType,
    size_bytes: String(object.sizeBytes),
    storage_key: object.storageKey,
    sha256: object.sha256,
    scan_status: object.scanStatus,
    deleted_at: null,
  };
}

describe("PostgreSQL upload receipt transaction", () => {
  const query = vi.fn();
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })), query };

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("from upload_receipt") && sql.includes("join stored_object")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("quota_bytes") && sql.includes("used_bytes")) {
        return { rows: [{ quota_bytes: "100", used_bytes: "20" }], rowCount: 1 };
      }
      if (sql.startsWith("insert into stored_object")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("insert into quota_ledger")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("insert into upload_receipt")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
  });

  it("publishes receipt, quota reservation, and object in one transaction after serializing the owner", async () => {
    const repository = new PostgresUploadReceiptRepository(pool as never);
    await expect(repository.commit({
      ownerUserId: OWNER,
      idempotencyKey: KEY,
      requestHash: HASH,
      object,
    })).resolves.toEqual({ disposition: "created", object });
    const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim().toLowerCase());
    expect(statements).toEqual(expect.arrayContaining([
      "begin",
      "commit",
    ]));
    expect(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock")))
      .toBeLessThan(statements.findIndex((sql) => sql.startsWith("insert into stored_object")));
    expect(statements.findIndex((sql) => sql.startsWith("insert into stored_object")))
      .toBeLessThan(statements.findIndex((sql) => sql.startsWith("insert into upload_receipt")));
    expect(statements.at(-1)).toBe("commit");
    expect(release).toHaveBeenCalledWith();
  });

  it("returns an exact concurrent replay without duplicating object or quota", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin" || sql === "commit") return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("from upload_receipt") && sql.includes("join stored_object")) {
        return { rows: [receiptRow()], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresUploadReceiptRepository(pool as never);
    await expect(repository.commit({
      ownerUserId: OWNER,
      idempotencyKey: KEY,
      requestHash: HASH,
      object,
    })).resolves.toEqual({ disposition: "replay", object });
    expect(query.mock.calls.some(([sql]) => String(sql).toLowerCase().startsWith("insert"))).toBe(false);
  });

  it("keeps a deleted receipt reserved and returns a tombstoned replay disposition", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin" || sql === "commit") return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("from upload_receipt") && sql.includes("join stored_object")) {
        expect(sql).toContain("object.deleted_at");
        return {
          rows: [{ ...receiptRow(), deleted_at: new Date("2026-07-20T00:00:00.000Z") }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresUploadReceiptRepository(pool as never);
    await expect(repository.commit({
      ownerUserId: OWNER,
      idempotencyKey: KEY,
      requestHash: HASH,
      object,
    })).resolves.toEqual({ disposition: "tombstoned", object });
    expect(query.mock.calls.some(([sql]) => String(sql).toLowerCase().startsWith("insert"))).toBe(false);
    expect(query).toHaveBeenCalledWith("commit");
  });

  it("rejects a concurrent key mismatch and rolls back", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "rollback"].includes(sql) || sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from upload_receipt") && sql.includes("join stored_object")) {
        return { rows: [receiptRow(`v1:${"f".repeat(64)}`)], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresUploadReceiptRepository(pool as never);
    await expect(repository.commit({
      ownerUserId: OWNER,
      idempotencyKey: KEY,
      requestHash: HASH,
      object,
    })).rejects.toBeInstanceOf(UploadIdempotencyConflictError);
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("rolls back a quota rejection before metadata publication", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "rollback"].includes(sql) || sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from upload_receipt") && sql.includes("join stored_object")) return { rows: [], rowCount: 0 };
      if (sql.includes("quota_bytes") && sql.includes("used_bytes")) {
        return { rows: [{ quota_bytes: "24", used_bytes: "20" }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresUploadReceiptRepository(pool as never);
    await expect(repository.commit({
      ownerUserId: OWNER,
      idempotencyKey: KEY,
      requestHash: HASH,
      object,
    })).rejects.toBeInstanceOf(StorageQuotaExceededError);
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("classifies a lost COMMIT response as ambiguous and does not issue rollback", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "commit") throw new Error("connection lost");
      if (sql === "begin" || sql.includes("pg_advisory_xact_lock") || sql.startsWith("insert")) return { rows: [], rowCount: 1 };
      if (sql.includes("from upload_receipt") && sql.includes("join stored_object")) return { rows: [], rowCount: 0 };
      if (sql.includes("quota_bytes") && sql.includes("used_bytes")) {
        return { rows: [{ quota_bytes: "100", used_bytes: "20" }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresUploadReceiptRepository(pool as never);
    await expect(repository.commit({
      ownerUserId: OWNER,
      idempotencyKey: KEY,
      requestHash: HASH,
      object,
    })).rejects.toBeInstanceOf(UploadCommitAmbiguousError);
    expect(query.mock.calls.some(([sql]) => String(sql).trim().toLowerCase() === "rollback")).toBe(false);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("destroys the client when rollback itself rejects", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "rollback") throw new Error("rollback connection failure");
      if (sql === "begin" || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("from upload_receipt")) return { rows: [], rowCount: 0 };
      if (sql.includes("quota_bytes")) return { rows: [{ quota_bytes: "24", used_bytes: "20" }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresUploadReceiptRepository(pool as never);
    await expect(repository.commit({ ownerUserId: OWNER, idempotencyKey: KEY, requestHash: HASH, object }))
      .rejects.toBeInstanceOf(StorageQuotaExceededError);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("bounds a hung rollback and destroys rather than returning the transaction to the pool", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "rollback") return new Promise(() => undefined);
      if (sql === "begin" || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("from upload_receipt")) return { rows: [], rowCount: 0 };
      if (sql.includes("quota_bytes")) return { rows: [{ quota_bytes: "24", used_bytes: "20" }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresUploadReceiptRepository(pool as never, { rollbackTimeoutMs: 5 });
    await expect(repository.commit({ ownerUserId: OWNER, idempotencyKey: KEY, requestHash: HASH, object }))
      .rejects.toBeInstanceOf(StorageQuotaExceededError);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("destroys a client after a protocol failure even when rollback acknowledges", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "rollback" || sql === "begin" || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("from upload_receipt")) return { rows: [], rowCount: 0 };
      if (sql.includes("quota_bytes")) throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresUploadReceiptRepository(pool as never);
    await expect(repository.commit({ ownerUserId: OWNER, idempotencyKey: KEY, requestHash: HASH, object }))
      .rejects.toMatchObject({ code: "ECONNRESET" });
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});
