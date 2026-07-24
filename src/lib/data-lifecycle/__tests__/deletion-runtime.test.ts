import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    mode: "success" as
      | "success"
      | "admin_denied"
      | "missing_learner"
      | "already_deleted"
      | "run_running"
      | "run_checkpoint"
      | "provider_in_flight"
      | "runner_in_flight"
      | "rehearsal_in_flight"
      | "mail_boundary_race"
      | "mail_quarantined_unresolved"
      | "mail_sending_with_provider_id"
      | "mail_quarantined_resolved"
      | "notice_conflict_mismatch",
  };
  const query = vi.fn(async (statement: string, values: unknown[] = []) => {
    const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.includes('select role, status from "user"')) {
      return { rows: state.mode === "admin_denied" ? [{ role: "learner", status: "active" }] : [{ role: "admin", status: "active" }], rowCount: 1 };
    }
    if (sql.includes('select id, email, role, status from "user"')) {
      if (state.mode === "missing_learner") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: "learner-1",
          email: "learner@example.test",
          role: "learner",
          status: state.mode === "already_deleted" ? "deleted" : "active",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("from account_deletion_tombstone where user_id")) {
      return {
        rows: [{
          backup_status: "awaiting_retention_expiry",
          report: {
            runId: "old-run",
            tombstoneId: "old-tombstone",
            policyVersion: "2026-07-12.v3",
            primaryStoreDeletionComplete: true,
            deletedRows: {},
            deletedObjectFiles: 0,
            alreadyAbsentObjectFiles: 0,
            backupStatus: "awaiting_retention_expiry",
            backupRetentionUntil: "2027-07-12T00:00:00.000Z",
            backupNotice: "Backups remain retained.",
            learnerNotificationQueued: true,
            replayed: false,
          },
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("select exists (") && sql.includes("provider_operation_receipt")) {
      const blocksUnresolvedQuarantine = state.mode === "mail_quarantined_unresolved"
        && sql.includes("'quarantined'")
        && sql.includes("provider_message_id is null");
      const blocksSendingWithProviderId = state.mode === "mail_sending_with_provider_id"
        && sql.includes("status = 'sending'")
        && sql.includes("provider_call_started is not null");
      return {
        rows: [{
          blocked: state.mode === "provider_in_flight"
            || blocksUnresolvedQuarantine
            || blocksSendingWithProviderId,
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("select id, status, provider_call_started, provider_message_id from email_outbox")) {
      const rows = state.mode === "mail_boundary_race"
        ? [{
            id: "c3000000-0000-4000-8000-000000000001",
            status: "sending",
            provider_call_started: new Date("2026-07-12T00:00:01.000Z"),
            provider_message_id: null,
          }]
        : state.mode === "mail_quarantined_unresolved"
          ? [{
              id: "c3000000-0000-4000-8000-000000000002",
              status: "quarantined",
              provider_call_started: new Date("2026-07-12T00:00:01.000Z"),
              provider_message_id: null,
            }]
          : state.mode === "mail_quarantined_resolved"
            ? [{
                id: "c3000000-0000-4000-8000-000000000003",
                status: "quarantined",
                provider_call_started: new Date("2026-07-12T00:00:01.000Z"),
                provider_message_id: "gmail-accepted-1",
              }]
          : state.mode === "mail_sending_with_provider_id"
            ? [{
                id: "c3000000-0000-4000-8000-000000000004",
                status: "sending",
                provider_call_started: new Date("2026-07-12T00:00:01.000Z"),
                provider_message_id: "gmail-accepted-while-sending",
              }]
        : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("select exists (") && sql.includes("from code_submission")) {
      return {
        rows: [{ blocked: ["runner_in_flight", "rehearsal_in_flight"].includes(state.mode) }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("insert into data_lifecycle_run")) {
      return ["run_running", "run_checkpoint"].includes(state.mode) ? { rows: [], rowCount: 0 } : { rows: [{ id: "run-1" }], rowCount: 1 };
    }
    if (sql.includes("select id, status, report from data_lifecycle_run")) {
      return {
        rows: [{
          id: "run-existing",
          status: "running",
          report: state.mode === "run_checkpoint"
            ? { phase: "file_erasure_pending", deletedRows: { storedObjects: 1 } }
            : {},
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith("select id, storage_key from stored_object")) {
      return { rows: [{ id: "object-1", storage_key: "owner/object-1" }], rowCount: 1 };
    }
    if (sql.startsWith('select status from "user"')) {
      return { rows: [{ status: "deletion_pending" }], rowCount: 1 };
    }
    if (sql.startsWith("select id from access_request")) {
      return { rows: [{ id: "c1000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    }
    if (
      sql.startsWith("insert into email_outbox")
      && sql.includes("(id, operation_id")
      && sql.includes("'account-deleted'")
    ) {
      if (state.mode === "notice_conflict_mismatch") {
        return { rows: [], rowCount: 0 };
      }
      const [id, operationId, userId, toEmail, rawVariables, idempotencyKey] = values;
      return {
        rows: [{
          id,
          operation_id: operationId,
          user_id: userId,
          delivery_scope_key: `a:${String(userId)}`,
          to_email: String(toEmail).toLowerCase(),
          template: "account-deleted",
          template_version: "1",
          variables: JSON.parse(String(rawVariables)),
          idempotency_key: idempotencyKey,
        }],
        rowCount: 1,
      };
    }
    if (
      sql.startsWith("select id::text, operation_id::text, user_id")
      && sql.includes("from email_outbox")
      && sql.includes("idempotency_key")
    ) {
      return {
        rows: [{
          id: "c3000000-0000-4000-8000-000000000099",
          operation_id: "c4000000-0000-4000-8000-000000000099",
          user_id: "learner-1",
          delivery_scope_key: "a:learner-1",
          to_email: "attacker@example.test",
          template: "account-deleted",
          template_version: "1",
          variables: {
            backupRetentionUntil: "2027-07-12T00:00:00.000Z",
            tombstoneId: "c5000000-0000-4000-8000-000000000099",
            deletionRunId: "run-1",
          },
          idempotency_key: values[0],
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return {
    state,
    query,
    client,
    connect: vi.fn(async () => client),
    poolQuery: vi.fn(async (): Promise<{ rows: unknown[]; rowCount: number }> => ({ rows: [], rowCount: 1 })),
    unlink: vi.fn(async () => undefined),
    resolveStoredObjectPath: vi.fn((root: string, key: string) => `${root}/${key}`),
    enqueueFileErasures: vi.fn(async () => 1),
    processFileErasures: vi.fn(async () => ({ total: 1, removed: 1, alreadyAbsent: 0, failed: 0, pending: 0, complete: true })),
    fileErasureSummary: vi.fn(async () => ({ total: 1, removed: 1, alreadyAbsent: 0, failed: 0, pending: 0, complete: true })),
    purgeCompletedFileErasureJobs: vi.fn(async () => 1),
  };
});

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect, query: mocks.poolQuery },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, default: { ...actual, unlink: mocks.unlink }, unlink: mocks.unlink };
});
vi.mock("@/lib/storage/upload-scanner", () => ({ resolveStoredObjectPath: mocks.resolveStoredObjectPath }));
vi.mock("../file-erasure", () => {
  class FileErasureError extends Error {
    constructor(public readonly code: "FILE_ERASURE_FAILED" | "FILE_ERASURE_INCOMPLETE") {
      super(code);
    }
  }
  return {
    enqueueFileErasures: mocks.enqueueFileErasures,
    processFileErasures: mocks.processFileErasures,
    fileErasureSummary: mocks.fileErasureSummary,
    purgeCompletedFileErasureJobs: mocks.purgeCompletedFileErasureJobs,
    FileErasureError,
  };
});

import {
  AccountDeletionError,
  backupExpiryReport,
  deleteLearnerAccount,
} from "../deletion";
import { FileErasureError } from "../file-erasure";

const input = {
  actorUserId: "admin-1",
  learnerId: "learner-1",
  requestId: "c2000000-0000-4000-8000-000000000001",
  reason: "Learner confirmed permanent account deletion",
  now: new Date("2026-07-12T00:00:00.000Z"),
  objectStorageRoot: "C:/safe-objects",
};

describe("account deletion runtime orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.mode = "success";
    mocks.unlink.mockResolvedValue(undefined);
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.enqueueFileErasures.mockResolvedValue(1);
    mocks.processFileErasures.mockResolvedValue({ total: 1, removed: 1, alreadyAbsent: 0, failed: 0, pending: 0, complete: true });
    mocks.fileErasureSummary.mockResolvedValue({ total: 1, removed: 1, alreadyAbsent: 0, failed: 0, pending: 0, complete: true });
    mocks.purgeCompletedFileErasureJobs.mockResolvedValue(1);
    process.env.DELETION_TOMBSTONE_KEY = "deletion-test-secret-that-is-at-least-32-bytes";
  });
  afterEach(() => {
    delete process.env.DELETION_TOMBSTONE_KEY;
  });

  it("erases object files, pseudonymizes the account, queues notice, and commits a truthful tombstone", async () => {
    const report = await deleteLearnerAccount(input);
    expect(report).toMatchObject({
      runId: "run-1",
      primaryStoreDeletionComplete: true,
      objectFileErasureComplete: true,
      deletedObjectFiles: 1,
      alreadyAbsentObjectFiles: 0,
      backupStatus: "awaiting_retention_expiry",
      learnerNotificationQueued: true,
      replayed: false,
    });
    expect(report.backupRetentionUntil).toBe("2027-07-12T00:00:00.000Z");
    expect(mocks.enqueueFileErasures).toHaveBeenCalledWith(mocks.client, expect.objectContaining({
      lifecycleRunId: "run-1",
      operation: "account_deletion",
      objects: [{ id: "object-1", storageKey: "owner/object-1" }],
    }));
    expect(mocks.processFileErasures).toHaveBeenCalledWith({
      lifecycleRunId: "run-1",
      objectStorageRoot: "C:/safe-objects",
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("account_deletion_tombstone"))).toBe(true);
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.findIndex((sql) => sql.includes("delete from learner_draft_mutation")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from learner_draft where")));
    expect(statements).toContain("delete from code_submission where user_id = $1");
    expect(statements).toContain(
      "delete from runner_power_rehearsal_event where (learner_one_id = $1 or learner_two_id = $1) and state in ('released','aborted')",
    );
    expect(statements.findIndex((sql) => sql.includes("delete from runner_power_rehearsal_event")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from code_submission")));
    expect(statements.findIndex((sql) => sql.includes("delete from code_submission")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("name = 'Deleted learner'")));
    expect(statements.findIndex((sql) => sql.includes("delete from project_revision_object")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from stored_object")));
    expect(statements.findIndex((sql) => sql.includes("delete from project_revision revision")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from project where")));
    expect(statements).toContain("select set_config('app.account_deletion_authorized', '1', true)");
    expect(statements.findIndex((sql) => sql.includes("delete from project_review_correction")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from appeal where")));
    expect(statements.findIndex((sql) => sql.includes("delete from appeal where")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from project where")));
    expect(statements).toContain("delete from module_project_start_receipt where user_id = $1");
    expect(statements.findIndex((sql) => sql.includes("delete from module_project_start_receipt")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from project where")));
    expect(statements.findIndex((sql) => sql.includes("delete from provider_operation_receipt")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from admin_fallback_reservation")));
    expect(statements.findIndex((sql) => sql.includes("delete from admin_fallback_reservation")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from admin_fallback_grant")));
    expect(statements.findIndex((sql) => sql.includes("delete from admin_fallback_grant")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("delete from provider_credential")));
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("'account-deleted'"))).toBe(true);
    const normalizedStatements = statements.map((sql) => sql.replace(/\s+/g, " ").trim());
    const outboxLockIndex = normalizedStatements.findIndex((sql) =>
      sql.startsWith("select id, status, provider_call_started, provider_message_id from email_outbox") && sql.endsWith("for update"));
    const outboxDeleteIndex = normalizedStatements.findIndex((sql) => sql.startsWith("delete from email_outbox"));
    expect(outboxLockIndex).toBeGreaterThan(-1);
    expect(outboxLockIndex).toBeLessThan(outboxDeleteIndex);
    const deletionNoticeInsert = normalizedStatements.find((sql) =>
      sql.startsWith("insert into email_outbox") && sql.includes("'account-deleted'"));
    expect(deletionNoticeInsert).toContain("id, operation_id, user_id, delivery_scope_key");
    expect(deletionNoticeInsert).toContain("'a:' || $3");
    expect(deletionNoticeInsert).toContain("returning id::text, operation_id::text");
    expect(deletionNoticeInsert).not.toContain("values (null");
    const deletionNoticeCall = (
      mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>
    ).find(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().startsWith("insert into email_outbox")
      && String(sql).includes("'account-deleted'")
    ));
    const deletionNotice = report.deletionNotice;
    expect(deletionNotice).not.toBeNull();
    if (!deletionNotice) throw new Error("New deletion report did not bind its notice.");
    expect(deletionNoticeCall?.[1]?.[0]).toBe(deletionNotice.outboxId);
    expect(deletionNoticeCall?.[1]?.[1]).toBe(deletionNotice.operationId);
    expect(deletionNoticeCall?.[1]?.[2]).toBe("learner-1");
    expect(deletionNoticeCall?.[1]?.[3]).toBe("learner@example.test");
    expect(JSON.parse(String(deletionNoticeCall?.[1]?.[4]))).toEqual({
      backupRetentionUntil: "2027-07-12T00:00:00.000Z",
      tombstoneId: report.tombstoneId,
      deletionRunId: report.runId,
    });
    expect(deletionNotice).toEqual({
      outboxId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      recipientHmacSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(deletionNotice.recipientHmacSha256).not.toContain("learner@example.test");
    const tombstoneInsert = (
      mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>
    ).find(([sql]) => String(sql).includes("insert into account_deletion_tombstone"));
    const immutableReport = JSON.parse(String(tombstoneInsert?.[1]?.[7]));
    expect(immutableReport.deletionNotice).toEqual(report.deletionNotice);
    const runSuccessUpdate = (
      mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>
    ).find(([sql]) => (
      String(sql).includes("update data_lifecycle_run set status = 'succeeded'")
    ));
    expect(JSON.parse(String(runSuccessUpdate?.[1]?.[1])).deletionNotice)
      .toEqual(report.deletionNotice);
    const authorityLocks = (mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>)
      .filter(([sql]) => String(sql).includes("pg_advisory_xact_lock(hashtext($1))"))
      .map(([, values]) => (values as string[] | undefined)?.[0]);
    expect(authorityLocks).toEqual([
      "user-authority:learner-1",
      "runner-learner:learner-1",
      "account-delete:learner-1",
      "user-authority:learner-1",
      "runner-learner:learner-1",
      "account-delete:learner-1",
      "user-authority:learner-1",
      "runner-learner:learner-1",
      "account-delete:learner-1",
    ]);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("uses an explicitly supplied erasure processor without changing the production default", async () => {
    const processFileErasures = vi.fn(async () => ({
      total: 1,
      removed: 0,
      alreadyAbsent: 1,
      failed: 0,
      pending: 0,
      complete: true,
    }));
    mocks.fileErasureSummary.mockResolvedValueOnce({
      total: 1,
      removed: 0,
      alreadyAbsent: 1,
      failed: 0,
      pending: 0,
      complete: true,
    });

    await expect(deleteLearnerAccount(input, { processFileErasures })).resolves.toMatchObject({
      deletedObjectFiles: 0,
      alreadyAbsentObjectFiles: 1,
    });

    expect(processFileErasures).toHaveBeenCalledWith({
      lifecycleRunId: "run-1",
      objectStorageRoot: "C:/safe-objects",
    });
    expect(mocks.processFileErasures).not.toHaveBeenCalled();
  });

  it("treats an absent object as already erased but fails closed for another filesystem error", async () => {
    mocks.processFileErasures.mockResolvedValueOnce({ total: 1, removed: 0, alreadyAbsent: 1, failed: 0, pending: 0, complete: true });
    mocks.fileErasureSummary.mockResolvedValueOnce({ total: 1, removed: 0, alreadyAbsent: 1, failed: 0, pending: 0, complete: true });
    await expect(deleteLearnerAccount(input)).resolves.toMatchObject({
      deletedObjectFiles: 0,
      alreadyAbsentObjectFiles: 1,
    });

    vi.clearAllMocks();
    mocks.state.mode = "success";
    mocks.connect.mockResolvedValue(mocks.client);
    mocks.processFileErasures.mockRejectedValueOnce(new FileErasureError("FILE_ERASURE_FAILED"));
    await expect(deleteLearnerAccount({ ...input, requestId: "c2000000-0000-4000-8000-000000000002" }))
      .rejects.toMatchObject({ code: "FILE_ERASURE_FAILED" });
    expect(mocks.poolQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.arrayContaining(["run-1", "FILE_ERASURE_FAILED"]));
  });

  it.each([
    ["admin_denied", "ADMIN_REQUIRED"],
    ["missing_learner", "LEARNER_NOT_FOUND"],
    ["run_running", "RUN_IN_PROGRESS"],
  ] as const)("rejects the %s claim before destructive work", async (mode, code) => {
    mocks.state.mode = mode;
    await expect(deleteLearnerAccount(input)).rejects.toMatchObject({ code });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("rejects an unreconciled provider call before claiming deletion or erasing files", async () => {
    mocks.state.mode = "provider_in_flight";
    await expect(deleteLearnerAccount(input)).rejects.toMatchObject({
      code: "PROVIDER_OPERATION_IN_PROGRESS",
    });
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into data_lifecycle_run")))
      .toBe(false);
  });

  it("rolls back if mail crosses the provider boundary after the initial conflict check", async () => {
    mocks.state.mode = "mail_boundary_race";
    await expect(deleteLearnerAccount(input)).rejects.toMatchObject({
      code: "PROVIDER_OPERATION_IN_PROGRESS",
    });
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim());
    expect(statements.some((sql) => sql.startsWith("select id, status, provider_call_started, provider_message_id from email_outbox") && sql.endsWith("for update")))
      .toBe(true);
    expect(statements.some((sql) => sql.startsWith("delete from public_portfolio"))).toBe(false);
    expect(mocks.processFileErasures).not.toHaveBeenCalled();
  });

  it("blocks an unresolved quarantined provider start but permits a reconciled quarantine", async () => {
    mocks.state.mode = "mail_quarantined_unresolved";
    await expect(deleteLearnerAccount(input)).rejects.toMatchObject({
      code: "PROVIDER_OPERATION_IN_PROGRESS",
    });
    const conflictSql = mocks.query.mock.calls
      .map(([sql]) => String(sql).replace(/\s+/g, " ").trim().toLowerCase())
      .find((sql) => sql.startsWith("select exists (") && sql.includes("provider_operation_receipt"));
    expect(conflictSql).toContain("status = 'sending' and provider_call_started is not null");
    expect(conflictSql).toContain(
      "status = 'quarantined' and provider_call_started is not null and provider_message_id is null",
    );
    expect(conflictSql).toContain("provider_message_id is null");
    expect(mocks.processFileErasures).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.state.mode = "mail_sending_with_provider_id";
    mocks.connect.mockResolvedValue(mocks.client);
    await expect(deleteLearnerAccount(input)).rejects.toMatchObject({
      code: "PROVIDER_OPERATION_IN_PROGRESS",
    });

    vi.clearAllMocks();
    mocks.state.mode = "mail_quarantined_resolved";
    mocks.connect.mockResolvedValue(mocks.client);
    await expect(deleteLearnerAccount({
      ...input,
      requestId: "c2000000-0000-4000-8000-000000000003",
    })).resolves.toMatchObject({ learnerNotificationQueued: true });
  });

  it("aborts the deletion transaction when an idempotency conflict is not the exact bound notice", async () => {
    mocks.state.mode = "notice_conflict_mismatch";
    await expect(deleteLearnerAccount(input)).rejects.toThrow(
      "Deletion notice idempotency state mismatch.",
    );
    const statements = mocks.query.mock.calls
      .map(([sql]) => String(sql).replace(/\s+/g, " ").trim().toLowerCase());
    expect(statements.some((sql) => (
      sql.startsWith("select id::text, operation_id::text, user_id")
      && sql.includes("from email_outbox")
      && sql.includes("for update")
    ))).toBe(true);
    expect(statements).toContain("rollback");
    expect(statements.some((sql) => sql.includes("status = 'succeeded'"))).toBe(false);
    expect(mocks.purgeCompletedFileErasureJobs).not.toHaveBeenCalled();
  });

  it("rejects possibly dispatched runner work before claiming deletion or erasing files", async () => {
    mocks.state.mode = "runner_in_flight";
    await expect(deleteLearnerAccount(input)).rejects.toMatchObject({
      code: "RUNNER_OPERATION_IN_PROGRESS",
    });
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into data_lifecycle_run")))
      .toBe(false);
  });

  it("rejects an active physical rehearsal before claiming deletion or erasing files", async () => {
    mocks.state.mode = "rehearsal_in_flight";
    await expect(deleteLearnerAccount(input)).rejects.toMatchObject({
      code: "RUNNER_OPERATION_IN_PROGRESS",
    });
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("runner_power_rehearsal_event")))
      .toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into data_lifecycle_run")))
      .toBe(false);
  });

  it("replays the immutable tombstone when the learner is already deleted", async () => {
    mocks.state.mode = "already_deleted";
    await expect(deleteLearnerAccount(input)).resolves.toMatchObject({
      runId: "old-run",
      tombstoneId: "old-tombstone",
      replayed: true,
      deletionNotice: null,
    });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("recovers a durable running file-erasure checkpoint under the exact same request", async () => {
    mocks.state.mode = "run_checkpoint";
    await expect(deleteLearnerAccount(input)).resolves.toMatchObject({
      runId: "run-existing",
      primaryStoreDeletionComplete: true,
      objectFileErasureComplete: true,
    });
    expect(mocks.processFileErasures).toHaveBeenCalledWith({
      lifecycleRunId: "run-existing",
      objectStorageRoot: "C:/safe-objects",
    });
  });

  it("classifies elapsed and retained backup windows without claiming erasure", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "past",
          user_id: "u1",
          primary_deletion_completed_at: new Date("2025-01-01T00:00:00Z"),
          backup_retention_until: new Date("2026-01-01T00:00:00Z"),
          backup_status: "awaiting_retention_expiry",
        },
        {
          id: "future",
          user_id: "u2",
          primary_deletion_completed_at: new Date("2026-01-01T00:00:00Z"),
          backup_retention_until: new Date("2027-01-01T00:00:00Z"),
          backup_status: "awaiting_retention_expiry",
        },
      ],
      rowCount: 2,
    });
    const report = await backupExpiryReport(new Date("2026-07-12T00:00:00Z"));
    expect(report.records.map((record) => record.retentionWindowElapsed)).toEqual([true, false]);
    expect(report.records[0]?.statement).toContain("verify every configured");
    expect(report.records[1]?.statement).toContain("No erasure is claimed");
  });

  it("uses a stable typed deletion error", () => {
    const error = new AccountDeletionError("PREVIOUS_RUN_FAILED");
    expect(error.name).toBe("Error");
    expect(error.message).toBe("PREVIOUS_RUN_FAILED");
  });
});
