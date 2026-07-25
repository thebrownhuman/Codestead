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
export const EMAIL_OUTBOX_REDACTION_RETRYABLE = "EMAIL_OUTBOX_REDACTION_RETRYABLE";

type RetentionDependencies = Readonly<{
  processFileErasures?: typeof processFileErasures;
  acquireClient?: () => Promise<PoolClient>;
}>;
const defaultRetentionDependencies = {
  processFileErasures,
  acquireClient: () => pool.connect(),
} satisfies Required<RetentionDependencies>;

type CountRow = { count: string | number };
type IdRow = { id: string };

export type RetentionCategoryReport = Readonly<{
  eligible: number;
  deleted: number;
  retained: number;
  hasMore: boolean;
  transitioned?: number;
  outcome?: "failed";
  failureCode?: typeof EMAIL_OUTBOX_REDACTION_RETRYABLE;
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
  outcome: "succeeded" | "completed_with_errors";
  requiresRetry: boolean;
  replayed: boolean;
}>;

type RetentionCheckpointBase = Readonly<{
  evaluatedAt: string;
  cutoffs: ReturnType<typeof retentionCutoffManifest>;
  batchSize: number;
  categories: Readonly<Record<string, RetentionCategoryReport>>;
}>;

type RetentionRelationalCheckpoint = RetentionCheckpointBase & Readonly<{
  phase: "relational_retention_committed";
  objectEligible: number;
}>;

type RetentionFileCheckpoint = RetentionCheckpointBase & Readonly<{
  phase: "file_erasure_pending";
}>;

type RetentionCheckpoint = RetentionRelationalCheckpoint | RetentionFileCheckpoint;

type RedactionSummaryRow = Readonly<{
  disposition: "eligible" | "blocked" | "malformed";
  eligible: string | number;
  transitioned: string | number;
}>;

type RedactionCapabilityResult =
  | Readonly<{
      outcome: "succeeded";
      eligible: number;
      transitioned: number;
      blocked: number;
      malformed: number;
      malformedTransitioned: number;
    }>
  | Readonly<{
      outcome: "failed";
      failureCode: typeof EMAIL_OUTBOX_REDACTION_RETRYABLE;
    }>;

type CoverageRow = Readonly<{ covered: boolean | null }>;

type TerminalDeletionCoverageResult =
  | Readonly<{
      outcome: "succeeded";
    }>
  | Readonly<{
      outcome: "failed";
      failureCode: typeof EMAIL_OUTBOX_REDACTION_RETRYABLE;
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

function parseRedactionCount(value: string | number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Email outbox redaction summary is invalid.");
  }
  return parsed;
}

async function queryRedactionCapability(
  client: PoolClient,
  cutoff: string,
  batchLimit: number,
) {
  const result = await client.query<RedactionSummaryRow>(
    `select disposition, eligible::text as eligible, transitioned::text as transitioned
       from public.redact_quarantined_email_outbox_authority_v2(
         $1::timestamptz, $2::integer
       )`,
    [cutoff, batchLimit],
  );
  const summaries = new Map<RedactionSummaryRow["disposition"], RedactionSummaryRow>();
  for (const row of result.rows) {
    if (
      !["eligible", "blocked", "malformed"].includes(row.disposition)
      || summaries.has(row.disposition)
    ) {
      throw new Error("Email outbox redaction summary is invalid.");
    }
    summaries.set(row.disposition, row);
  }
  if (summaries.size !== 3) {
    throw new Error("Email outbox redaction summary is incomplete.");
  }
  const eligible = summaries.get("eligible")!;
  const blocked = summaries.get("blocked")!;
  const malformed = summaries.get("malformed")!;
  const eligibleCount = parseRedactionCount(eligible.eligible);
  const eligibleTransitioned = parseRedactionCount(eligible.transitioned);
  const blockedCount = parseRedactionCount(blocked.eligible);
  const blockedTransitioned = parseRedactionCount(blocked.transitioned);
  const malformedCount = parseRedactionCount(malformed.eligible);
  const malformedTransitioned = parseRedactionCount(malformed.transitioned);
  if (
    blockedTransitioned !== 0
    || eligibleTransitioned > eligibleCount
    || malformedTransitioned > malformedCount
    || eligibleTransitioned > batchLimit
    || malformedTransitioned > batchLimit - eligibleTransitioned
  ) {
    throw new Error("Email outbox redaction summary is invalid.");
  }
  return {
    outcome: "succeeded" as const,
    eligible: eligibleCount,
    transitioned: eligibleTransitioned,
    blocked: blockedCount,
    malformed: malformedCount,
    malformedTransitioned,
  };
}

async function runRedactionCapability(
  client: PoolClient,
  cutoff: string,
  batchLimit: number,
  mode: "report-only" | "apply",
): Promise<RedactionCapabilityResult> {
  if (mode === "report-only") {
    try {
      return await queryRedactionCapability(client, cutoff, 0);
    } catch {
      return { outcome: "failed", failureCode: EMAIL_OUTBOX_REDACTION_RETRYABLE };
    }
  }

  await client.query("savepoint retention_email_redaction");
  let summary: RedactionCapabilityResult;
  try {
    summary = await queryRedactionCapability(client, cutoff, batchLimit);
  } catch {
    await client.query("rollback to savepoint retention_email_redaction");
    summary = { outcome: "failed", failureCode: EMAIL_OUTBOX_REDACTION_RETRYABLE };
  }
  await client.query("release savepoint retention_email_redaction");
  return summary;
}

async function queryTerminalDeletionCoverage(
  client: PoolClient,
  candidateIds: readonly string[],
): Promise<TerminalDeletionCoverageResult> {
  const uniqueIds = [...new Set(candidateIds)];
  if (
    uniqueIds.length === 0
    || uniqueIds.length !== candidateIds.length
    || uniqueIds.length > MAX_BATCH_SIZE
  ) {
    throw new Error("Terminal email deletion coverage input is invalid.");
  }
  const result = await client.query<CoverageRow>(
    `select public.email_outbox_idempotency_coverage_authority(
       $1::uuid[]
     ) as covered`,
    [uniqueIds],
  );
  if ((result.rowCount ?? 0) !== 1 || result.rows[0]?.covered !== true) {
    return {
      outcome: "failed",
      failureCode: EMAIL_OUTBOX_REDACTION_RETRYABLE,
    };
  }
  return { outcome: "succeeded" };
}

async function runTerminalDeletionCoverage(
  client: PoolClient,
  candidateIds: readonly string[],
  mode: "report-only" | "apply",
): Promise<TerminalDeletionCoverageResult> {
  if (candidateIds.length === 0) return { outcome: "succeeded" };
  if (mode === "report-only") {
    try {
      return await queryTerminalDeletionCoverage(client, candidateIds);
    } catch {
      return {
        outcome: "failed",
        failureCode: EMAIL_OUTBOX_REDACTION_RETRYABLE,
      };
    }
  }

  await client.query("savepoint retention_email_dedup_coverage");
  let coverage: TerminalDeletionCoverageResult;
  try {
    coverage = await queryTerminalDeletionCoverage(client, candidateIds);
  } catch {
    await client.query("rollback to savepoint retention_email_dedup_coverage");
    coverage = {
      outcome: "failed",
      failureCode: EMAIL_OUTBOX_REDACTION_RETRYABLE,
    };
  }
  await client.query("release savepoint retention_email_dedup_coverage");
  return coverage;
}

function terminalDeletionCoverageFailureCategory(
  eligible: number,
  note: string,
): RetentionCategoryReport {
  return {
    eligible,
    deleted: 0,
    retained: eligible,
    hasMore: true,
    outcome: "failed",
    failureCode: EMAIL_OUTBOX_REDACTION_RETRYABLE,
    note,
  };
}

function redactionFailureCategory(note: string): RetentionCategoryReport {
  return {
    eligible: 0,
    deleted: 0,
    retained: 0,
    transitioned: 0,
    hasMore: true,
    outcome: "failed",
    failureCode: EMAIL_OUTBOX_REDACTION_RETRYABLE,
    note,
  };
}

function setRedactionCategories(
  categories: Record<string, RetentionCategoryReport>,
  result: RedactionCapabilityResult,
  dryRun: boolean,
) {
  if (result.outcome === "failed") {
    categories.unresolvedEmailDeliveryAuthority = redactionFailureCategory(
      "Redaction reporting failed safely; retry with a new reviewed idempotency key.",
    );
    categories.unresolvedEmailDeliveryAuthorityBlocked = redactionFailureCategory(
      "Held reconciliation authority could not be counted safely.",
    );
    categories.unresolvedEmailDeliveryAuthorityMalformed = redactionFailureCategory(
      "Malformed reconciliation authority could not be counted safely.",
    );
    return;
  }

  categories.unresolvedEmailDeliveryAuthority = transitionedCategory(
    result.eligible,
    dryRun ? 0 : result.transitioned,
    dryRun
      ? "dry-run; would redact recipient payload while retaining unresolved provider authority"
      : "Recipient payload redacted; unresolved provider authority evidence retained until reconciliation.",
  );
  categories.unresolvedEmailDeliveryAuthorityBlocked = transitionedCategory(
    result.blocked,
    0,
    "Over-cutoff complete authority remains blocked until atomically released; retry health stays open while recipient PII is retained.",
  );
  categories.unresolvedEmailDeliveryAuthorityMalformed = transitionedCategory(
    result.malformed,
    dryRun ? 0 : result.malformedTransitioned,
    dryRun
      ? "dry-run; malformed recipient payload would be redacted while retaining non-PII authority state"
      : "Malformed recipient payload redacted; non-PII authority state retained for reconciliation.",
  );
}

function hasEmailPrivacyFailure(
  categories: Readonly<Record<string, RetentionCategoryReport>>,
  dryRun: boolean,
) {
  return categories.terminalEmailDeliveryRecords?.outcome === "failed"
    || categories.nonExternalConsoleDeliveryQuarantines?.outcome === "failed"
    || categories.unresolvedEmailDeliveryAuthority?.outcome === "failed"
    || (!dryRun && categories.unresolvedEmailDeliveryAuthority?.hasMore === true)
    || categories.unresolvedEmailDeliveryAuthorityBlocked?.hasMore === true
    || (!dryRun && categories.unresolvedEmailDeliveryAuthorityMalformed?.hasMore === true)
    || (categories.unclassifiedEmailDeliveryAuthorityBlocked?.eligible ?? 0) > 0
    || (
      categories.unclassifiedEmailDeliveryAuthorityRepairRequired?.eligible
      ?? 0
    ) > 0;
}

async function selectTerminalEmailDeletionCandidates(
  client: PoolClient,
  cutoff: string,
  limit: number,
) {
  const result = await client.query<IdRow>(
    `select /* terminal_email_deletion_candidates */ id
       from email_outbox
      where (
        status in ('sent', 'suppressed', 'failed')
        or (
          status = 'quarantined'
          and (
            provider_call_started is null
            or (
              provider_call_started is not null
              and adapter = 'gmail'
              and provider_message_id is not null
              and btrim(provider_message_id) <> ''
              and sent_at is not null
              and quarantined_at is not null
              and quarantined_at < $1::timestamptz
              and claim_version >= 2
              and claim_token is null
              and claim_owner is null
              and lease_expires_at is null
              and last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
              and dispatch_binding_version = 'gmail-raw-v1'
              and dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
              and (
                (user_id is not null and delivery_scope_key = 'a:' || user_id)
                or (
                  user_id is null
                  and delivery_scope_key = 's:' || operation_id::text
                )
              )
            )
          )
        )
      )
      and case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end < $1
      order by case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end asc, id asc
      limit $2`,
    [cutoff, limit],
  );
  return result.rows.map((row) => row.id);
}

async function selectConsoleEmailDeletionCandidates(
  client: PoolClient,
  cutoff: string,
  limit: number,
) {
  const result = await client.query<IdRow>(
    `select /* console_email_deletion_candidates */ id
       from email_outbox
      where status = 'quarantined'
        and provider_call_started is not null
        and adapter = 'console'
        and provider_message_id is null
        and sent_at is null
        and quarantined_at is not null
        and quarantined_at < $1::timestamptz
        and claim_version >= 2
        and claim_token is null
        and claim_owner is null
        and lease_expires_at is null
        and last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
        and dispatch_binding_version = 'console-json-v1'
        and dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
        and (
          (user_id is not null and delivery_scope_key = 'a:' || user_id)
          or (
            user_id is null
            and delivery_scope_key = 's:' || operation_id::text
          )
        )
        and case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end < $1
      order by case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end asc, id asc
      limit $2`,
    [cutoff, limit],
  );
  return result.rows.map((row) => row.id);
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

function isRetentionCheckpoint(report: unknown): report is RetentionCheckpoint {
  if (!report || typeof report !== "object") return false;
  const phase = (report as { phase?: unknown }).phase;
  return phase === "relational_retention_committed" || phase === "file_erasure_pending";
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
      report: RetentionCheckpoint;
    }>(
      `select id, status, report
         from data_lifecycle_run
        where operation = 'retention'
          and policy_version = $1
          and dry_run = false
          and status in ('running', 'failed')
          and report ->> 'phase' in (
            'relational_retention_committed', 'file_erasure_pending'
          )
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
    cutoff_matches: boolean;
    report: RetentionReport | RetentionCheckpoint;
  }>(
    `select id, operation, policy_version, dry_run, status, report,
            cutoff_manifest = $2::jsonb as cutoff_matches
       from data_lifecycle_run where idempotency_key = $1`,
    [input.idempotencyKey, JSON.stringify(input.cutoffs)],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Lifecycle idempotency state could not be resolved.");
  const recoverableCheckpoint = !input.dryRun
    && (row.status === "running" || row.status === "failed")
    && isRetentionCheckpoint(row.report);
  if (
    row.operation !== "retention"
    || row.policy_version !== RETENTION_POLICY_VERSION
    || row.dry_run !== input.dryRun
    || (!recoverableCheckpoint && !row.cutoff_matches)
  ) {
    throw new RetentionRunConflictError("IDEMPOTENCY_MISMATCH");
  }
  if (row.status === "succeeded") {
    const persisted = row.report as RetentionReport;
    return {
      id: row.id,
      replay: {
        ...persisted,
        outcome: persisted.outcome ?? "succeeded",
        requiresRetry: persisted.requiresRetry ?? false,
        replayed: true,
      } as RetentionReport,
      resume: null,
    };
  }
  if (recoverableCheckpoint && row.status === "running") {
    // The global retention advisory lock proves no earlier process still owns
    // this run; its connection would otherwise still hold the lock.
    return { id: row.id, replay: null, resume: row.report as RetentionCheckpoint };
  }
  if (recoverableCheckpoint && row.status === "failed") {
    const resumed = await client.query(
      `update data_lifecycle_run
          set status = 'running', error_code = null, completed_at = null,
              started_at = $2, updated_at = $2
        where id = $1 and status = 'failed'`,
      [row.id, input.now],
    );
    if ((resumed.rowCount ?? 0) === 1) {
      return { id: row.id, replay: null, resume: row.report as RetentionCheckpoint };
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
    `select id, storage_key from stored_object
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

type DurableRetentionCounts = Readonly<{
  oldAudit: number;
  durableEvidence: number;
  durableDraftsAndReceipts: number;
  durableProjectRevisionHistory: number;
  durableCertificatesAndPublicPortfolio: number;
}>;

function setDurableCategories(
  categories: Record<string, RetentionCategoryReport>,
  counts: DurableRetentionCounts,
) {
  categories.adminAudit = category(
    counts.oldAudit,
    0,
    "24 months is a minimum; launch policy performs no automatic audit purge.",
  );
  categories.masteryAndOfficialEvidence = category(
    counts.durableEvidence,
    0,
    "Retained until an administrator completes account deletion.",
  );
  categories.learnerDraftsAndSyncReceipts = category(
    counts.durableDraftsAndReceipts,
    0,
    "Authoritative drafts and idempotency receipts are retained until administrator account deletion; browser session cache is not a backup.",
  );
  categories.projectRevisionHistory = category(
    counts.durableProjectRevisionHistory,
    0,
    "Append-only project checkpoints and file metadata snapshots are retained until administrator account deletion; associated bytes remain governed by stored-object retention.",
  );
  categories.certificatesAndPublicPortfolio = category(
    counts.durableCertificatesAndPublicPortfolio,
    0,
    "Certificate evidence, revocations, explicit public-profile consent history, and selected public proofs are retained until administrator account deletion.",
  );
}

async function commitObjectRetentionCheckpoint(
  client: PoolClient,
  runId: string,
  checkpoint: RetentionRelationalCheckpoint,
): Promise<RetentionFileCheckpoint> {
  const categories = { ...checkpoint.categories };
  const evaluatedAt = new Date(checkpoint.evaluatedAt);
  if (!Number.isFinite(evaluatedAt.getTime())) {
    throw new Error("Retention checkpoint timestamp is invalid.");
  }
  await client.query("begin");
  try {
    const objectRows = await eligibleObjectRows(
      client,
      checkpoint.cutoffs,
      checkpoint.batchSize,
    );
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
          checkpoint.cutoffs.temporaryObjects,
          checkpoint.cutoffs.aiRequestMetadataAndAttachments,
          checkpoint.cutoffs.failedQuarantinedOrSoftDeletedObjects,
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
        now: evaluatedAt,
      });
      deletedObjects = deleted.rowCount ?? 0;
    }
    categories.objects = category(checkpoint.objectEligible, deletedObjects);
    const fileCheckpoint: RetentionFileCheckpoint = {
      phase: "file_erasure_pending",
      evaluatedAt: checkpoint.evaluatedAt,
      cutoffs: checkpoint.cutoffs,
      batchSize: checkpoint.batchSize,
      categories,
    };
    const persisted = await client.query(
      `update data_lifecycle_run set report = $2::jsonb, updated_at = $3
        where id = $1 and status = 'running'`,
      [runId, JSON.stringify(fileCheckpoint), evaluatedAt],
    );
    if ((persisted.rowCount ?? 0) !== 1) {
      throw new Error("Retention object checkpoint state changed before commit.");
    }
    await client.query("commit");
    return fileCheckpoint;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

function reportOutcome(
  categories: Readonly<Record<string, RetentionCategoryReport>>,
  dryRun: boolean,
) {
  if (hasEmailPrivacyFailure(categories, dryRun)) {
    return { outcome: "completed_with_errors" as const, requiresRetry: true as const };
  }
  return { outcome: "succeeded" as const, requiresRetry: false as const };
}

async function persistFinalRetentionReport(
  client: PoolClient,
  runId: string,
  report: RetentionReport,
  finishedAt: Date,
) {
  await client.query("begin");
  try {
    const persisted = await client.query(
      `update data_lifecycle_run
          set status = 'succeeded', report = $2::jsonb, error_code = $4,
              completed_at = $3, updated_at = $3
        where id = $1 and status = 'running'`,
      [
        runId,
        JSON.stringify(report),
        finishedAt,
        report.requiresRetry ? EMAIL_OUTBOX_REDACTION_RETRYABLE : null,
      ],
    );
    if ((persisted.rowCount ?? 0) !== 1) {
      throw new Error("Retention terminal state changed before commit.");
    }
    if (!report.dryRun) await purgeCompletedFileErasureJobs(client, runId);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
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
  const fileErasureProcessor = dependencies.processFileErasures
    ?? defaultRetentionDependencies.processFileErasures;
  const client = await (dependencies.acquireClient ?? defaultRetentionDependencies.acquireClient)();
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
      const fileCheckpoint = claimed.resume.phase === "relational_retention_committed"
        ? await commitObjectRetentionCheckpoint(client, runId, claimed.resume)
        : claimed.resume;
      const fileSummary = await fileErasureProcessor({
        lifecycleRunId: runId,
        objectStorageRoot: objectRoot,
      });
      const outcome = reportOutcome(fileCheckpoint.categories, false);
      const report: RetentionReport = {
        runId,
        policyVersion: RETENTION_POLICY.version,
        dryRun: false,
        evaluatedAt: fileCheckpoint.evaluatedAt,
        cutoffs: fileCheckpoint.cutoffs,
        categories: fileCheckpoint.categories,
        objectFiles: {
          removed: fileSummary.removed,
          alreadyAbsent: fileSummary.alreadyAbsent,
          failed: fileSummary.failed,
        },
        ...outcome,
        replayed: false,
      };
      await persistFinalRetentionReport(client, runId, report, new Date());
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
        where (
          status in ('sent', 'suppressed', 'failed')
          or (
            status = 'quarantined'
            and (
              provider_call_started is null
              or (
                provider_call_started is not null
                and adapter = 'gmail'
                and provider_message_id is not null
                and btrim(provider_message_id) <> ''
                and sent_at is not null
                and quarantined_at is not null
                and quarantined_at < $1::timestamptz
                and claim_version >= 2
                and claim_token is null
                and claim_owner is null
                and lease_expires_at is null
                and last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
                and dispatch_binding_version = 'gmail-raw-v1'
                and dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
                and (
                  (user_id is not null and delivery_scope_key = 'a:' || user_id)
                  or (
                    user_id is null
                    and delivery_scope_key = 's:' || operation_id::text
                  )
                )
              )
            )
          )
        )
        and case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end < $1`,
      [cutoffs.terminalEmailDeliveryRecords],
    );
    const nonExternalConsoleEmailEligible = await count(
      client,
      `select count(*)::text as count from email_outbox
        where status = 'quarantined'
          and provider_call_started is not null
          and adapter = 'console'
          and provider_message_id is null
          and sent_at is null
          and quarantined_at is not null
          and quarantined_at < $1::timestamptz
          and claim_version >= 2
          and claim_token is null
          and claim_owner is null
          and lease_expires_at is null
          and last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
          and dispatch_binding_version = 'console-json-v1'
          and dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
          and (
            (user_id is not null and delivery_scope_key = 'a:' || user_id)
            or (
              user_id is null
              and delivery_scope_key = 's:' || operation_id::text
            )
          )
          and case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end < $1`,
      [cutoffs.nonExternalConsoleDeliveryQuarantines],
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
    const durableCounts: DurableRetentionCounts = {
      oldAudit,
      durableEvidence,
      durableDraftsAndReceipts,
      durableProjectRevisionHistory,
      durableCertificatesAndPublicPortfolio,
    };

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
      const terminalEmailCandidates = emailEligible > 0
        ? await selectTerminalEmailDeletionCandidates(
            client,
            cutoffs.terminalEmailDeliveryRecords,
            limit,
          )
        : [];
      const terminalEmailCoverage = await runTerminalDeletionCoverage(
        client,
        terminalEmailCandidates,
        "report-only",
      );
      categories.terminalEmailDeliveryRecords = terminalEmailCoverage.outcome === "failed"
        ? terminalDeletionCoverageFailureCategory(
            emailEligible,
            "Terminal email deletion is blocked until durable hashed no-replay coverage is available.",
          )
        : category(
            emailEligible,
            0,
            "dry-run; durable hashed no-replay coverage confirmed for bounded deletion candidates",
          );
      const consoleEmailCandidates = nonExternalConsoleEmailEligible > 0
        ? await selectConsoleEmailDeletionCandidates(
            client,
            cutoffs.nonExternalConsoleDeliveryQuarantines,
            limit,
          )
        : [];
      const consoleEmailCoverage = await runTerminalDeletionCoverage(
        client,
        consoleEmailCandidates,
        "report-only",
      );
      categories.nonExternalConsoleDeliveryQuarantines = consoleEmailCoverage.outcome === "failed"
        ? terminalDeletionCoverageFailureCategory(
            nonExternalConsoleEmailEligible,
            "Console terminal deletion is blocked until durable hashed no-replay coverage is available.",
          )
        : category(
            nonExternalConsoleEmailEligible,
            0,
            "dry-run; durable hashed no-replay coverage confirmed for bounded deletion candidates",
          );
      categories.unclassifiedEmailDeliveryAuthorityBlocked = category(
        0,
        0,
        "Compatibility report key; v2 blocked disposition is the sole unresolved-PII authority.",
      );
      categories.unclassifiedEmailDeliveryAuthorityRepairRequired = category(
        0,
        0,
        "Compatibility report key; v2 eligible and malformed dispositions own remediation.",
      );
      const redaction = await runRedactionCapability(
        client,
        cutoffs.unresolvedEmailDeliveryAuthority,
        0,
        "report-only",
      );
      setRedactionCategories(categories, redaction, true);
      categories.backupExpiryEligibility = transitionedCategory(
        backupExpiryEligible,
        0,
        "dry-run; would mark eligible for operator verification, never verified erased",
      );
    } else {
      let relationalCheckpoint: RetentionRelationalCheckpoint | null = null;
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

        const redaction = await runRedactionCapability(
          client,
          cutoffs.unresolvedEmailDeliveryAuthority,
          limit,
          "apply",
        );
        setRedactionCategories(categories, redaction, false);

        const terminalEmailCandidates = await selectTerminalEmailDeletionCandidates(
          client,
          cutoffs.terminalEmailDeliveryRecords,
          limit,
        );
        const terminalEmailCoverage = await runTerminalDeletionCoverage(
          client,
          terminalEmailCandidates,
          "apply",
        );
        if (terminalEmailCoverage.outcome === "failed") {
          categories.terminalEmailDeliveryRecords = terminalDeletionCoverageFailureCategory(
            emailEligible,
            "Terminal email deletion retained rows because durable hashed no-replay coverage was unavailable.",
          );
        } else {
          const deletedEmail = await client.query<IdRow>(
            `delete from email_outbox where id in (
               select id from email_outbox
                where (
                  status in ('sent', 'suppressed', 'failed')
                  or (
                    status = 'quarantined'
                    and (
                      provider_call_started is null
                      or (
                        provider_call_started is not null
                        and adapter = 'gmail'
                        and provider_message_id is not null
                        and btrim(provider_message_id) <> ''
                        and sent_at is not null
                        and quarantined_at is not null
                        and quarantined_at < $1::timestamptz
                        and claim_version >= 2
                        and claim_token is null
                        and claim_owner is null
                        and lease_expires_at is null
                        and last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
                        and dispatch_binding_version = 'gmail-raw-v1'
                        and dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
                        and (
                          (
                            user_id is not null
                            and delivery_scope_key = 'a:' || user_id
                          )
                          or (
                            user_id is null
                            and delivery_scope_key = 's:' || operation_id::text
                          )
                        )
                      )
                    )
                  )
                )
                and id = any($3::uuid[])
                and case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end < $1
                order by case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end asc, id asc limit $2
             ) returning id`,
            [cutoffs.terminalEmailDeliveryRecords, limit, terminalEmailCandidates],
          );
          categories.terminalEmailDeliveryRecords = category(
            emailEligible,
            deletedEmail.rowCount ?? 0,
            "Deleted only after durable hashed no-replay coverage was confirmed.",
          );
        }

        const consoleEmailCandidates = await selectConsoleEmailDeletionCandidates(
          client,
          cutoffs.nonExternalConsoleDeliveryQuarantines,
          limit,
        );
        const consoleEmailCoverage = await runTerminalDeletionCoverage(
          client,
          consoleEmailCandidates,
          "apply",
        );
        if (consoleEmailCoverage.outcome === "failed") {
          categories.nonExternalConsoleDeliveryQuarantines = terminalDeletionCoverageFailureCategory(
            nonExternalConsoleEmailEligible,
            "Console terminal deletion retained rows because durable hashed no-replay coverage was unavailable.",
          );
        } else {
          const deletedNonExternalConsoleEmail = await client.query<IdRow>(
            `delete from email_outbox where id in (
               select id from email_outbox
                where status = 'quarantined'
                  and provider_call_started is not null
                  and adapter = 'console'
                  and provider_message_id is null
                  and sent_at is null
                  and quarantined_at is not null
                  and quarantined_at < $1::timestamptz
                  and claim_version >= 2
                  and claim_token is null
                  and claim_owner is null
                  and lease_expires_at is null
                  and last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
                  and dispatch_binding_version = 'console-json-v1'
                  and dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
                  and (
                    (
                      user_id is not null
                      and delivery_scope_key = 'a:' || user_id
                    )
                    or (
                      user_id is null
                      and delivery_scope_key = 's:' || operation_id::text
                    )
                  )
                  and id = any($3::uuid[])
                  and case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end < $1
                order by case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end asc, id asc limit $2
             ) returning id`,
            [
              cutoffs.nonExternalConsoleDeliveryQuarantines,
              limit,
              consoleEmailCandidates,
            ],
          );
          categories.nonExternalConsoleDeliveryQuarantines = category(
            nonExternalConsoleEmailEligible,
            deletedNonExternalConsoleEmail.rowCount ?? 0,
            "Deleted only after durable hashed no-replay coverage was confirmed.",
          );
        }
        categories.unclassifiedEmailDeliveryAuthorityBlocked = category(
          0,
          0,
          "Compatibility report key; v2 blocked disposition is the sole unresolved-PII authority.",
        );
        categories.unclassifiedEmailDeliveryAuthorityRepairRequired = category(
          0,
          0,
          "Compatibility report key; v2 eligible and malformed dispositions own remediation.",
        );
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
        setDurableCategories(categories, durableCounts);
        relationalCheckpoint = {
          phase: "relational_retention_committed",
          evaluatedAt: now.toISOString(),
          cutoffs,
          batchSize: limit,
          objectEligible,
          categories: { ...categories },
        };
        const persisted = await client.query(
          `update data_lifecycle_run set report = $2::jsonb, updated_at = $3
            where id = $1 and status = 'running'`,
          [runId, JSON.stringify(relationalCheckpoint), now],
        );
        if ((persisted.rowCount ?? 0) !== 1) {
          throw new Error("Retention relational checkpoint state changed before commit.");
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }

      if (!relationalCheckpoint) {
        throw new Error("Retention relational checkpoint was not created.");
      }
      const objectRoot = input.objectStorageRoot ?? process.env.OBJECT_STORAGE_PATH ?? "./data/objects";
      const fileCheckpoint = await commitObjectRetentionCheckpoint(
        client,
        runId,
        relationalCheckpoint,
      );
      Object.assign(categories, fileCheckpoint.categories);
      // No unlink occurs until both metadata deletion and its durable queue
      // checkpoint commit. A crash resumes from the stored checkpoint.
      const fileSummary = await fileErasureProcessor({
        lifecycleRunId: runId,
        objectStorageRoot: objectRoot,
      });
      objectFiles.removed = fileSummary.removed;
      objectFiles.alreadyAbsent = fileSummary.alreadyAbsent;
      objectFiles.failed = fileSummary.failed;
    }
    setDurableCategories(categories, durableCounts);
    const outcome = reportOutcome(categories, input.dryRun);

    const report: RetentionReport = {
      runId,
      policyVersion: RETENTION_POLICY.version,
      dryRun: input.dryRun,
      evaluatedAt: now.toISOString(),
      cutoffs,
      categories,
      objectFiles,
      ...outcome,
      replayed: false,
    };
    await persistFinalRetentionReport(client, runId, report, new Date());
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
