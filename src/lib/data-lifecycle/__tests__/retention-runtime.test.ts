import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const mocks = vi.hoisted(() => {
  const state = {
    claim: "new" as
      | "new"
      | "replay"
      | "replay_degraded"
      | "cutoff_mismatch"
      | "running"
      | "failed"
      | "mismatch"
      | "resume_failed"
      | "resume_running"
      | "resume_stored"
      | "resume_relational"
      | "resume_degraded_file"
      | "resume_degraded_relational"
      | "resume_oldest"
      | "resume_oldest_relational"
      | "replay_with_unrelated_checkpoint",
    failCount: false,
    failRedaction: false,
    failDedupCoverage: false,
    dedupCovered: true,
    failRollbackTo: false,
    failReleaseSavepoint: false,
    deletedObjectCount: 2,
    redactionEligibleTransitioned: 2,
    redactionBlockedCount: 0,
    redactionBlockedTransitioned: 0,
    redactionMalformedCount: 0,
    redactionMalformedTransitioned: 0,
    unclassifiedBlockedCount: 0,
    unclassifiedRepairCount: 0,
  };
  const objects = [
    { id: "d2000000-0000-4000-8000-000000000001", storage_key: "owner/object-1" },
    { id: "d2000000-0000-4000-8000-000000000002", storage_key: "owner/object-2" },
  ];
  const terminalEmailCandidateIds = [
    "e1000000-0000-4000-8000-000000000001",
    "e1000000-0000-4000-8000-000000000002",
  ];
  const consoleEmailCandidateIds = [
    "e2000000-0000-4000-8000-000000000001",
  ];
  const query = vi.fn(async (statement: string, parameters?: unknown[]) => {
    const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.startsWith("insert into data_lifecycle_run")) {
      return state.claim === "new" ? { rows: [{ id: "retention-run-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("from data_lifecycle_run where idempotency_key")) {
      if (state.claim === "new"
          || state.claim === "resume_oldest"
          || state.claim === "resume_oldest_relational") {
        return { rows: [], rowCount: 0 };
      }
      const replay = state.claim === "replay"
        || state.claim === "replay_degraded"
        || state.claim === "cutoff_mismatch"
        || state.claim === "replay_with_unrelated_checkpoint";
      const status = replay ? "succeeded" : state.claim === "running" ? "running" : "failed";
      const resumeFile = state.claim === "resume_failed"
        || state.claim === "resume_running"
        || state.claim === "resume_stored"
        || state.claim === "resume_degraded_file";
      const resumeRelational = state.claim === "resume_relational"
        || state.claim === "resume_degraded_relational";
      const resume = resumeFile || resumeRelational;
      const degradedCheckpoint = state.claim === "resume_degraded_file"
        || state.claim === "resume_degraded_relational";
      return {
        rows: [{
          id: "existing-run",
          operation: state.claim === "mismatch" ? "export" : "retention",
          policy_version: "2026-07-25.v5",
          dry_run: resume
            || state.claim === "replay_degraded"
            || state.claim === "replay_with_unrelated_checkpoint" ? false : true,
          cutoff_manifest: { rawChat: "2025-07-12T00:00:00.000Z" },
          cutoff_matches: state.claim !== "mismatch"
            && state.claim !== "cutoff_mismatch"
            && state.claim !== "resume_stored",
          status: state.claim === "resume_running"
            || state.claim === "resume_stored"
            || state.claim === "resume_relational"
            ? "running"
            : status,
          report: resume ? {
            phase: resumeRelational ? "relational_retention_committed" : "file_erasure_pending",
            evaluatedAt: "2026-07-12T00:00:00.000Z",
            cutoffs: {
              rawChat: "2025-07-12T00:00:00.000Z",
              temporaryObjects: "2026-07-11T00:00:00.000Z",
              aiRequestMetadataAndAttachments: "2026-06-12T00:00:00.000Z",
              failedQuarantinedOrSoftDeletedObjects: "2026-07-05T00:00:00.000Z",
            },
            batchSize: 1,
            objectEligible: 2,
            categories: {
              ...(resumeRelational
                ? { rawChat: { eligible: 7, deleted: 3, retained: 4, hasMore: true } }
                : { objects: { eligible: 2, deleted: 2, retained: 0, hasMore: false } }),
              ...(degradedCheckpoint ? {
                unresolvedEmailDeliveryAuthority: {
                  eligible: 0,
                  deleted: 0,
                  retained: 0,
                  transitioned: 0,
                  hasMore: true,
                  outcome: "failed",
                  failureCode: "EMAIL_OUTBOX_REDACTION_RETRYABLE",
                  note: "Redaction reporting failed safely; retry with a new reviewed idempotency key.",
                },
              } : {}),
            },
          } : {
            runId: "existing-run",
            policyVersion: "2026-07-25.v5",
            dryRun: state.claim === "replay_degraded"
              || state.claim === "replay_with_unrelated_checkpoint"
              ? false : true,
            evaluatedAt: "2026-07-12T00:00:00.000Z",
            cutoffs: {},
            categories: state.claim === "replay_degraded" ? {
              unresolvedEmailDeliveryAuthority: {
                eligible: 0,
                deleted: 0,
                retained: 0,
                transitioned: 0,
                hasMore: true,
                outcome: "failed",
                failureCode: "EMAIL_OUTBOX_REDACTION_RETRYABLE",
              },
            } : {},
            objectFiles: { removed: 0, alreadyAbsent: 0, failed: 0 },
            outcome: state.claim === "replay_degraded" ? "completed_with_errors" : "succeeded",
            requiresRetry: state.claim === "replay_degraded",
            replayed: false,
          },
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("from data_lifecycle_run") && sql.includes("order by created_at asc")) {
      const relational = state.claim === "resume_oldest_relational";
      const recoverable = state.claim === "resume_oldest"
        || state.claim === "replay_with_unrelated_checkpoint";
      return recoverable || relational ? {
        rows: [{
          id: "existing-run",
          operation: "retention",
          policy_version: "2026-07-25.v5",
          dry_run: false,
          cutoff_manifest: { rawChat: "2025-07-11T00:00:00.000Z" },
          status: "failed",
          report: {
            phase: relational ? "relational_retention_committed" : "file_erasure_pending",
            evaluatedAt: "2026-07-11T00:00:00.000Z",
            cutoffs: {
              rawChat: "2025-07-11T00:00:00.000Z",
              temporaryObjects: "2026-07-10T00:00:00.000Z",
              aiRequestMetadataAndAttachments: "2026-06-11T00:00:00.000Z",
              failedQuarantinedOrSoftDeletedObjects: "2026-07-04T00:00:00.000Z",
            },
            batchSize: 1,
            objectEligible: 2,
            categories: relational
              ? { rawChat: { eligible: 7, deleted: 3, retained: 4, hasMore: true } }
              : { objects: { eligible: 1, deleted: 1, retained: 0, hasMore: false } },
          },
        }],
        rowCount: 1,
      } : { rows: [], rowCount: 0 };
    }
    if (sql === "rollback to savepoint retention_email_redaction" && state.failRollbackTo) {
      throw new Error("synthetic savepoint rollback failure");
    }
    if (sql === "release savepoint retention_email_redaction" && state.failReleaseSavepoint) {
      throw new Error("synthetic savepoint release failure");
    }
    if (sql.includes("public.email_outbox_idempotency_coverage_authority(")) {
      if (state.failDedupCoverage) {
        throw new Error("synthetic no-replay coverage unavailable");
      }
      return {
        rows: [{ covered: state.dedupCovered }],
        rowCount: 1,
      };
    }
    if (sql.includes("from public.redact_quarantined_email_outbox_authority_v2(")) {
      if (state.failRedaction) {
        throw new Error("synthetic postgres detail learner@example.test");
      }
      return {
        rows: [
          {
            disposition: "eligible",
            eligible: "2",
            transitioned: String(parameters?.[1] === 0
              ? 0
              : state.redactionEligibleTransitioned),
          },
          {
            disposition: "blocked",
            eligible: String(state.redactionBlockedCount),
            transitioned: String(state.redactionBlockedTransitioned),
          },
          {
            disposition: "malformed",
            eligible: String(state.redactionMalformedCount),
            transitioned: String(state.redactionMalformedTransitioned),
          },
        ],
        rowCount: 3,
      };
    }
    if (sql.includes("unclassified_email_authority_blocked")) {
      return {
        rows: [{ count: String(state.unclassifiedBlockedCount) }], rowCount: 1,
      };
    }
    if (sql.includes("unclassified_email_authority_repair_required")) {
      return {
        rows: [{ count: String(state.unclassifiedRepairCount) }], rowCount: 1,
      };
    }
    if (sql.startsWith("select count(*)")) {
      if (state.failCount) throw new TypeError("synthetic count failure");
      return { rows: [{ count: "2" }], rowCount: 1 };
    }
    if (sql.startsWith("select id from model_call")) {
      return { rows: [{ id: "d1000000-0000-4000-8000-000000000001" }], rowCount: 1 };
    }
    if (sql.includes("terminal_email_deletion_candidates")) {
      return {
        rows: terminalEmailCandidateIds.map((id) => ({ id })),
        rowCount: terminalEmailCandidateIds.length,
      };
    }
    if (sql.includes("console_email_deletion_candidates")) {
      return {
        rows: consoleEmailCandidateIds.map((id) => ({ id })),
        rowCount: consoleEmailCandidateIds.length,
      };
    }
    if (sql.startsWith("select id, storage_key from stored_object")) {
      return { rows: objects, rowCount: objects.length };
    }
    if (sql.startsWith("delete from stored_object where id = any")) {
      const rows = objects.slice(0, state.deletedObjectCount);
      return { rows, rowCount: rows.length };
    }
    return { rows: [{ id: "row-1" }], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return {
    state,
    terminalEmailCandidateIds,
    consoleEmailCandidateIds,
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
    mocks.state.failRedaction = false;
    mocks.state.failDedupCoverage = false;
    mocks.state.dedupCovered = true;
    mocks.state.failRollbackTo = false;
    mocks.state.failReleaseSavepoint = false;
    mocks.state.deletedObjectCount = 2;
    mocks.state.redactionEligibleTransitioned = 2;
    mocks.state.redactionBlockedCount = 0;
    mocks.state.redactionBlockedTransitioned = 0;
    mocks.state.redactionMalformedCount = 0;
    mocks.state.redactionMalformedTransitioned = 0;
    mocks.state.unclassifiedRepairCount = 0;
    mocks.state.unclassifiedBlockedCount = 0;
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
      runId: expect.stringMatching(/^dry-run-[0-9a-f]{24}$/u),
      dryRun: true,
      outcome: "succeeded",
      requiresRetry: false,
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
    expect(report.categories.unresolvedEmailDeliveryAuthority).toMatchObject({
      eligible: 2,
      transitioned: 0,
      retained: 2,
      hasMore: true,
    });
    expect(report.categories.unresolvedEmailDeliveryAuthorityBlocked).toMatchObject({
      eligible: 0,
      transitioned: 0,
      retained: 0,
      hasMore: false,
    });
    expect(report.categories.unresolvedEmailDeliveryAuthorityMalformed).toMatchObject({
      eligible: 0,
      transitioned: 0,
      retained: 0,
      hasMore: false,
    });
    expect(report.categories.nonExternalConsoleDeliveryQuarantines).toMatchObject({
      eligible: 2,
      deleted: 0,
      retained: 2,
      hasMore: true,
    });
    expect(report.categories.unclassifiedEmailDeliveryAuthorityBlocked).toMatchObject({
      eligible: 0,
      deleted: 0,
      retained: 0,
      hasMore: false,
    });
    expect(report.categories.unclassifiedEmailDeliveryAuthorityRepairRequired).toMatchObject({
      eligible: 0,
      deleted: 0,
      retained: 0,
      hasMore: false,
    });
    const statements = mocks.query.mock.calls.map(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    ));
    const redaction = statements.findIndex((sql) => (
      sql.includes("from public.redact_quarantined_email_outbox_authority_v2(")
    ));
    expect(redaction).toBeGreaterThan(-1);
    expect(statements.some((sql) => (
      sql.includes("from public.redact_unresolved_email_outbox_authority(")
    ))).toBe(false);
    expect(statements).not.toContain("savepoint retention_email_redaction");
    expect(statements).not.toContain("rollback to savepoint retention_email_redaction");
    expect(statements).not.toContain("release savepoint retention_email_redaction");
    const redactionCall = (
      mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>
    )[redaction];
    expect(redactionCall?.[1]?.[1]).toBe(0);
    expect(
      statements.filter((sql) => /^(?:insert|update|delete|merge|truncate|alter|create|drop)\b/u.test(sql)),
    ).toEqual([]);
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

    const calls = mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>;
    const relationalDeleteIndex = calls.findIndex(([sql]) => String(sql).startsWith("delete from chat_message"));
    const relationalCheckpointIndex = calls.findIndex(([sql, values]) => (
      String(sql).includes("update data_lifecycle_run")
      && typeof values?.[1] === "string"
      && JSON.parse(values[1] as string).phase === "relational_retention_committed"
    ));
    const relationalCommitIndex = calls.findIndex((call, index) => (
      index > relationalCheckpointIndex && call[0] === "commit"
    ));
    expect(relationalDeleteIndex).toBeGreaterThan(-1);
    expect(relationalCheckpointIndex).toBeGreaterThan(relationalDeleteIndex);
    expect(relationalCommitIndex).toBeGreaterThan(relationalCheckpointIndex);
    const relationalCheckpoint = JSON.parse(String(calls[relationalCheckpointIndex]?.[1]?.[1]));
    expect(relationalCheckpoint).toMatchObject({
      phase: "relational_retention_committed",
      evaluatedAt: now.toISOString(),
      batchSize: 2,
      objectEligible: 2,
      categories: { rawChat: { eligible: 2, deleted: 1 } },
    });
    expect(relationalCheckpoint.cutoffs).toEqual(report.cutoffs);
  });

  it("redacts released authority and reports held or malformed backlog through one capability", async () => {
    const report = await runRetention({
      idempotencyKey: "retention:test:quarantined-email",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    const statements = mocks.query.mock.calls.map(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    ));
    const savepoint = statements.indexOf("savepoint retention_email_redaction");
    const redaction = statements.findIndex((sql) => (
      sql.startsWith("select disposition, eligible::text as eligible, transitioned::text as transitioned")
      && sql.includes("from public.redact_quarantined_email_outbox_authority_v2(")
    ));
    const release = statements.indexOf("release savepoint retention_email_redaction");
    const coverage = statements
      .map((sql, index) => (
        sql.includes("public.email_outbox_idempotency_coverage_authority(")
          ? index
          : -1
      ))
      .filter((index) => index >= 0);
    const deleted = statements
      .map((sql, index) => (
        sql.startsWith("delete from email_outbox") ? index : -1
      ))
      .filter((index) => index >= 0);
    expect(savepoint).toBeGreaterThan(-1);
    expect(redaction).toBeGreaterThan(savepoint);
    expect(release).toBeGreaterThan(redaction);
    expect(coverage).toHaveLength(2);
    expect(deleted).toHaveLength(2);
    expect(coverage[0]).toBeGreaterThan(release);
    expect(deleted[0]).toBeGreaterThan(coverage[0]!);
    expect(coverage[1]).toBeGreaterThan(deleted[0]!);
    expect(deleted[1]).toBeGreaterThan(coverage[1]!);
    expect(statements).not.toContain("rollback to savepoint retention_email_redaction");
    expect(statements[redaction]).toContain("$1::timestamptz, $2::integer");
    expect(statements[redaction]).not.toContain("update email_outbox");
    expect(report).toMatchObject({ outcome: "succeeded", requiresRetry: false });
    expect(report.categories.unresolvedEmailDeliveryAuthority).toMatchObject({
      eligible: 2,
      deleted: 0,
      retained: 2,
      transitioned: 2,
      hasMore: false,
    });
    expect(report.categories.unresolvedEmailDeliveryAuthorityBlocked).toMatchObject({
      eligible: 0,
      deleted: 0,
      retained: 0,
      transitioned: 0,
      hasMore: false,
    });
    expect(report.categories.unresolvedEmailDeliveryAuthorityMalformed).toMatchObject({
      eligible: 0,
      deleted: 0,
      retained: 0,
      transitioned: 0,
      hasMore: false,
    });
    expect(report.categories.nonExternalConsoleDeliveryQuarantines).toMatchObject({
      eligible: 2,
      deleted: 1,
      retained: 1,
      hasMore: true,
    });
    expect(report.categories.unclassifiedEmailDeliveryAuthorityBlocked).toMatchObject({
      eligible: 0,
      deleted: 0,
      retained: 0,
      hasMore: false,
    });
    expect(report.categories.unclassifiedEmailDeliveryAuthorityRepairRequired).toMatchObject({
      eligible: 0,
      deleted: 0,
      retained: 0,
      hasMore: false,
    });
  });

  it("deletes only the covered bounded mail candidates after eligibility is revalidated", async () => {
    await runRetention({
      idempotencyKey: "retention:test:mail-exact-candidates",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    const calls = mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>;
    const normalized = calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim().toLowerCase());
    const terminalSelectIndex = normalized.findIndex((sql) => (
      sql.includes("terminal_email_deletion_candidates")
    ));
    const consoleSelectIndex = normalized.findIndex((sql) => (
      sql.includes("console_email_deletion_candidates")
    ));
    const deleteCalls = calls.filter(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
        .startsWith("delete from email_outbox")
    ));
    const coverageCalls = calls.filter(([sql]) => (
      String(sql).includes("public.email_outbox_idempotency_coverage_authority(")
    ));

    expect(terminalSelectIndex).toBeGreaterThan(-1);
    expect(consoleSelectIndex).toBeGreaterThan(-1);
    expect(normalized[terminalSelectIndex]).not.toMatch(/\bfor update\b|\bskip locked\b/u);
    expect(normalized[consoleSelectIndex]).not.toMatch(/\bfor update\b|\bskip locked\b/u);
    expect(coverageCalls.map(([, parameters]) => parameters)).toEqual([
      [mocks.terminalEmailCandidateIds],
      [mocks.consoleEmailCandidateIds],
    ]);
    expect(deleteCalls).toHaveLength(2);

    const [terminalDelete, consoleDelete] = deleteCalls;
    const terminalSql = String(terminalDelete?.[0]).replace(/\s+/g, " ").trim().toLowerCase();
    const consoleSql = String(consoleDelete?.[0]).replace(/\s+/g, " ").trim().toLowerCase();
    const predicateBetween = (sql: string, prefix: string, suffix: string) => {
      const start = sql.indexOf(prefix);
      const end = sql.indexOf(suffix, start + prefix.length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return sql.slice(start + prefix.length, end);
    };
    const canonicalPredicate = (sql: string) => (
      sql.replace(/\s*([()])\s*/g, "$1").replace(/\s+/g, " ").trim()
    );
    const terminalCandidatePredicate = predicateBetween(
      normalized[terminalSelectIndex]!,
      "from email_outbox where ",
      " order by ",
    );
    const consoleCandidatePredicate = predicateBetween(
      normalized[consoleSelectIndex]!,
      "from email_outbox where ",
      " order by ",
    );
    const terminalDeletePredicate = predicateBetween(
      terminalSql,
      "where id = any($2::uuid[]) and ",
      " returning id",
    );
    const consoleDeletePredicate = predicateBetween(
      consoleSql,
      "where id = any($2::uuid[]) and ",
      " returning id",
    );

    expect(terminalDelete?.[1]).toEqual([
      "2026-06-12T00:00:00.000Z",
      mocks.terminalEmailCandidateIds,
    ]);
    expect(canonicalPredicate(terminalDeletePredicate))
      .toBe(canonicalPredicate(terminalCandidatePredicate));
    expect(terminalSql).toContain("id = any($2::uuid[])");
    expect(terminalSql).not.toContain("select id from email_outbox");
    expect(terminalSql).toContain("status in ('sent', 'suppressed', 'failed')");
    expect(terminalSql).toContain("provider_call_started is null");
    expect(terminalSql).toContain("provider_call_started is not null");
    expect(terminalSql).toContain("adapter = 'gmail'");
    expect(terminalSql).toContain("provider_message_id is not null");
    expect(terminalSql).toContain("btrim(provider_message_id) <> ''");
    expect(terminalSql).toContain("sent_at is not null");
    expect(terminalSql).toContain("quarantined_at is not null");
    expect(terminalSql).toContain("quarantined_at < $1::timestamptz");
    expect(terminalSql).toContain("claim_version >= 2");
    expect(terminalSql).toContain("claim_token is null");
    expect(terminalSql).toContain("claim_owner is null");
    expect(terminalSql).toContain("lease_expires_at is null");
    expect(terminalSql).toContain("last_error_code = 'abandoned_post_provider_boundary'");
    expect(terminalSql).toContain("dispatch_binding_version = 'gmail-raw-v1'");
    expect(terminalSql).toContain("dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'");
    expect(terminalSql).toContain("delivery_scope_key = 'a:' || user_id");
    expect(terminalSql).toContain("delivery_scope_key = 's:' || operation_id::text");
    expect(terminalSql).toContain("coalesce(sent_at, updated_at) < $1");

    expect(consoleDelete?.[1]).toEqual([
      "2026-06-12T00:00:00.000Z",
      mocks.consoleEmailCandidateIds,
    ]);
    expect(canonicalPredicate(consoleDeletePredicate))
      .toBe(canonicalPredicate(consoleCandidatePredicate));
    expect(consoleSql).toContain("id = any($2::uuid[])");
    expect(consoleSql).not.toContain("select id from email_outbox");
    expect(consoleSql).toContain("status = 'quarantined'");
    expect(consoleSql).toContain("provider_call_started is not null");
    expect(consoleSql).toContain("adapter = 'console'");
    expect(consoleSql).toContain("provider_message_id is null");
    expect(consoleSql).toContain("sent_at is null");
    expect(consoleSql).toContain("quarantined_at is not null");
    expect(consoleSql).toContain("quarantined_at < $1::timestamptz");
    expect(consoleSql).toContain("claim_version >= 2");
    expect(consoleSql).toContain("claim_token is null");
    expect(consoleSql).toContain("claim_owner is null");
    expect(consoleSql).toContain("lease_expires_at is null");
    expect(consoleSql).toContain("last_error_code = 'abandoned_post_provider_boundary'");
    expect(consoleSql).toContain("dispatch_binding_version = 'console-json-v1'");
    expect(consoleSql).toContain("dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'");
    expect(consoleSql).toContain("delivery_scope_key = 'a:' || user_id");
    expect(consoleSql).toContain("delivery_scope_key = 's:' || operation_id::text");
    expect(consoleSql).toContain("coalesce(sent_at, updated_at) < $1");
  });
  it("keeps a bounded redaction backlog retry-required until a later reviewed run", async () => {
    mocks.state.redactionEligibleTransitioned = 1;

    const report = await runRetention({
      idempotencyKey: "retention:test:quarantined-email-bounded-backlog",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        unresolvedEmailDeliveryAuthority: {
          eligible: 2,
          transitioned: 1,
          retained: 2,
          hasMore: true,
        },
      },
    });
  });
  it("makes malformed or unclassified recipient PII monitorably repair-required", async () => {
    mocks.state.redactionEligibleTransitioned = 1;
    mocks.state.redactionMalformedCount = 1;
    mocks.state.redactionMalformedTransitioned = 1;
    mocks.state.unclassifiedRepairCount = 2;

    const report = await runRetention({
      idempotencyKey: "retention:test:mail-authority-repair-required",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        unresolvedEmailDeliveryAuthorityMalformed: {
          eligible: 1,
          transitioned: 1,
          retained: 1,
          hasMore: false,
        },
        unclassifiedEmailDeliveryAuthorityRepairRequired: { eligible: 2, retained: 2 },
      },
    });
  });

  it("accepts fully redacted malformed authority without inventing repair backlog", async () => {
    mocks.state.redactionMalformedCount = 1;
    mocks.state.redactionMalformedTransitioned = 1;

    const report = await runRetention({
      idempotencyKey: "retention:test:mail-authority-malformed-redacted",
      dryRun: false,
      batchSize: 3,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "succeeded",
      requiresRetry: false,
      categories: {
        unresolvedEmailDeliveryAuthorityMalformed: {
          eligible: 1,
          transitioned: 1,
          retained: 1,
          hasMore: false,
        },
      },
    });
  });

  it("fails closed when the authority reports impossible transition counts", async () => {
    mocks.state.redactionMalformedCount = 1;
    mocks.state.redactionMalformedTransitioned = 2;

    const report = await runRetention({
      idempotencyKey: "retention:test:mail-authority-invalid-summary",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        unresolvedEmailDeliveryAuthority: {
          outcome: "failed",
          failureCode: "EMAIL_OUTBOX_REDACTION_RETRYABLE",
        },
      },
    });
  });
  it("fails closed when redaction transitions exceed the bounded batch", async () => {
    mocks.state.redactionEligibleTransitioned = 2;
    mocks.state.redactionMalformedCount = 1;
    mocks.state.redactionMalformedTransitioned = 1;

    const report = await runRetention({
      idempotencyKey: "retention:test:mail-authority-over-batch-summary",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        unresolvedEmailDeliveryAuthority: {
          outcome: "failed",
          failureCode: "EMAIL_OUTBOX_REDACTION_RETRYABLE",
        },
      },
    });
  });
  it("keeps every over-cutoff blocked recipient-PII category retry-required", async () => {
    mocks.state.redactionBlockedCount = 1;
    mocks.state.unclassifiedBlockedCount = 2;

    const report = await runRetention({
      idempotencyKey: "retention:test:mail-authority-blocked",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        unresolvedEmailDeliveryAuthorityBlocked: { eligible: 1, retained: 1 },
        unclassifiedEmailDeliveryAuthorityBlocked: { eligible: 2, retained: 2 },
      },
    });
  });

  it("retains terminal mail when durable no-replay coverage is unavailable", async () => {
    mocks.state.failDedupCoverage = true;

    const report = await runRetention({
      idempotencyKey: "retention:test:mail-no-replay-authority",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        terminalEmailDeliveryRecords: {
          eligible: 2,
          deleted: 0,
          retained: 2,
          outcome: "failed",
        },
        nonExternalConsoleDeliveryQuarantines: {
          eligible: 2,
          deleted: 0,
          retained: 2,
          outcome: "failed",
        },
      },
    });
    const statements = mocks.query.mock.calls.map(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    ));
    expect(statements.some((sql) => (
      sql.startsWith("delete from email_outbox")
    ))).toBe(false);
  });

  it("requires a strict true no-replay coverage result before terminal deletion", async () => {
    mocks.state.dedupCovered = false;

    const report = await runRetention({
      idempotencyKey: "retention:test:mail-no-replay-uncovered",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        terminalEmailDeliveryRecords: { deleted: 0, outcome: "failed" },
        nonExternalConsoleDeliveryQuarantines: { deleted: 0, outcome: "failed" },
      },
    });
  });

  it("commits unrelated work and returns a terminal degraded report when redaction is retryable", async () => {
    mocks.state.failRedaction = true;

    const report = await runRetention({
      idempotencyKey: "retention:test:redaction-failure",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        unresolvedEmailDeliveryAuthority: {
          eligible: 0,
          deleted: 0,
          transitioned: 0,
          outcome: "failed",
          failureCode: "EMAIL_OUTBOX_REDACTION_RETRYABLE",
        },
      },
    });
    expect(JSON.stringify(report)).not.toContain("learner@example.test");
    const calls = mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>;
    const statements = calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim().toLowerCase());
    const savepoint = statements.indexOf("savepoint retention_email_redaction");
    const redaction = statements.findIndex((sql) => (
      sql.includes("from public.redact_quarantined_email_outbox_authority_v2(")
    ));
    const rollbackTo = statements.indexOf("rollback to savepoint retention_email_redaction");
    const release = statements.indexOf("release savepoint retention_email_redaction");
    const terminalDelete = statements.findIndex((sql) => sql.startsWith("delete from email_outbox"));
    const objectDelete = statements.findIndex((sql) => sql.startsWith("delete from stored_object where id = any"));
    expect(savepoint).toBeGreaterThan(-1);
    expect(redaction).toBeGreaterThan(savepoint);
    expect(rollbackTo).toBeGreaterThan(redaction);
    expect(release).toBeGreaterThan(rollbackTo);
    expect(terminalDelete).toBeGreaterThan(release);
    expect(objectDelete).toBeGreaterThan(terminalDelete);
    expect(mocks.processFileErasures).toHaveBeenCalledTimes(1);
    expect(statements.some((sql) => sql.includes("set status = 'failed'"))).toBe(false);

    const degradedReportCall = calls.find(([sql, values]) => (
      String(sql).includes("status = 'succeeded'")
      && String(sql).includes("report = $2::jsonb")
      && typeof values?.[1] === "string"
    ));
    expect(degradedReportCall?.[1]).toContain("EMAIL_OUTBOX_REDACTION_RETRYABLE");
    const persistedReport = JSON.parse(String(degradedReportCall?.[1]?.[1]));
    expect(persistedReport).toEqual(report);
  });

  it("replays a terminal degraded run without repeating any mutation", async () => {
    mocks.state.claim = "replay_degraded";

    const report = await runRetention({
      idempotencyKey: "retention:test:redaction-failure",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      runId: "existing-run",
      replayed: true,
      outcome: "completed_with_errors",
      requiresRetry: true,
    });
    const statements = mocks.query.mock.calls.map(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    ));
    expect(statements.some((sql) => sql.includes("redact_quarantined_email_outbox_authority_v2"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("delete from "))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("update email_outbox"))).toBe(false);
    expect(mocks.processFileErasures).not.toHaveBeenCalled();
  });

  it("replays the supplied terminal key before an unrelated recovery checkpoint", async () => {
    mocks.state.claim = "replay_with_unrelated_checkpoint";

    const report = await runRetention({
      idempotencyKey: "retention:test:existing-terminal-key",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      runId: "existing-run",
      replayed: true,
      outcome: "succeeded",
      requiresRetry: false,
    });
    const statements = mocks.query.mock.calls.map(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    ));
    expect(statements.some((sql) => sql.includes("order by created_at asc"))).toBe(false);
    expect(statements.some((sql) => sql.includes("set status = 'running'"))).toBe(false);
    expect(mocks.processFileErasures).not.toHaveBeenCalled();
  });

  it("retries redaction under a new reviewed idempotency key", async () => {
    const report = await runRetention({
      idempotencyKey: "retention:test:redaction-retry-new-key",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({ outcome: "succeeded", requiresRetry: false });
    const redactionCall = (
      mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>
    ).find(([sql]) => String(sql).includes("redact_quarantined_email_outbox_authority_v2"));
    expect(redactionCall?.[1]?.[1]).toBe(2);
  });
  it("aborts the relational transaction when redaction rollback-to-savepoint is not confirmed", async () => {
    mocks.state.failRedaction = true;
    mocks.state.failRollbackTo = true;

    await expect(runRetention({
      idempotencyKey: "retention:test:redaction-savepoint-failure",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    })).rejects.toThrow();

    const statements = mocks.query.mock.calls.map(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    ));
    expect(statements).toContain("rollback to savepoint retention_email_redaction");
    expect(statements).not.toContain("release savepoint retention_email_redaction");
    expect(statements).toContain("rollback");
    expect(statements.some((sql) => sql.startsWith("delete from email_outbox"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("select id, storage_key from stored_object"))).toBe(false);
    expect(mocks.processFileErasures).not.toHaveBeenCalled();
  });
  it("aborts the relational transaction when savepoint release is not confirmed", async () => {
    mocks.state.failReleaseSavepoint = true;

    await expect(runRetention({
      idempotencyKey: "retention:test:redaction-release-failure",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    })).rejects.toThrow("synthetic savepoint release failure");

    const statements = mocks.query.mock.calls.map(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    ));
    expect(statements).toContain("release savepoint retention_email_redaction");
    expect(statements).toContain("rollback");
    expect(statements.some((sql) => sql.startsWith("delete from email_outbox"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("select id, storage_key from stored_object"))).toBe(false);
    expect(statements.some((sql) => sql.includes("status = 'succeeded'"))).toBe(false);
    expect(mocks.processFileErasures).not.toHaveBeenCalled();
  });
  it("rolls back the object batch when deletion-time revalidation changes eligibility", async () => {
    mocks.state.deletedObjectCount = 1;

    await expect(runRetention({
      idempotencyKey: "retention:test:revalidate",
      dryRun: false,
      batchSize: 2,
      now,
      objectStorageRoot: "C:/retention-objects",
    })).rejects.toThrow("Retention object eligibility changed during locked deletion.");

    expect(mocks.enqueueFileErasures).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith("rollback");
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

  it("uses an explicitly supplied client acquisition path for the retention session", async () => {
    const acquireClient = vi.fn(async () => mocks.client as unknown as PoolClient);

    await expect(runRetention({
      idempotencyKey: "retention:test:injected-pool",
      dryRun: true,
      now,
    }, {
      acquireClient,
      processFileErasures: mocks.processFileErasures,
    })).resolves.toMatchObject({
      runId: expect.stringMatching(/^dry-run-[0-9a-f]{24}$/u),
      dryRun: true,
    });

    expect(acquireClient).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
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

  it("rejects a terminal replay when the same key carries a different cutoff manifest", async () => {
    mocks.state.claim = "cutoff_mismatch";

    await expect(runRetention({
      idempotencyKey: "retention:test:replay-cutoff-mismatch",
      dryRun: true,
      now: new Date("2026-07-13T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    const claimLookup = (
      mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>
    ).find(([sql]) => String(sql).includes("from data_lifecycle_run where idempotency_key"));
    expect(String(claimLookup?.[0])).toContain("cutoff_manifest = $2::jsonb");
    expect(claimLookup?.[1]?.[1]).toBeTypeOf("string");
  });
  it("uses the persisted checkpoint and cutoffs for a same-key retry on a later day", async () => {
    mocks.state.claim = "resume_stored";
    await expect(runRetention({
      idempotencyKey: "retention:test:stored-cutoff",
      dryRun: false,
      now: new Date("2026-07-13T00:00:00.000Z"),
      objectStorageRoot: "C:/retention-objects",
    })).resolves.toMatchObject({
      runId: "existing-run",
      evaluatedAt: "2026-07-12T00:00:00.000Z",
      cutoffs: {},
    });
    expect(mocks.processFileErasures).toHaveBeenCalledTimes(1);
  });

  it("recovers the oldest persisted checkpoint before inserting a new daily run", async () => {
    mocks.state.claim = "resume_oldest";
    await expect(runRetention({
      idempotencyKey: "retention:test:day-d-plus-one",
      dryRun: false,
      now: new Date("2026-07-13T00:00:00.000Z"),
      objectStorageRoot: "C:/retention-objects",
    })).resolves.toMatchObject({
      runId: "existing-run",
      evaluatedAt: "2026-07-11T00:00:00.000Z",
      cutoffs: { rawChat: "2025-07-11T00:00:00.000Z" },
    });
    expect(mocks.processFileErasures).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into data_lifecycle_run"))).toBe(false);
  });

  it("recovers the oldest relational checkpoint without repeating relational deletes", async () => {
    mocks.state.claim = "resume_oldest_relational";

    const report = await runRetention({
      idempotencyKey: "retention:test:recover-oldest-relational",
      dryRun: false,
      batchSize: 5,
      now: new Date("2026-07-13T00:00:00.000Z"),
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      runId: "existing-run",
      evaluatedAt: "2026-07-11T00:00:00.000Z",
      categories: {
        rawChat: { eligible: 7, deleted: 3, retained: 4, hasMore: true },
        objects: { eligible: 2, deleted: 2 },
      },
    });
    expect(report.cutoffs.rawChat).toBe("2025-07-11T00:00:00.000Z");
    const calls = mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>;
    const objectSelect = calls.find(([sql]) => String(sql).startsWith("select id, storage_key from stored_object"));
    expect(objectSelect?.[1]?.at(-1)).toBe(1);
    expect(calls.some(([sql]) => String(sql).startsWith("select count(*)"))).toBe(false);
    expect(calls.some(([sql]) => String(sql).startsWith("delete from chat_message"))).toBe(false);
    expect(calls.some(([sql]) => String(sql).startsWith("insert into data_lifecycle_run"))).toBe(false);
    expect(mocks.processFileErasures).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["resume_degraded_relational", true],
    ["resume_degraded_file", false],
  ] as const)("preserves a degraded %s checkpoint through crash recovery", async (claim, needsObjectCheckpoint) => {
    mocks.state.claim = claim;

    const report = await runRetention({
      idempotencyKey: `retention:test:${claim}`,
      dryRun: false,
      now,
      objectStorageRoot: "C:/retention-objects",
    });

    expect(report).toMatchObject({
      runId: "existing-run",
      outcome: "completed_with_errors",
      requiresRetry: true,
      categories: {
        unresolvedEmailDeliveryAuthority: {
          eligible: 0,
          deleted: 0,
          retained: 0,
          transitioned: 0,
          hasMore: true,
          outcome: "failed",
          failureCode: "EMAIL_OUTBOX_REDACTION_RETRYABLE",
        },
      },
    });
    const calls = mocks.query.mock.calls as unknown as Array<[string, unknown[]?]>;
    const statements = calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim().toLowerCase());
    expect(statements.some((sql) => sql.startsWith("select count(*)"))).toBe(false);
    expect(statements.some((sql) => sql.includes("redact_quarantined_email_outbox_authority_v2"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("delete from chat_message"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("delete from email_outbox"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("select id, storage_key from stored_object"))).toBe(needsObjectCheckpoint);
    expect(mocks.processFileErasures).toHaveBeenCalledTimes(1);

    const terminalPersist = calls.find(([sql, values]) => (
      String(sql).includes("status = 'succeeded'")
      && String(sql).includes("error_code = $4")
      && typeof values?.[1] === "string"
    ));
    expect(terminalPersist?.[1]?.[3]).toBe("EMAIL_OUTBOX_REDACTION_RETRYABLE");
    const persistedReport = JSON.parse(String(terminalPersist?.[1]?.[1]));
    expect(persistedReport).toEqual(report);
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
      dryRun: false,
      now,
    })).rejects.toThrow("synthetic count failure");
    const failedUpdate = mocks.query.mock.calls.find(([sql]) => String(sql).includes("status = 'failed'"));
    expect(failedUpdate?.[1]?.[1]).toMatch(/^RETENTION_[0-9a-f]{12}$/);
    expect(String(failedUpdate?.[1]?.[1])).not.toContain("TypeError");
    expect(mocks.query).toHaveBeenCalledWith("select pg_advisory_unlock(hashtext('learncoding:data-lifecycle-retention'))");
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
  });

  it("does not persist a failed dry-run", async () => {
    mocks.state.failCount = true;
    await expect(runRetention({
      idempotencyKey: "retention:test:dry-run-failure",
      dryRun: true,
      now,
    })).rejects.toThrow("synthetic count failure");

    const statements = mocks.query.mock.calls.map(([sql]) => (
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    ));
    expect(
      statements.filter((sql) => /^(?:insert|update|delete|merge|truncate|alter|create|drop)\b/u.test(sql)),
    ).toEqual([]);
    expect(mocks.query).toHaveBeenCalledWith(
      "select pg_advisory_unlock(hashtext('learncoding:data-lifecycle-retention'))",
    );
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
  });

  it("prints a degraded report before making the CLI exit monitorably nonzero", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts/data-lifecycle.ts"), "utf8");
    const printIndex = source.indexOf("process.stdout.write(`${JSON.stringify(report, null, 2)}\\n`)");
    const retryIndex = source.indexOf("if (report.requiresRetry)", printIndex);
    const exitIndex = source.indexOf("process.exitCode = 1", retryIndex);

    expect(printIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(printIndex);
    expect(exitIndex).toBeGreaterThan(retryIndex);
  });

  it("retains typed conflict semantics", () => {
    expect(new RetentionRunConflictError("RUN_IN_PROGRESS")).toMatchObject({ code: "RUN_IN_PROGRESS" });
  });
});
