import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Job = {
    id: string;
    payload: {
      lifecycleRunId: string;
      objectId: string;
      storageKey: string;
      operation: "account_deletion" | "retention" | "user_file_delete";
    };
    status: string;
    attemptCount: number;
    maxAttempts: number;
    lastErrorCode: string | null;
    leaseOwner: string | null;
  };
  const jobs: Job[] = [];
  const query = vi.fn(async (statement: string, values: unknown[] = []) => {
    const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("select pg_advisory_")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("insert into background_job")) return { rows: [], rowCount: 1 };
    if (sql.includes("file-erasure idempotency") || (sql.includes("from background_job") && sql.includes("not exists"))) {
      return { rows: [{ count: "0" }], rowCount: 1 };
    }
    if (sql.startsWith("with candidate as")) {
      const userDelete = sql.includes("payload ->> 'operation' = 'user_file_delete'");
      const runId = String(values[1]);
      const job = jobs.find((candidate) => {
        const scopeMatches = userDelete
          ? candidate.payload.operation === "user_file_delete"
          : candidate.payload.lifecycleRunId === runId;
        return scopeMatches
          && candidate.attemptCount < candidate.maxAttempts
          && ["queued", "failed"].includes(candidate.status);
      });
      if (!job) return { rows: [], rowCount: 0 };
      job.status = "leased";
      job.leaseOwner = String(values[userDelete ? 2 : 3]);
      return { rows: [{ id: job.id, payload: job.payload }], rowCount: 1 };
    }
    if (sql.startsWith("update background_job") && sql.includes("status = 'succeeded'")) {
      const job = jobs.find((candidate) => candidate.id === values[0] && candidate.leaseOwner === values[1]);
      if (!job) return { rows: [], rowCount: 0 };
      job.status = "succeeded";
      job.attemptCount += 1;
      job.lastErrorCode = values[2] === null ? null : String(values[2]);
      job.leaseOwner = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("update background_job") && sql.includes("status = 'failed'")) {
      const job = jobs.find((candidate) => candidate.id === values[0] && candidate.leaseOwner === values[1]);
      if (!job) return { rows: [], rowCount: 0 };
      job.status = "failed";
      job.attemptCount += 1;
      job.lastErrorCode = String(values[2]);
      job.leaseOwner = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("select count(*)::int total")) {
      const runJobs = jobs.filter((job) => job.payload.lifecycleRunId === values[1]);
      return {
        rows: [{
          total: runJobs.length,
          removed: runJobs.filter((job) => job.status === "succeeded" && job.lastErrorCode === null).length,
          already_absent: runJobs.filter((job) => job.status === "succeeded" && job.lastErrorCode === "FILE_ALREADY_ABSENT").length,
          failed: runJobs.filter((job) => job.status === "failed").length,
          pending: runJobs.filter((job) => !["succeeded", "failed"].includes(job.status)).length,
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("select count(*)::int as exhausted")) {
      return {
        rows: [{
          exhausted: jobs.filter((job) => (
            job.payload.operation === "user_file_delete"
            && job.status !== "succeeded"
            && job.attemptCount >= job.maxAttempts
          )).length,
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("delete from background_job")) {
      if (sql.includes("status = 'leased'") && sql.includes("lease_owner")) {
        const index = jobs.findIndex(
          (candidate) => candidate.id === values[0] && candidate.leaseOwner === values[1],
        );
        if (index < 0) return { rows: [], rowCount: 0 };
        jobs.splice(index, 1);
        return { rows: [], rowCount: 1 };
      }
      const runId = String(values[1]);
      const before = jobs.length;
      for (let index = jobs.length - 1; index >= 0; index -= 1) {
        if (jobs[index]?.payload.lifecycleRunId === runId && jobs[index]?.status === "succeeded") jobs.splice(index, 1);
      }
      return { rows: [], rowCount: before - jobs.length };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return {
    jobs,
    query,
    client,
    connect: vi.fn(async () => client),
    unlink: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: mocks.unlink };
});

import {
  enqueueFileErasures,
  FileErasureError,
  processFileErasures,
  processUserFileErasures,
  purgeCompletedFileErasureJobs,
} from "../file-erasure";

const RUN_ID = "c1000000-0000-4000-8000-000000000001";
const ROOT = "C:/safe-object-root";
const preparePath = async (root: string, storageKey: string) => `${root}/${storageKey}`;

function addJob(index: number, storageKey = `owner/c2000000-0000-4000-8000-00000000000${index}`) {
  mocks.jobs.push({
    id: `d1000000-0000-4000-8000-00000000000${index}`,
    payload: {
      lifecycleRunId: RUN_ID,
      objectId: `c2000000-0000-4000-8000-00000000000${index}`,
      storageKey,
      operation: "account_deletion" as const,
    },
    status: "queued",
    attemptCount: 0,
    maxAttempts: 100,
    lastErrorCode: null,
    leaseOwner: null,
  });
}

describe("durable file-erasure state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobs.splice(0);
    mocks.unlink.mockResolvedValue(undefined);
  });

  it("treats ENOENT as terminal success and publishes exact durable outcomes", async () => {
    addJob(1);
    addJob(2);
    mocks.unlink
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("already absent"), { code: "ENOENT" }));
    const syncParentDirectory = vi.fn(async () => undefined);

    await expect(processFileErasures({ lifecycleRunId: RUN_ID, objectStorageRoot: ROOT, unlinkFile: mocks.unlink, preparePath, syncParentDirectory }))
      .resolves.toEqual({
        total: 2,
        removed: 1,
        alreadyAbsent: 1,
        failed: 0,
        pending: 0,
        complete: true,
      });
    expect(mocks.jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
    expect(mocks.jobs.map((job) => job.attemptCount)).toEqual([1, 1]);
    expect(syncParentDirectory).toHaveBeenCalledTimes(2);
  });

  it("does not treat ENOENT before verified root and parent preparation as erasure success", async () => {
    addJob(1);
    const missingRoot = vi.fn(async () => {
      throw Object.assign(new Error("unmounted root"), { code: "ENOENT" });
    });
    await expect(processFileErasures({
      lifecycleRunId: RUN_ID,
      objectStorageRoot: ROOT,
      unlinkFile: mocks.unlink,
      preparePath: missingRoot,
      syncParentDirectory: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ code: "FILE_ERASURE_FAILED" });
    expect(mocks.jobs[0]).toMatchObject({ status: "failed", attemptCount: 1 });
  });

  it("records a bounded failure, returns no completion report, and retries idempotently", async () => {
    addJob(1);
    mocks.unlink.mockRejectedValueOnce(Object.assign(new Error("permission denied at a secret path"), { code: "EACCES" }));

    const syncParentDirectory = vi.fn(async () => undefined);
    await expect(processFileErasures({ lifecycleRunId: RUN_ID, objectStorageRoot: ROOT, unlinkFile: mocks.unlink, preparePath, syncParentDirectory }))
      .rejects.toEqual(new FileErasureError("FILE_ERASURE_FAILED"));
    expect(mocks.jobs[0]).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(mocks.jobs[0]?.lastErrorCode).toMatch(/^FILE_ERASURE_[0-9a-f]{12}$/);
    expect(mocks.jobs[0]?.lastErrorCode).not.toContain("secret path");

    mocks.unlink.mockResolvedValueOnce(undefined);
    await expect(processFileErasures({ lifecycleRunId: RUN_ID, objectStorageRoot: ROOT, unlinkFile: mocks.unlink, preparePath, syncParentDirectory }))
      .resolves.toMatchObject({ complete: true, removed: 1 });
    expect(mocks.jobs[0]).toMatchObject({ status: "succeeded", attemptCount: 2 });
  });

  it("rejects a corrupted traversal key before unlink and leaves retryable durable evidence", async () => {
    addJob(1, "../outside/c2000000-0000-4000-8000-000000000001");
    await expect(processFileErasures({ lifecycleRunId: RUN_ID, objectStorageRoot: ROOT, unlinkFile: mocks.unlink }))
      .rejects.toMatchObject({ code: "FILE_ERASURE_FAILED" });
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.jobs[0]).toMatchObject({ status: "failed", attemptCount: 1 });
  });

  it("does not publish success when unlink succeeds but parent sync fails, then repairs via verified ENOENT retry", async () => {
    addJob(1);
    const syncParentDirectory = vi.fn()
      .mockRejectedValueOnce(new Error("directory fsync failed"))
      .mockResolvedValueOnce(undefined);
    mocks.unlink
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("already absent"), { code: "ENOENT" }));
    await expect(processFileErasures({
      lifecycleRunId: RUN_ID,
      objectStorageRoot: ROOT,
      unlinkFile: mocks.unlink,
      preparePath,
      syncParentDirectory,
    })).rejects.toMatchObject({ code: "FILE_ERASURE_FAILED" });
    expect(mocks.jobs[0]).toMatchObject({ status: "failed", attemptCount: 1 });
    await expect(processFileErasures({
      lifecycleRunId: RUN_ID,
      objectStorageRoot: ROOT,
      unlinkFile: mocks.unlink,
      preparePath,
      syncParentDirectory,
    })).resolves.toMatchObject({ complete: true, alreadyAbsent: 1 });
    expect(syncParentDirectory).toHaveBeenCalledTimes(2);
  });

  it("purges completed user-delete coordinates without stealing account or retention work", async () => {
    addJob(1);
    mocks.jobs.push({
      id: "d1000000-0000-4000-8000-000000000002",
      payload: {
        lifecycleRunId: "",
        objectId: "c2000000-0000-4000-8000-000000000002",
        storageKey: "owner/c2000000-0000-4000-8000-000000000002",
        operation: "user_file_delete",
      },
      status: "queued",
      attemptCount: 0,
      maxAttempts: 100,
      lastErrorCode: null,
      leaseOwner: null,
    });
    const eraseObject = vi.fn(async () => ({ alreadyAbsent: false }));
    await expect(processUserFileErasures({
      objectStorageRoot: ROOT,
      limit: 1,
      eraseObject,
    })).resolves.toEqual({ processed: 1, removed: 1, alreadyAbsent: 0, failed: 0, exhausted: 0 });
    expect(mocks.jobs[0]).toMatchObject({ status: "queued", attemptCount: 0 });
    expect(mocks.jobs).toHaveLength(1);
    expect(JSON.stringify(mocks.jobs)).not.toContain("user_file_delete");
    expect(JSON.stringify(mocks.jobs)).not.toContain("owner/c2000000-0000-4000-8000-000000000002");
    const purge = mocks.query.mock.calls.find(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase().startsWith("delete from background_job")
      && String(sql).includes("lease_owner")
    ));
    expect(purge?.[1]).toEqual(["d1000000-0000-4000-8000-000000000002", expect.stringMatching(/^file-erasure:user-delete:/)]);
    expect(eraseObject).toHaveBeenCalledWith("owner/c2000000-0000-4000-8000-000000000002");
  });

  it("reports exhausted user-delete jobs so worker health cannot silently turn green", async () => {
    mocks.jobs.push({
      id: "d1000000-0000-4000-8000-000000000003",
      payload: {
        lifecycleRunId: "",
        objectId: "c2000000-0000-4000-8000-000000000003",
        storageKey: "owner/c2000000-0000-4000-8000-000000000003",
        operation: "user_file_delete",
      },
      status: "failed",
      attemptCount: 8,
      maxAttempts: 8,
      lastErrorCode: "FILE_ERASURE_deadbeef0000",
      leaseOwner: null,
    });

    await expect(processUserFileErasures({
      objectStorageRoot: ROOT,
      eraseObject: vi.fn(async () => ({ alreadyAbsent: false })),
    })).resolves.toEqual({ processed: 0, removed: 0, alreadyAbsent: 0, failed: 0, exhausted: 1 });
  });

  it("enqueues only opaque lifecycle/object coordinates and purges keys at durable completion", async () => {
    await expect(enqueueFileErasures(mocks.client as never, {
      lifecycleRunId: RUN_ID,
      operation: "retention",
      objects: [{ id: "c2000000-0000-4000-8000-000000000001", storageKey: "owner/c2000000-0000-4000-8000-000000000001" }],
      now: new Date("2026-07-14T00:00:00.000Z"),
    })).resolves.toBe(1);
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("insert into background_job"));
    expect(String(insert?.[0])).not.toMatch(/userId|learnerId|email/i);

    addJob(1);
    mocks.jobs[0]!.status = "succeeded";
    await expect(purgeCompletedFileErasureJobs(mocks.client as never, RUN_ID)).resolves.toBe(1);
    expect(mocks.jobs).toHaveLength(0);
  });
});
