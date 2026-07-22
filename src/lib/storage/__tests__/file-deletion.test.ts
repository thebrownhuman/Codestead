import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteUserFile,
  FileDeletionCommitAmbiguousError,
  FileDeletionInvariantError,
} from "../file-deletion";

const OWNER = "learner-1";
const OBJECT_ID = "d1000000-0000-4000-8000-000000000001";
const STORAGE_KEY = `${"d".repeat(64)}/${OBJECT_ID}`;

describe("durable learner file tombstone transaction", () => {
  const query = vi.fn();
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) };

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from stored_object") && sql.includes("for update")) {
        return { rows: [{ id: OBJECT_ID, storage_key: STORAGE_KEY, size_bytes: "1200", deleted_at: null }], rowCount: 1 };
      }
      if (sql.startsWith("update stored_object")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("insert into quota_ledger")) return { rows: [], rowCount: 1 };
      if (sql.includes("from quota_ledger")) {
        return { rows: [{ object_id: OBJECT_ID, operation: "release", bytes: "-1200" }], rowCount: 1 };
      }
      if (sql.startsWith("insert into background_job")) return { rows: [], rowCount: 1 };
      if (sql.includes("from background_job")) {
        return { rows: [{
          type: "storage.file_erasure.v1",
          payload: { operation: "user_file_delete", objectId: OBJECT_ID, storageKey: STORAGE_KEY },
        }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
  });

  it("locks the owner object, tombstones it, releases quota once, and enqueues a fixed opaque erasure job", async () => {
    await expect(deleteUserFile({ ownerUserId: OWNER, objectId: OBJECT_ID }, pool as never))
      .resolves.toEqual({ id: OBJECT_ID, replayed: false });
    const calls = query.mock.calls.map(([sql, values]) => ({
      sql: String(sql).replace(/\s+/g, " ").trim().toLowerCase(),
      values,
    }));
    const locked = calls.find((call) => call.sql.includes("from stored_object") && call.sql.includes("for update"));
    expect(locked?.values).toEqual([OBJECT_ID, OWNER]);
    expect(calls.find((call) => call.sql.startsWith("update stored_object"))?.sql).toContain("deleted_at is null");
    expect(calls.find((call) => call.sql.startsWith("insert into quota_ledger"))?.values).toEqual([
      OWNER, OBJECT_ID, -1200, `delete:${OBJECT_ID}`,
    ]);
    const job = calls.find((call) => call.sql.startsWith("insert into background_job"));
    expect(job?.values).toEqual([
      "storage.file_erasure.v1",
      JSON.stringify({ operation: "user_file_delete", objectId: OBJECT_ID, storageKey: STORAGE_KEY }),
      `file-erasure:user-file-delete:${OBJECT_ID}`,
      expect.any(Date),
    ]);
    expect(calls.at(-1)?.sql).toBe("commit");
  });

  it("repairs missing idempotent side effects and returns the same 202 outcome on replay", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from stored_object") && sql.includes("for update")) {
        return { rows: [{ id: OBJECT_ID, storage_key: STORAGE_KEY, size_bytes: "1200", deleted_at: new Date() }], rowCount: 1 };
      }
      if (sql.startsWith("insert into quota_ledger") || sql.startsWith("insert into background_job")) return { rows: [], rowCount: 1 };
      if (sql.includes("from quota_ledger")) return { rows: [{ object_id: OBJECT_ID, operation: "release", bytes: "-1200" }], rowCount: 1 };
      if (sql.includes("from background_job")) return { rows: [{ type: "storage.file_erasure.v1", payload: { operation: "user_file_delete", objectId: OBJECT_ID, storageKey: STORAGE_KEY } }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(deleteUserFile({ ownerUserId: OWNER, objectId: OBJECT_ID }, pool as never))
      .resolves.toEqual({ id: OBJECT_ID, replayed: true });
    expect(query.mock.calls.some(([sql]) => String(sql).toLowerCase().startsWith("update stored_object"))).toBe(false);
  });

  it("returns not found without quota or job mutation for another owner", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "commit"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from stored_object") && sql.includes("for update")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(deleteUserFile({ ownerUserId: OWNER, objectId: OBJECT_ID }, pool as never)).resolves.toBeNull();
    expect(query.mock.calls.some(([sql]) => String(sql).toLowerCase().startsWith("insert"))).toBe(false);
  });

  it("fails closed if an existing quota release or erasure job has a mismatched payload", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "rollback"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("from stored_object") && sql.includes("for update")) return { rows: [{ id: OBJECT_ID, storage_key: STORAGE_KEY, size_bytes: "1200", deleted_at: new Date() }], rowCount: 1 };
      if (sql.startsWith("insert into quota_ledger")) return { rows: [], rowCount: 0 };
      if (sql.includes("from quota_ledger")) return { rows: [{ object_id: OBJECT_ID, operation: "release", bytes: "-1" }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(deleteUserFile({ ownerUserId: OWNER, objectId: OBJECT_ID }, pool as never))
      .rejects.toBeInstanceOf(FileDeletionInvariantError);
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("destroys the client and never rolls back after a lost COMMIT response", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "commit") throw new Error("connection lost after commit");
      if (sql === "begin" || sql.startsWith("insert") || sql.startsWith("update")) return { rows: [], rowCount: 1 };
      if (sql.includes("from stored_object")) return { rows: [{ id: OBJECT_ID, storage_key: STORAGE_KEY, size_bytes: "1200", deleted_at: null }], rowCount: 1 };
      if (sql.includes("from quota_ledger")) return { rows: [{ object_id: OBJECT_ID, operation: "release", bytes: "-1200" }], rowCount: 1 };
      if (sql.includes("from background_job")) return { rows: [{ type: "storage.file_erasure.v1", payload: { operation: "user_file_delete", objectId: OBJECT_ID, storageKey: STORAGE_KEY } }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(deleteUserFile({ ownerUserId: OWNER, objectId: OBJECT_ID }, pool as never))
      .rejects.toBeInstanceOf(FileDeletionCommitAmbiguousError);
    expect(query.mock.calls.some(([sql]) => String(sql).trim().toLowerCase() === "rollback")).toBe(false);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("destroys the client when rollback rejects", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "rollback") throw new Error("rollback failed");
      if (sql === "begin" || sql.startsWith("insert")) return { rows: [], rowCount: 1 };
      if (sql.includes("from stored_object")) return { rows: [{ id: OBJECT_ID, storage_key: STORAGE_KEY, size_bytes: "1200", deleted_at: new Date() }], rowCount: 1 };
      if (sql.includes("from quota_ledger")) return { rows: [{ object_id: OBJECT_ID, operation: "release", bytes: "-1" }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(deleteUserFile({ ownerUserId: OWNER, objectId: OBJECT_ID }, pool as never))
      .rejects.toBeInstanceOf(FileDeletionInvariantError);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("bounds a hung rollback before destroying the client", async () => {
    query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "rollback") return new Promise(() => undefined);
      if (sql === "begin" || sql.startsWith("insert")) return { rows: [], rowCount: 1 };
      if (sql.includes("from stored_object")) return { rows: [{ id: OBJECT_ID, storage_key: STORAGE_KEY, size_bytes: "1200", deleted_at: new Date() }], rowCount: 1 };
      if (sql.includes("from quota_ledger")) return { rows: [{ object_id: OBJECT_ID, operation: "release", bytes: "-1" }], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(deleteUserFile(
      { ownerUserId: OWNER, objectId: OBJECT_ID },
      pool as never,
      { rollbackTimeoutMs: 5 },
    )).rejects.toBeInstanceOf(FileDeletionInvariantError);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});
