import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";

import {
  enqueueFileErasures,
  processFileErasures,
  purgeCompletedFileErasureJobs,
} from "./file-erasure";
import {
  RETENTION_POLICY,
  RETENTION_POLICY_VERSION,
  retentionCutoffManifest,
} from "./policy";

const DEFAULT_BATCH_SIZE = 1_000;
const MAX_BATCH_SIZE = 5_000;

type RetentionDependencies = Readonly<{
  processFileErasures: typeof processFileErasures;
}>;
const defaultRetentionDependencies: RetentionDependencies = { processFileErasures };

type CountRow = { count: string | number };
type IdRow = { id: string };

export type RetentionCategoryReport = Readonly<{
  eligible: number;
  deleted: number;
  retained: number;
  hasMore: boolean;
  transitioned?: number;
  note?: string;
}>;

export type RetentionReport = Readonly<{
  runId: string;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  dryRun: boolean;
  evaluatedAt: string;
  cutoffs: ReturnType<typeof retentionCutoffManifest>;
  categories: Readonly<Record<string, RetentionCategoryReport>>;
  objectFiles: Readonly<{ removed: number; alreadyAbsent: number; failed: number }>;
  replayed: boolean;
}>;

type RetentionFileCheckpoint = Readonly<{
  phase: "file_erasure_pending";
  evaluatedAt: string;
  cutoffs: ReturnType<typeof retentionCutoffManifest>;
  categories: Readonly<Record<string, RetentionCategoryReport>>;
}>;

export class RetentionRunConflictError extends Error {
  constructor(public readonly code: "RUN_IN_PROGRESS" | "PREVIOUS_RUN_FAILED" | "IDEMPOTENCY_MISMATCH") {
    super(code === "RUN_IN_PROGRESS"
      ? "A lifecycle run with this idempotency key is already in progress."
      : code === "PREVIOUS_RUN_FAILED"
        ? "A prior lifecycle run with this idempotency key failed; use a new reviewed key."
        : "The idempotency key belongs to a different lifecycle operation or input.");
  }
}

function batchSize(value: number | undefined) {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be an integer from 1 to ${MAX_BATCH_SIZE}.`);
  }
  return value;
}

function validateKey(value: string) {
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,199}$/.test(key)) {
    throw new Error("idempotencyKey must be 8–200 safe characters.");
  }
  return key;
}

async function count(client: PoolClient, statement: string, values: unknown[]) {
  const result = await client.query<CountRow>(statement, values);
  return Number(result.rows[0]?.count ?? 0);
}

function category(
  eligible: number,
  deleted: number,
  note?: string,
): RetentionCategoryReport {
  return {
    eligible,
    deleted,
    retained: Math.max(0, eligible - deleted),
    hasMore: eligible > deleted,
    ...(note ? { note } : {}),
  };
}

function transitionedCategory(
  eligible: number,
  transitioned: number,
  note: string,
): RetentionCategoryReport {
  return {
    eligible,
    deleted: 0,
    retained: eligible,
    transitioned,
    hasMore: eligible > transitioned,
    note,
  };
}

async function deleteBounded(
  client: PoolClient,
  table: string,
  timestampColumn: string,
  cutoff: string,
  limit: number,
) {
  const eligible = await count(
    client,
    `select count(*)::text as count from ${table} where ${timestampColumn} < $1`,
    [cutoff],
  );
  if (!eligible) return category(0, 0);
  const result = await client.query<IdRow>(
    `delete from ${table}
      where id in (
        select id from ${table}
         where ${timestampColumn} < $1
         order by ${timestampColumn} asc, id asc
         limit $2
      )
      returning id`,
    [cutoff, limit],
  );
  return category(eligible, result.rowCount ?? 0);
}

async function claimRun(
  client: PoolClient,
  input: {
    idempotencyKey: string;
    dryRun: boolean;
    cutoffs: Record<string, string>;
    now: Date;
  },
) {
  if (!input.dryRun) {
    const recoverable = await client.query<{
      id: string;
      status: "running" | "failed";
      report: RetentionFileCheckpoint;
    }>(
      `select id, status, report
         from data_lifecycle_run
        where operation = 'retention'
          and policy_version = $1
          and dry_run = false
          and status in ('running', 'failed')
          and report ->> 'phase' = 'file_erasure_pending'
        order by created_at asc, id asc
        limit 1`,
      [RETENTION_POLICY_VERSION],
    );
    const checkpoint = recoverable.rows[0];
    if (checkpoint) {
      if (checkpoint.status === "failed") {
        const resumed = await client.query(
          `update data_lifecycle_run
              set status = 'running', error_code = null, completed_at = null,
                  started_at = $2, updated_at = $2
            where id = $1 and status = 'failed'`,
          [checkpoint.id, input.now],
        );
        if ((resumed.rowCount ?? 0) !== 1) {
          throw new Error("Lifecycle recovery state changed during claim.");
        }
      }
      return { id: checkpoint.id, replay: null, resume: checkpoint.report };
    }
  }
  const inserted = await client.query<{ id: string }>(
    `insert into data_lifecycle_run
      (operation, policy_version, idempotency_key, dry_run, status, cutoff_manifest, started_at)
     values ('retention', $1, $2, $3, 'running', $4::jsonb, $5)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      RETENTION_POLICY_VERSION,
      input.idempotencyKey,
      input.dryRun,
      JSON.stringify(input.cutoffs),
      input.now,
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, replay: null, resume: null };
  const existing = await client.query<{
    id: string;
    operation: string;
    policy_version: string;
    dry_run: boolean;
    status: string;
    report: RetentionReport | RetentionFileCheckpoint;
  }>(
    `select id, operation, policy_version, dry_run, status, report
       from data_lifecycle_run where idempotency_key = $1`,
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Lifecycle idempotency state could not be resolved.");
  if (
    row.operation !== "retention"
    || row.policy_version !== RETENTION_POLICY_VERSION
    || row.dry_run !== input.dryRun
  ) {
    throw new RetentionRunConflictError("IDEMPOTENCY_MISMATCH");
  }
  if (row.status === "succeeded") {
    return {
      id: row.id,
      replay: { ...(row.report as RetentionReport), replayed: true } as RetentionReport,
      resume: null,
    };
  }
  if (row.status === "running" && "phase" in row.report && row.report.phase === "file_erasure_pending") {
    // The global retention advisory lock proves no earlier process still owns
    // this run; its connection would otherwise still hold the lock.
    return { id: row.id, replay: null, resume: row.report as RetentionFileCheckpoint };
  }
  if (row.status === "failed" && "phase" in row.report && row.report.phase === "file_erasure_pending") {
    const resumed = await client.query(
      `update data_lifecycle_run
          set status = 'running', error_code = null, completed_at = null,
              started_at = $2, updated_at = $2
        where id = $1 and status = 'failed'`,
      [row.id, input.now],
    );
    if ((resumed.rowCount ?? 0) === 1) {
      return { id: row.id, replay: null, resume: row.report as RetentionFileCheckpoint };
    }
  }
  throw new RetentionRunConflictError(
    row.status === "running" ? "RUN_IN_PROGRESS" : "PREVIOUS_RUN_FAILED",
  );
}

async function eligibleObjectRows(
  client: PoolClient,
  cutoffs: ReturnType<typeof retentionCutoffManifest>,
  limit: number,
) {
  return client.query<{ id: string; storage_key: string }>(
    `select id, storage_key
       from stored_object
      where (
        retention_class = 'temporary' and created_at < $1
      ) or (
        retention_class = 'ai_request_attachment' and created_at < $2
      ) or (
        (scan_status in ('quarantined', 'scanner_error', 'deleted') or deleted_at is not null)
        and coalesce(deleted_at, updated_at) < $3
      )
      order by created_at asc, id asc
      limit $4
      for update skip locked`,
    [
      cutoffs.temporaryObjects,
      cutoffs.aiRequestMetadataAndAttachments,
      cutoffs.failedQuarantinedOrSoftDeletedObjects,
      limit,
    ],
  );
}

async function countEligibleObjects(
  client: PoolClient,
  cutoffs: ReturnType<typeof retentionCutoffManifest>,
) {
  return count(
    client,
    `select count(*)::text as count
       from stored_object
      where (
        retention_class = 'temporary' and created_at < $1
      ) or (
        retention_class = 'ai_request_attachment' and created_at < $2
      ) or (
        (scan_status in ('quarantined', 'scanner_error', 'deleted') or deleted_at is not null)
        and coalesce(deleted_at, updated_at) < $3
      )`,
    [
      cutoffs.temporaryObjects,
      cutoffs.aiRequestMetadataAndAttachments,
      cutoffs.failedQuarantinedOrSoftDeletedObjects,
    ],
  );
}

function safeFailureCode(error: unknown) {
  const name = error instanceof Error ? error.name : "UnknownError";
  return `RETENTION_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

export async function runRetention(input: {
  idempotencyKey: string;
  dryRun: boolean;
  batchSize?: number;
  now?: Date;
  objectStorageRoot?: string;
}, dependencies: RetentionDependencies = defaultRetentionDependencies): Promise<RetentionReport> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("A valid job timestamp is required.");
  const limit = batchSize(input.batchSize);
  const idempotencyKey = validateKey(input.idempotencyKey);
  const cutoffs = retentionCutoffManifest(now);
  const client = await pool.connect();
  let runId: string | null = null;
  let locked = false;
  try {
    await client.query("select pg_advisory_lock(hashtext('learncoding:data-lifecycle-retention'))");
    locked = true;
    const claimed = await claimRun(client, {
      idempotencyKey,
      dryRun: input.dryRun,
      cutoffs,
      now,
    });
    runId = claimed.id;
    if (claimed.replay) return claimed.replay;
    if (claimed.resume) {
      const objectRoot = input.objectStorageRoot ?? process.env.OBJECT_STORAGE_PATH ?? "./data/objects";
      const fileSummary = await dependencies.processFileErasures({
        lifecycleRunId: runId,
        objectStorageRoot: objectRoot,
      });
      const report: RetentionReport = {
        runId,
        policyVersion: RETENTION_POLICY.version,
        dryRun: false,
        evaluatedAt: claimed.resume.evaluatedAt,
        cutoffs: claimed.resume.cutoffs,
        categories: claimed.resume.categories,
        objectFiles: {
          removed: fileSummary.removed,
          alreadyAbsent: fileSummary.alreadyAbsent,
          failed: 0,
        },
        replayed: false,
      };
      await client.query("begin");
      try {
        await client.query(
          `update data_lifecycle_run
              set status = 'succeeded', report = $2::jsonb,
                  completed_at = $3, updated_at = $3
            where id = $1 and status = 'running'`,
          [runId, JSON.stringify(report), new Date()],
        );
        await purgeCompletedFileErasureJobs(client, runId);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
      return report;
    }

    const categories: Record<string, RetentionCategoryReport> = {};
    const chatEligible = await count(
      client,
      "select count(*)::text as count from chat_message where created_at < $1",
      [cutoffs.rawChat],
    );
    const tutorReceiptEligible = await count(
      client,
      `select count(*)::text as count from provider_operation_receipt
        where action = 'tutor.post' and created_at < $1`,
      [cutoffs.rawChat],
    );
    const codeEligible = await count(
      client,
      "select count(*)::text as count from code_submission where created_at < $1",
      [cutoffs.rawCode],
    );
    const modelEligible = await count(
      client,
      "select count(*)::text as count from model_call where created_at < $1",
      [cutoffs.aiRequestMetadataAndAttachments],
    );
    const sessionEligible = await count(
      client,
      "select count(*)::text as count from auth_session_history where ended_at < $1",
      [cutoffs.securitySessionHistory],
    );
    const requestEligible = await count(
      client,
      `select count(*)::text as count from session_revocation_request
        where status <> 'pending' and coalesce(decided_at, updated_at) < $1`,
      [cutoffs.securitySessionHistory],
    );
    const stalePendingRequests = await count(
      client,
      `select count(*)::text as count from session_revocation_request
        where status = 'pending' and created_at < $1`,
      [cutoffs.securitySessionHistory],
    );
    const objectEligible = await countEligibleObjects(client, cutoffs);
    const emailEligible = await count(
      client,
      `select count(*)::text as count from email_outbox
        where status in ('sent', 'suppressed', 'failed')
          and coalesce(sent_at, updated_at) < $1`,
      [cutoffs.terminalEmailDeliveryRecords],
    );
    const oldAudit = await count(
      client,
      "select count(*)::text as count from audit_event where occurred_at < $1",
      [cutoffs.adminAuditMinimum],
    );
    const durableEvidence = await count(
      client,
      "select count(*)::text as count from mastery_evidence",
      [],
    );
    const durableDraftsAndReceipts = await count(
      client,
      `select count(*)::text as count from (
        select id::text as retained_id from learner_draft
        union all
        select request_id::text as retained_id from learner_draft_mutation
      ) retained_draft_record`,
      [],
    );
    const durableProjectRevisionHistory = await count(
      client,
      `select count(*)::text as count from (
        select id::text as retained_id from project_revision
        union all
        select revision_id::text || ':' || ordinal::text as retained_id
          from project_revision_object
      ) retained_project_revision_record`,
      [],
    );
    const durableCertificatesAndPublicPortfolio = await count(
      client,
      `select count(*)::text as count from (
        select id::text as retained_id from course_certificate
        union all select certificate_id::text from certificate_revocation
        union all select request_id::text from certificate_operation_receipt
        union all select user_id from public_portfolio
        union all select user_id || ':project:' || project_id::text from public_portfolio_project
        union all select user_id || ':project-snapshot:' || project_id::text || ':' || portfolio_version::text
          from public_portfolio_project_snapshot
        union all select user_id || ':achievement:' || user_achievement_id::text from public_portfolio_achievement
        union all select user_id || ':certificate:' || certificate_id::text from public_portfolio_certificate
        union all select id::text from public_portfolio_event
      ) retained_certificate_or_portfolio_record`,
      [],
    );
    const backupExpiryEligible = await count(
      client,
      `select count(*)::text as count from account_deletion_tombstone
        where backup_status = 'awaiting_retention_expiry' and backup_retention_until <= $1`,
      [now],
    );

    const objectFiles = { removed: 0, alreadyAbsent: 0, failed: 0 };
    if (input.dryRun) {
      categories.rawChat = category(chatEligible, 0, "dry-run");
      categories.tutorReplayReceipts = category(
        tutorReceiptEligible,
        0,
        "dry-run; tutor safe-response copies follow the 12-month raw-chat cutoff",
      );
      categories.rawCode = category(codeEligible, 0, "dry-run");
      categories.aiRequestMetadata = category(modelEligible, 0, "dry-run");
      categories.securitySessionHistory = category(
        sessionEligible + requestEligible,
        0,
        "dry-run; official assessment evidence tables are outside this purge",
      );
      categories.stalePendingRevocationRequests = transitionedCategory(
        stalePendingRequests,
        0,
        "dry-run; would mark expired, not delete",
      );
      categories.objects = category(objectEligible, 0, "dry-run");
      categories.terminalEmailDeliveryRecords = category(emailEligible, 0, "dry-run");
      categories.backupExpiryEligibility = transitionedCategory(
        backupExpiryEligible,
        0,
        "dry-run; would mark eligible for operator verification, never verified erased",
      );
    } else {
      await client.query("begin");
      try {
        const deletedChat = await client.query<IdRow>(
          `delete from chat_message where id in (
             select id from chat_message where created_at < $1
             order by created_at asc, id asc limit $2
           ) returning id`,
          [cutoffs.rawChat, limit],
        );
        await client.query(
          `delete from chat_thread where id in (
             select thread.id from chat_thread as thread
              where thread.updated_at < $1
                and not exists (select 1 from chat_message where thread_id = thread.id)
              order by thread.updated_at asc, thread.id asc limit $2
           )`,
          [cutoffs.rawChat, limit],
        );
        categories.rawChat = category(chatEligible, deletedChat.rowCount ?? 0);
        const deletedTutorReceipts = await client.query<IdRow>(
          `delete from provider_operation_receipt where id in (
             select id from provider_operation_receipt
              where action = 'tutor.post' and created_at < $1
              order by created_at asc, id asc limit $2
           ) returning id`,
          [cutoffs.rawChat, limit],
        );
        categories.tutorReplayReceipts = category(
          tutorReceiptEligible,
          deletedTutorReceipts.rowCount ?? 0,
          "Tutor safe-response copies follow the 12-month raw-chat cutoff.",
        );

        categories.rawCode = await deleteBounded(
          client,
          "code_submission",
          "created_at",
          cutoffs.rawCode,
          limit,
        );

        const modelIds = await client.query<IdRow>(
          `select id from model_call where created_at < $1
            order by created_at asc, id asc limit $2`,
          [cutoffs.aiRequestMetadataAndAttachments, limit],
        );
        const ids = modelIds.rows.map((row) => row.id);
        let deletedModels = 0;
        if (ids.length) {
          await client.query("update chat_message set model_call_id = null where model_call_id = any($1::uuid[])", [ids]);
          await client.query("update project_review set model_call_id = null where model_call_id = any($1::uuid[])", [ids]);
          const deleted = await client.query("delete from model_call where id = any($1::uuid[])", [ids]);
          deletedModels = deleted.rowCount ?? 0;
        }
        categories.aiRequestMetadata = category(modelEligible, deletedModels);

        categories.securitySessionHistory = await deleteBounded(
          client,
          "auth_session_history",
          "ended_at",
          cutoffs.securitySessionHistory,
          limit,
        );
        const deletedRequests = await client.query<IdRow>(
          `delete from session_revocation_request where id in (
             select id from session_revocation_request
              where status <> 'pending' and coalesce(decided_at, updated_at) < $1
              order by coalesce(decided_at, updated_at) asc, id asc limit $2
           ) returning id`,
          [cutoffs.securitySessionHistory, limit],
        );
        categories.securitySessionHistory = category(
          sessionEligible + requestEligible,
          categories.securitySessionHistory.deleted + (deletedRequests.rowCount ?? 0),
          "Official assessment evidence tables are not included in this purge.",
        );
        const expiredPending = await client.query<IdRow>(
          `update session_revocation_request
              set status = 'expired', decided_at = $2,
                  decision_reason = 'Expired by the versioned retention policy.', updated_at = $2
            where id in (
              select id from session_revocation_request
               where status = 'pending' and created_at < $1
               order by created_at asc, id asc limit $3
            ) returning id`,
          [cutoffs.securitySessionHistory, now, limit],
        );
        categories.stalePendingRevocationRequests = transitionedCategory(
          stalePendingRequests,
          expiredPending.rowCount ?? 0,
          "Marked expired; not physically deleted in the same run.",
        );

        const deletedEmail = await client.query<IdRow>(
          `delete from email_outbox where id in (
             select id from email_outbox
              where status in ('sent', 'suppressed', 'failed')
                and coalesce(sent_at, updated_at) < $1
              order by coalesce(sent_at, updated_at) asc, id asc limit $2
           ) returning id`,
          [cutoffs.terminalEmailDeliveryRecords, limit],
        );
        categories.terminalEmailDeliveryRecords = category(emailEligible, deletedEmail.rowCount ?? 0);
        const markedBackupEligible = await client.query<IdRow>(
          `update account_deletion_tombstone
              set backup_status = 'eligible_for_operator_verification', updated_at = $1
            where id in (
              select id from account_deletion_tombstone
               where backup_status = 'awaiting_retention_expiry'
                 and backup_retention_until <= $1
               order by backup_retention_until asc, id asc limit $2
            ) returning id`,
          [now, limit],
        );
        categories.backupExpiryEligibility = transitionedCategory(
          backupExpiryEligible,
          markedBackupEligible.rowCount ?? 0,
          "Marked eligible for operator verification only; no backup erasure is claimed.",
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }

      const objectRoot = input.objectStorageRoot ?? process.env.OBJECT_STORAGE_PATH ?? "./data/objects";
      await client.query("begin");
      try {
        const objectRows = await eligibleObjectRows(client, cutoffs, limit);
        const objectIds = objectRows.rows.map((object) => object.id);
        let deletedObjects = 0;
        if (objectIds.length) {
          await client.query("delete from quota_ledger where object_id = any($1::uuid[])", [objectIds]);
          const deleted = await client.query<{ id: string; storage_key: string }>(
            `delete from stored_object
              where id = any($1::uuid[])
                and (
                  (
                    retention_class = 'temporary' and created_at < $2
                  ) or (
                    retention_class = 'ai_request_attachment' and created_at < $3
                  ) or (
                    (scan_status in ('quarantined', 'scanner_error', 'deleted') or deleted_at is not null)
                    and coalesce(deleted_at, updated_at) < $4
                  )
                )
              returning id, storage_key`,
            [
              objectIds,
              cutoffs.temporaryObjects,
              cutoffs.aiRequestMetadataAndAttachments,
              cutoffs.failedQuarantinedOrSoftDeletedObjects,
            ],
          );
          if ((deleted.rowCount ?? 0) !== objectRows.rows.length) {
            throw new Error("Retention object eligibility changed during locked deletion.");
          }
          await enqueueFileErasures(client, {
            lifecycleRunId: runId,
            operation: "retention",
            objects: deleted.rows.map((object) => ({
              id: object.id,
              storageKey: object.storage_key,
            })),
            now,
          });
          deletedObjects = deleted.rowCount ?? 0;
        }
        categories.objects = category(objectEligible, deletedObjects);
        categories.adminAudit = category(
          oldAudit,
          0,
          "24 months is a minimum; launch policy performs no automatic audit purge.",
        );
        categories.masteryAndOfficialEvidence = category(
          durableEvidence,
          0,
          "Retained until an administrator completes account deletion.",
        );
        categories.learnerDraftsAndSyncReceipts = category(
          durableDraftsAndReceipts,
          0,
          "Authoritative drafts and idempotency receipts are retained until administrator account deletion; browser session cache is not a backup.",
        );
        categories.projectRevisionHistory = category(
          durableProjectRevisionHistory,
          0,
          "Append-only project checkpoints and file metadata snapshots are retained until administrator account deletion; associated bytes remain governed by stored-object retention.",
        );
        categories.certificatesAndPublicPortfolio = category(
          durableCertificatesAndPublicPortfolio,
          0,
          "Certificate evidence, revocations, explicit public-profile consent history, and selected public proofs are retained until administrator account deletion.",
        );
        const checkpoint: RetentionFileCheckpoint = {
          phase: "file_erasure_pending",
          evaluatedAt: now.toISOString(),
          cutoffs,
          categories,
        };
        await client.query(
          `update data_lifecycle_run set report = $2::jsonb, updated_at = $3
            where id = $1 and status = 'running'`,
          [runId, JSON.stringify(checkpoint), now],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
      // No unlink occurs until both the metadata deletion and its queue are
      // durable. If this process dies, claimRun resumes this checkpoint.
      const fileSummary = await dependencies.processFileErasures({
        lifecycleRunId: runId,
        objectStorageRoot: objectRoot,
      });
      objectFiles.removed = fileSummary.removed;
      objectFiles.alreadyAbsent = fileSummary.alreadyAbsent;
    }

    categories.adminAudit = category(
      oldAudit,
      0,
      "24 months is a minimum; launch policy performs no automatic audit purge.",
    );
    categories.masteryAndOfficialEvidence = category(
      durableEvidence,
      0,
      "Retained until an administrator completes account deletion.",
    );
    categories.learnerDraftsAndSyncReceipts = category(
      durableDraftsAndReceipts,
      0,
      "Authoritative drafts and idempotency receipts are retained until administrator account deletion; browser session cache is not a backup.",
    );
    categories.projectRevisionHistory = category(
      durableProjectRevisionHistory,
      0,
      "Append-only project checkpoints and file metadata snapshots are retained until administrator account deletion; associated bytes remain governed by stored-object retention.",
    );
    categories.certificatesAndPublicPortfolio = category(
      durableCertificatesAndPublicPortfolio,
      0,
      "Certificate evidence, revocations, explicit public-profile consent history, and selected public proofs are retained until administrator account deletion.",
    );

    const report: RetentionReport = {
      runId,
      policyVersion: RETENTION_POLICY.version,
      dryRun: input.dryRun,
      evaluatedAt: now.toISOString(),
      cutoffs,
      categories,
      objectFiles,
      replayed: false,
    };
    await client.query("begin");
    try {
      await client.query(
        `update data_lifecycle_run
            set status = 'succeeded', report = $2::jsonb, completed_at = $3, updated_at = $3
          where id = $1 and status = 'running'`,
        [runId, JSON.stringify(report), new Date()],
      );
      if (!input.dryRun) await purgeCompletedFileErasureJobs(client, runId);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
    return report;
  } catch (error) {
    if (runId) {
      await client.query(
        `update data_lifecycle_run
            set status = 'failed', error_code = $2, completed_at = $3, updated_at = $3
          where id = $1 and status = 'running'`,
        [runId, safeFailureCode(error), new Date()],
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(hashtext('learncoding:data-lifecycle-retention'))").catch(() => undefined);
    }
    client.release();
  }
}
