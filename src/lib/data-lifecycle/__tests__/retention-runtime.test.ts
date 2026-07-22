import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    claim: "new" as "new" | "replay" | "running" | "failed" | "mismatch" | "resume_failed" | "resume_running",
    failCount: false,
  };
  const query = vi.fn(async (statement: string, _values?: unknown[]) => {
    const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("insert into data_lifecycle_run")) {
      return state.claim === "new" ? { rows: [{ id: "retention-run-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("from data_lifecycle_run where idempotency_key")) {
      const status = state.claim === "replay" ? "succeeded" : state.claim === "running" ? "running" : "failed";
      const resume = state.claim === "resume_failed" || state.claim === "resume_running";
      return {
        rows: [{
          id: "existing-run",
          operation: state.claim === "mismatch" ? "export" : "retention",
          policy_version: "2026-07-14.v4",
          dry_run: resume ? false : true,
          cutoff_matches: state.claim !== "mismatch",
          status: state.claim === "resume_running" ? "running" : status,
          report: resume ? {
            phase: "file_erasure_pending",
            evaluatedAt: "2026-07-12T00:00:00.000Z",
            cutoffs: {},
            categories: { objects: { eligible: 2, deleted: 2, retained: 0, hasMore: false } },
          } : {
            runId: "existing-run",
            policyVersion: "2026-07-14.v4",
            dryRun: true,
            evaluatedAt: "2026-07-12T00:00:00.000Z",
            cutoffs: {},
            categories: {},
            objectFiles: { removed: 0, alreadyAbsent: 0, failed: 0 },
            replayed: false,
          },
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("select count(*)")) {
      if (state.failCount) throw new TypeError("synthetic count failure");
      return { rows: [{ count: "2" }], rowCount: 1 };
    }
    if (sql.startsWith("select id from model_call")) {
      return { rows: [{ id: "d1000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    }
    if (sql.startsWith("select id, storage_key from stored_object")) {
      return {
        rows: [
          { id: "d2000000-0000-4000-8000-000000000001", storage_key: "owner/object-1" },
          { id: "d2000000-0000-4000-8000-000000000002", storage_key: "owner/object-2" },
        ],
        rowCount: 2,
      };
    }
    if (sql.startsWith("delete from stored_object where id = any")) {
      return { rows: [], rowCount: Array.isArray(_values?.[0]) ? _values[0].length : 0 };
    }
    return { rows: [{ id: "row-1" }], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return {
    state,
    query,
    client,
    connect: vi.fn(async () => client),
    unlink: vi.fn(async () => undefined),
    resolveStoredObjectPath: vi.fn((root: string, key: string) => `${root}/${key}`),
    enqueueFileErasures: vi.fn(async () => 2),
    processFileErasures: vi.fn(async () => ({ total: 2, removed: 1, alreadyAbsent: 1, failed: 0, pending: 0, complete: true })),
    purgeCompletedFileErasureJobs: vi.fn(async () => 2),
  };
});

vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, unlink: mocks.unlink }, unlink: mocks.unlink };
});
vi.mock("@/lib/storage/upload-scanner", () => ({ resolveStoredObjectPath: mocks.resolveStoredObjectPath }));
vi.mock("../file-erasure", () => ({
  enqueueFileErasures: mocks.enqueueFileErasures,
  processFileErasures: mocks.processFileErasures,
  purgeCompletedFileErasureJobs: mocks.purgeCompletedFileErasureJobs,
}));

import { RetentionRunConflictError, runRetention } from "../retention";

const now = new Date("2026-07-12T00:00:00.000Z");

describe("retention runtime orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.claim = "new";
    mocks.state.failCount = false;
    mocks.unlink.mockResolvedValue(undefined);
    mocks.enqueueFileErasures.mockResolvedValue(2);
    mocks.processFileErasures.mockResolvedValue({ total: 2, removed: 1, alreadyAbsent: 1, failed: 0, pending: 0, complete: true });
    mocks.purgeCompletedFileErasureJobs.mockResolvedValue(2);
  });

  it("builds a non-mutating dry-run report with retained counts and releases the global lock", async () => {
    const report = await runRetention({
      idempotencyKey: "retention:test:dry-run",
      dryRun: true,
      batchSize: 5,
      now,
    });
    expect(report).toMatchObject({
      runId: "retention-run-1",
      dryRun: true,
      replayed: false,
      objectFiles: { removed: 0, alreadyAbsent: 0, failed: 0 },
    });
    expect(report.categories.rawChat).toMatchObject({ eligible: 2, deleted: 0, retained: 2, hasMore: true, note: "dry-run" });
    expect(report.categories.tutorReplayReceipts).toMatchObject({ eligible: 2, deleted: 0, retained: 2, hasMore: true });
    expect(report.categories.stalePendingRevocationRequests).toMatchObject({ transitioned: 0 });
    expect(report.categories.adminAudit.note).toContain("no automatic audit purge");
    expect(report.categories.masteryAndOfficialEvidence.note).toContain("account deletion");
    expect(report.categories.learnerDraftsAndSyncReceipts).toMatchObject({ eligible: 2, deleted: 0 });
    expect(report.categories.learnerDraftsAndSyncReceipts.note).toContain("browser session cache is not a backup");
    expect(report.categories.projectRevisionHistory).toMatchObject({ eligible: 2, deleted: 0 });
    expect(report.categories.projectRevisionHistory.note).toContain("administrator account deletion");
    expect(report.categories.certificatesAndPublicPortfolio).toMatchObject({ eligible: 2, deleted: 0 });
    expect(report.categories.certificatesAndPublicPortfolio.note).toContain("Certificate evidence");
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith("select pg_advisory_unlock(hashtext('learncoding:data-lifecycle-retention'))");
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
  });

  it("applies bounded deletes, severs model references, expires requests, and safely removes object files", async () => {
    mocks.unlink
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("already absent"), { code: "ENOENT" }));
    const report = await runRetention({
      idempotencyKey: "retention:test:apply",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });
    expect(report.dryRun).toBe(false);
    expect(report.objectFiles).toEqual({ removed: 1, alreadyAbsent: 1, failed: 0 });
    expect(report.categories.rawChat).toMatchObject({ eligible: 2, deleted: 1, retained: 1, hasMore: true });
    expect(report.categories.tutorReplayReceipts).toMatchObject({ eligible: 2, deleted: 1, retained: 1, hasMore: true });
    expect(report.categories.aiRequestMetadata.deleted).toBe(1);
    expect(report.categories.securitySessionHistory.deleted).toBe(2);
    expect(report.categories.stalePendingRevocationRequests.transitioned).toBe(1);
    expect(report.categories.backupExpiryEligibility.note).toContain("no backup erasure");
    expect(report.categories.objects).toMatchObject({ eligible: 2, deleted: 2, retained: 0, hasMore: false });
    expect(mocks.enqueueFileErasures).toHaveBeenCalledWith(mocks.client, expect.objectContaining({
      lifecycleRunId: "retention-run-1",
      operation: "retention",
    }));
    expect(mocks.processFileErasures).toHaveBeenCalledWith({
      lifecycleRunId: "retention-run-1",
      objectStorageRoot: "C:/retention-objects",
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("update chat_message set model_call_id = null"))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("delete from provider_operation_receipt"))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("set status = 'expired'"))).toBe(true);
  });

  it("uses an explicitly supplied erasure processor without changing the production default", async () => {
    const processFileErasures = vi.fn(async () => ({
      total: 2,
      removed: 2,
      alreadyAbsent: 0,
      failed: 0,
      pending: 0,
      complete: true,
    }));

    await expect(runRetention({
      idempotencyKey: "retention:test:injected-erasure",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    }, { processFileErasures })).resolves.toMatchObject({
      objectFiles: { removed: 2, alreadyAbsent: 0, failed: 0 },
    });

    expect(processFileErasures).toHaveBeenCalledWith({
      lifecycleRunId: "retention-run-1",
      objectStorageRoot: "C:/retention-objects",
    });
    expect(mocks.processFileErasures).not.toHaveBeenCalled();
  });

  it("uses the explicitly supplied erasure processor when resuming a durable checkpoint", async () => {
    mocks.state.claim = "resume_running";
    const processFileErasures = vi.fn(async () => ({
      total: 2,
      removed: 0,
      alreadyAbsent: 2,
      failed: 0,
      pending: 0,
      complete: true,
    }));

    await expect(runRetention({
      idempotencyKey: "retention:test:resume-injected-erasure",
      dryRun: false,
      now,
      objectStorageRoot: "C:/retention-objects",
    }, { processFileErasures })).resolves.toMatchObject({
      runId: "existing-run",
      objectFiles: { removed: 0, alreadyAbsent: 2, failed: 0 },
    });

    expect(processFileErasures).toHaveBeenCalledWith({
      lifecycleRunId: "existing-run",
      objectStorageRoot: "C:/retention-objects",
    });
    expect(mocks.processFileErasures).not.toHaveBeenCalled();
  });

  it.each([
    ["running", "RUN_IN_PROGRESS"],
    ["failed", "PREVIOUS_RUN_FAILED"],
    ["mismatch", "IDEMPOTENCY_MISMATCH"],
  ] as const)("returns the stable %s claim conflict", async (claim, code) => {
    mocks.state.claim = claim;
    await expect(runRetention({
      idempotencyKey: "retention:test:existing",
      dryRun: true,
      now,
    })).rejects.toMatchObject({ code });
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
  });

  it("replays a completed run without reapplying deletes", async () => {
    mocks.state.claim = "replay";
    await expect(runRetention({
      idempotencyKey: "retention:test:replay",
      dryRun: true,
      now,
    })).resolves.toMatchObject({ runId: "existing-run", replayed: true });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it.each(["resume_failed", "resume_running"] as const)("recovers a %s file-erasure checkpoint without repeating metadata deletes", async (claim) => {
    mocks.state.claim = claim;
    await expect(runRetention({
      idempotencyKey: "retention:test:recover-files",
      dryRun: false,
      now,
      objectStorageRoot: "C:/retention-objects",
    })).resolves.toMatchObject({
      runId: "existing-run",
      categories: { objects: { deleted: 2 } },
      objectFiles: { removed: 1, alreadyAbsent: 1, failed: 0 },
    });
    expect(mocks.processFileErasures).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith("select count(*)"))).toBe(false);
  });

  it("records a safe hashed failure code and always unlocks", async () => {
    mocks.state.failCount = true;
    await expect(runRetention({
      idempotencyKey: "retention:test:failure",
      dryRun: true,
      now,
    })).rejects.toThrow("synthetic count failure");
    const failedUpdate = mocks.query.mock.calls.find(([sql]) => String(sql).includes("status = 'failed'"));
    expect(failedUpdate?.[1]?.[1]).toMatch(/^RETENTION_[0-9a-f]{12}$/);
    expect(String(failedUpdate?.[1]?.[1])).not.toContain("TypeError");
    expect(mocks.query).toHaveBeenCalledWith("select pg_advisory_unlock(hashtext('learncoding:data-lifecycle-retention'))");
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
  });

  it("retains typed conflict semantics", () => {
    expect(new RetentionRunConflictError("RUN_IN_PROGRESS")).toMatchObject({ code: "RUN_IN_PROGRESS" });
  });
});
