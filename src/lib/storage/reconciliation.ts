import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { pool } from "@/lib/db/client";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_STORAGE_QUOTA_BYTES,
} from "@/lib/storage/policy";

export const STORAGE_RECONCILIATION_POLICY_VERSION = "storage-reconciliation-2026-07.v1";
export const STORAGE_RECONCILIATION_APPLY_CONFIRMATION = STORAGE_RECONCILIATION_POLICY_VERSION;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StorageReconciliationIssueCode =
  | "MISSING_FILE"
  | "INTEGRITY_MISMATCH"
  | "INVALID_STORAGE_KEY"
  | "INSPECTION_ERROR"
  | "ORPHAN_FILESYSTEM_ENTRY"
  | "DELETED_FILE_RETAINED"
  | "LEDGER_DRIFT"
  | "USAGE_EXCEEDS_QUOTA"
  | "QUOTA_OUT_OF_POLICY"
  | "UNOWNED_ACTIVE_OBJECT"
  | "CAPACITY_WARNING"
  | "CAPACITY_CRITICAL"
  | "CAPACITY_EMERGENCY"
  | "APPLY_CONFLICT";

export type StorageObjectIntegrityIssueCode =
  | "MISSING_FILE"
  | "INTEGRITY_MISMATCH"
  | "INVALID_STORAGE_KEY"
  | "INSPECTION_ERROR";

export type StorageCapacityBand = "NORMAL" | "WARNING" | "CRITICAL" | "EMERGENCY";

export class StorageReconciliationError extends Error {
  constructor(readonly code:
    | "INVALID_REQUEST"
    | "APPLY_CONFIRMATION_REQUIRED"
    | "ROOT_UNAVAILABLE"
    | "CAPACITY_UNAVAILABLE"
    | "DATABASE_INVARIANT"
    | "DATABASE_FAILURE") {
    super(code);
    this.name = "StorageReconciliationError";
  }
}

export interface StorageLearnerSnapshot {
  readonly userId: string;
  readonly quotaBytes: number;
}

export interface StorageObjectSnapshot {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly deletedAt: Date | null;
}

export interface StorageLedgerSnapshot {
  readonly userId: string;
  readonly bytes: number;
}

export interface StorageReconciliationSnapshot {
  readonly learners: readonly StorageLearnerSnapshot[];
  readonly objects: readonly StorageObjectSnapshot[];
  readonly ledgers: readonly StorageLedgerSnapshot[];
}

export interface StorageObjectIntegrityIssue {
  readonly code: StorageObjectIntegrityIssueCode;
  readonly object: StorageObjectSnapshot;
}

export interface StorageFilesystemInspection {
  readonly verifiedActiveObjects: number;
  readonly objectIssues: readonly StorageObjectIntegrityIssue[];
  readonly orphanEntries: number;
  readonly orphanBytes: number;
  readonly retainedDeletedFiles: number;
  readonly retainedDeletedBytes: number;
  readonly inspectionErrors: number;
  readonly capacity: {
    readonly totalBytes: number;
    readonly availableBytes: number;
  };
}

export interface StorageReconciliationInspector {
  inspect(
    root: string,
    objects: readonly StorageObjectSnapshot[],
  ): Promise<StorageFilesystemInspection>;
}

export interface StorageReconciliationApplyResult {
  readonly ledgerAdjustmentsInserted: number;
  readonly objectsFailedClosed: number;
  readonly applyConflicts: number;
}

export interface StorageReconciliationRepository {
  snapshot(): Promise<StorageReconciliationSnapshot>;
  apply(input: {
    readonly runId: string;
    readonly now: Date;
    readonly driftUserIds: readonly string[];
    readonly objectIssues: readonly StorageObjectIntegrityIssue[];
  }): Promise<StorageReconciliationApplyResult>;
}

export interface StorageReconciliationReport {
  readonly schemaVersion: "1.0.0";
  readonly policyVersion: typeof STORAGE_RECONCILIATION_POLICY_VERSION;
  readonly runId: string;
  readonly mode: "dry-run" | "apply";
  readonly generatedAt: string;
  readonly status: "HEALTHY" | "FINDINGS" | "APPLIED" | "APPLIED_WITH_FINDINGS" | "APPLY_INCOMPLETE";
  readonly summary: {
    readonly learners: number;
    readonly activeObjects: number;
    readonly deletedObjects: number;
    readonly databaseActiveBytes: number;
    readonly ledgerBytes: number;
    readonly verifiedActiveObjects: number;
    readonly objectIntegrityFindings: number;
    readonly orphanFilesystemEntries: number;
    readonly orphanFilesystemBytes: number;
    readonly retainedDeletedFiles: number;
    readonly retainedDeletedBytes: number;
    readonly ledgerDriftLearners: number;
    readonly ledgerDriftBytesAbsolute: number;
    readonly remainingLedgerDriftLearners: number;
    readonly learnersOverQuota: number;
    readonly learnersQuotaOutOfPolicy: number;
    readonly unownedActiveObjects: number;
    readonly capacity: {
      readonly totalBytes: number;
      readonly availableBytes: number;
      readonly usedBytes: number;
      readonly usedBasisPoints: number;
      readonly band: StorageCapacityBand;
      readonly thresholdsBasisPoints: readonly [7000, 8500, 9500];
    };
  };
  readonly issueCounts: Readonly<Record<StorageReconciliationIssueCode, number>>;
  readonly actions: StorageReconciliationApplyResult & {
    readonly unknownFilesDeleted: 0;
    readonly metadataRewrittenFromDisk: 0;
  };
  readonly privacy: {
    readonly containsFilenames: false;
    readonly containsHashes: false;
    readonly containsStorageKeysOrPaths: false;
    readonly containsLearnerIdentifiers: false;
  };
}

interface Analysis {
  readonly activeObjects: readonly StorageObjectSnapshot[];
  readonly deletedObjects: readonly StorageObjectSnapshot[];
  readonly databaseActiveBytes: number;
  readonly ledgerBytes: number;
  readonly driftUserIds: readonly string[];
  readonly driftBytesAbsolute: number;
  readonly learnersOverQuota: number;
  readonly learnersQuotaOutOfPolicy: number;
  readonly unownedActiveObjects: number;
}

function safeNonnegativeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new StorageReconciliationError("DATABASE_INVARIANT");
  }
  return number;
}

function safeSignedInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new StorageReconciliationError("DATABASE_INVARIANT");
  }
  return number;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new StorageReconciliationError("DATABASE_INVARIANT");
  return result;
}

function analyze(snapshot: StorageReconciliationSnapshot): Analysis {
  const activeObjects = snapshot.objects.filter((object) => object.deletedAt === null);
  const deletedObjects = snapshot.objects.filter((object) => object.deletedAt !== null);
  const learnerIds = new Set(snapshot.learners.map((learner) => learner.userId));
  const activeByUser = new Map<string, number>();
  let databaseActiveBytes = 0;
  let unownedActiveObjects = 0;
  for (const object of activeObjects) {
    const bytes = safeNonnegativeInteger(object.sizeBytes);
    databaseActiveBytes = safeAdd(databaseActiveBytes, bytes);
    if (!object.ownerUserId || !learnerIds.has(object.ownerUserId)) {
      unownedActiveObjects += 1;
      continue;
    }
    activeByUser.set(object.ownerUserId, safeAdd(activeByUser.get(object.ownerUserId) ?? 0, bytes));
  }
  const ledgerByUser = new Map<string, number>();
  let ledgerBytes = 0;
  for (const ledger of snapshot.ledgers) {
    const bytes = safeSignedInteger(ledger.bytes);
    ledgerBytes = safeAdd(ledgerBytes, bytes);
    ledgerByUser.set(ledger.userId, safeAdd(ledgerByUser.get(ledger.userId) ?? 0, bytes));
  }
  const driftUserIds: string[] = [];
  let driftBytesAbsolute = 0;
  for (const userId of [...learnerIds].sort()) {
    const drift = (activeByUser.get(userId) ?? 0) - (ledgerByUser.get(userId) ?? 0);
    if (drift !== 0) {
      driftUserIds.push(userId);
      driftBytesAbsolute = safeAdd(driftBytesAbsolute, Math.abs(drift));
    }
  }
  let learnersOverQuota = 0;
  let learnersQuotaOutOfPolicy = 0;
  for (const learner of snapshot.learners) {
    const quota = safeNonnegativeInteger(learner.quotaBytes);
    if (quota < DEFAULT_STORAGE_QUOTA_BYTES || quota > MAX_STORAGE_QUOTA_BYTES) {
      learnersQuotaOutOfPolicy += 1;
    }
    if ((activeByUser.get(learner.userId) ?? 0) > quota) learnersOverQuota += 1;
  }
  return {
    activeObjects,
    deletedObjects,
    databaseActiveBytes,
    ledgerBytes,
    driftUserIds,
    driftBytesAbsolute,
    learnersOverQuota,
    learnersQuotaOutOfPolicy,
    unownedActiveObjects,
  };
}

export function storageCapacityBand(usedBasisPoints: number): StorageCapacityBand {
  if (!Number.isInteger(usedBasisPoints) || usedBasisPoints < 0 || usedBasisPoints > 10_000) {
    throw new StorageReconciliationError("CAPACITY_UNAVAILABLE");
  }
  if (usedBasisPoints >= 9500) return "EMERGENCY";
  if (usedBasisPoints >= 8500) return "CRITICAL";
  if (usedBasisPoints >= 7000) return "WARNING";
  return "NORMAL";
}

function emptyIssueCounts(): Record<StorageReconciliationIssueCode, number> {
  return {
    MISSING_FILE: 0,
    INTEGRITY_MISMATCH: 0,
    INVALID_STORAGE_KEY: 0,
    INSPECTION_ERROR: 0,
    ORPHAN_FILESYSTEM_ENTRY: 0,
    DELETED_FILE_RETAINED: 0,
    LEDGER_DRIFT: 0,
    USAGE_EXCEEDS_QUOTA: 0,
    QUOTA_OUT_OF_POLICY: 0,
    UNOWNED_ACTIVE_OBJECT: 0,
    CAPACITY_WARNING: 0,
    CAPACITY_CRITICAL: 0,
    CAPACITY_EMERGENCY: 0,
    APPLY_CONFLICT: 0,
  };
}

function capacity(input: StorageFilesystemInspection["capacity"]) {
  const totalBytes = safeNonnegativeInteger(input.totalBytes);
  const availableBytes = safeNonnegativeInteger(input.availableBytes);
  if (totalBytes <= 0 || availableBytes > totalBytes) {
    throw new StorageReconciliationError("CAPACITY_UNAVAILABLE");
  }
  const usedBytes = totalBytes - availableBytes;
  const usedBasisPoints = Math.min(
    10_000,
    Number((BigInt(usedBytes) * 10_000n) / BigInt(totalBytes)),
  );
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedBasisPoints,
    band: storageCapacityBand(usedBasisPoints),
    thresholdsBasisPoints: [7000, 8500, 9500] as const,
  };
}

function statusFor(input: {
  readonly mode: "dry-run" | "apply";
  readonly issueCounts: Readonly<Record<StorageReconciliationIssueCode, number>>;
  readonly remainingLedgerDriftLearners: number;
  readonly actions: StorageReconciliationApplyResult;
}) {
  const totalIssues = Object.values(input.issueCounts).reduce((sum, count) => sum + count, 0);
  if (input.mode === "dry-run") return totalIssues === 0 ? "HEALTHY" as const : "FINDINGS" as const;
  if (input.actions.applyConflicts > 0 || input.remainingLedgerDriftLearners > 0) return "APPLY_INCOMPLETE" as const;
  const remediableObserved = input.issueCounts.LEDGER_DRIFT +
    input.issueCounts.MISSING_FILE + input.issueCounts.INTEGRITY_MISMATCH + input.issueCounts.INVALID_STORAGE_KEY;
  const unresolved = totalIssues - remediableObserved;
  if (unresolved > 0 || input.issueCounts.MISSING_FILE > 0 || input.issueCounts.INTEGRITY_MISMATCH > 0 || input.issueCounts.INVALID_STORAGE_KEY > 0) {
    return "APPLIED_WITH_FINDINGS" as const;
  }
  return "APPLIED" as const;
}

export async function reconcileStorage(input: {
  readonly repository: StorageReconciliationRepository;
  readonly inspector: StorageReconciliationInspector;
  readonly root: string;
  readonly mode?: "dry-run" | "apply";
  readonly confirmation?: string;
  readonly runId?: string;
  readonly now?: Date;
}): Promise<StorageReconciliationReport> {
  const mode = input.mode ?? "dry-run";
  const runId = input.runId ?? randomUUID();
  const now = input.now ?? new Date();
  if (!UUID_PATTERN.test(runId) || !Number.isFinite(now.getTime()) || (mode !== "dry-run" && mode !== "apply")) {
    throw new StorageReconciliationError("INVALID_REQUEST");
  }
  if (mode === "apply" && input.confirmation !== STORAGE_RECONCILIATION_APPLY_CONFIRMATION) {
    throw new StorageReconciliationError("APPLY_CONFIRMATION_REQUIRED");
  }
  const snapshot = await input.repository.snapshot();
  const initial = analyze(snapshot);
  const filesystem = await input.inspector.inspect(input.root, snapshot.objects);
  const capacitySummary = capacity(filesystem.capacity);
  const issueCounts = emptyIssueCounts();
  for (const issue of filesystem.objectIssues) issueCounts[issue.code] += 1;
  issueCounts.INSPECTION_ERROR += filesystem.inspectionErrors;
  issueCounts.ORPHAN_FILESYSTEM_ENTRY += filesystem.orphanEntries;
  issueCounts.DELETED_FILE_RETAINED += filesystem.retainedDeletedFiles;
  issueCounts.LEDGER_DRIFT += initial.driftUserIds.length;
  issueCounts.USAGE_EXCEEDS_QUOTA += initial.learnersOverQuota;
  issueCounts.QUOTA_OUT_OF_POLICY += initial.learnersQuotaOutOfPolicy;
  issueCounts.UNOWNED_ACTIVE_OBJECT += initial.unownedActiveObjects;
  if (capacitySummary.band === "WARNING") issueCounts.CAPACITY_WARNING = 1;
  if (capacitySummary.band === "CRITICAL") issueCounts.CAPACITY_CRITICAL = 1;
  if (capacitySummary.band === "EMERGENCY") issueCounts.CAPACITY_EMERGENCY = 1;

  let actions: StorageReconciliationApplyResult = {
    ledgerAdjustmentsInserted: 0,
    objectsFailedClosed: 0,
    applyConflicts: 0,
  };
  let remainingLedgerDriftLearners = initial.driftUserIds.length;
  if (mode === "apply") {
    actions = await input.repository.apply({
      runId,
      now,
      driftUserIds: initial.driftUserIds,
      objectIssues: filesystem.objectIssues.filter((issue) => issue.code !== "INSPECTION_ERROR"),
    });
    issueCounts.APPLY_CONFLICT = actions.applyConflicts;
    remainingLedgerDriftLearners = analyze(await input.repository.snapshot()).driftUserIds.length;
  }
  return {
    schemaVersion: "1.0.0",
    policyVersion: STORAGE_RECONCILIATION_POLICY_VERSION,
    runId,
    mode,
    generatedAt: now.toISOString(),
    status: statusFor({ mode, issueCounts, remainingLedgerDriftLearners, actions }),
    summary: {
      learners: snapshot.learners.length,
      activeObjects: initial.activeObjects.length,
      deletedObjects: initial.deletedObjects.length,
      databaseActiveBytes: initial.databaseActiveBytes,
      ledgerBytes: initial.ledgerBytes,
      verifiedActiveObjects: filesystem.verifiedActiveObjects,
      objectIntegrityFindings: filesystem.objectIssues.length,
      orphanFilesystemEntries: filesystem.orphanEntries,
      orphanFilesystemBytes: safeNonnegativeInteger(filesystem.orphanBytes),
      retainedDeletedFiles: filesystem.retainedDeletedFiles,
      retainedDeletedBytes: safeNonnegativeInteger(filesystem.retainedDeletedBytes),
      ledgerDriftLearners: initial.driftUserIds.length,
      ledgerDriftBytesAbsolute: initial.driftBytesAbsolute,
      remainingLedgerDriftLearners,
      learnersOverQuota: initial.learnersOverQuota,
      learnersQuotaOutOfPolicy: initial.learnersQuotaOutOfPolicy,
      unownedActiveObjects: initial.unownedActiveObjects,
      capacity: capacitySummary,
    },
    issueCounts,
    actions: {
      ...actions,
      unknownFilesDeleted: 0,
      metadataRewrittenFromDisk: 0,
    },
    privacy: {
      containsFilenames: false,
      containsHashes: false,
      containsStorageKeysOrPaths: false,
      containsLearnerIdentifiers: false,
    },
  };
}

export function toAdminStorageReconciliationSummary(report: StorageReconciliationReport) {
  return {
    status: report.status,
    mode: report.mode,
    generatedAt: report.generatedAt,
    objects: {
      active: report.summary.activeObjects,
      verified: report.summary.verifiedActiveObjects,
      integrityFindings: report.summary.objectIntegrityFindings,
      orphanEntries: report.summary.orphanFilesystemEntries,
      retainedDeletedFiles: report.summary.retainedDeletedFiles,
    },
    quota: {
      learners: report.summary.learners,
      driftLearners: report.summary.remainingLedgerDriftLearners,
      overQuotaLearners: report.summary.learnersOverQuota,
      outOfPolicyLearners: report.summary.learnersQuotaOutOfPolicy,
    },
    capacity: report.summary.capacity,
    actions: report.actions,
  };
}

interface LearnerRow { user_id: string; quota_bytes: string | number }
interface ObjectRow {
  id: string;
  owner_user_id: string | null;
  storage_key: string;
  size_bytes: string | number;
  sha256: string;
  deleted_at: Date | null;
}
interface LedgerRow { user_id: string; bytes: string | number }

function adjustmentKey(runId: string, userId: string, activeBytes: number, ledgerBytes: number) {
  const digest = createHash("sha256")
    .update(STORAGE_RECONCILIATION_POLICY_VERSION)
    .update("\0")
    .update(runId)
    .update("\0")
    .update(userId)
    .update("\0")
    .update(String(activeBytes))
    .update("\0")
    .update(String(ledgerBytes))
    .digest("hex");
  return "storage-reconcile:" + digest;
}

export class PostgresStorageReconciliationRepository implements StorageReconciliationRepository {
  constructor(private readonly database: Pick<Pool, "query" | "connect"> = pool) {}

  async snapshot(): Promise<StorageReconciliationSnapshot> {
    try {
      const [learners, objects, ledgers] = await Promise.all([
        this.database.query<LearnerRow>(
          `select u.id user_id, coalesce(lp.storage_quota_bytes, $1)::text quota_bytes
             from "user" u left join learner_profile lp on lp.user_id = u.id
            where u.role = 'learner' order by u.id`,
          [DEFAULT_STORAGE_QUOTA_BYTES],
        ),
        this.database.query<ObjectRow>(
          `select id, owner_user_id, storage_key, size_bytes::text size_bytes, sha256, deleted_at
             from stored_object order by id`,
        ),
        this.database.query<LedgerRow>(
          `select user_id, coalesce(sum(bytes), 0)::text bytes
             from quota_ledger group by user_id order by user_id`,
        ),
      ]);
      return {
        learners: learners.rows.map((row) => ({
          userId: row.user_id,
          quotaBytes: safeNonnegativeInteger(row.quota_bytes),
        })),
        objects: objects.rows.map((row) => ({
          id: row.id,
          ownerUserId: row.owner_user_id,
          storageKey: row.storage_key,
          sizeBytes: safeNonnegativeInteger(row.size_bytes),
          sha256: row.sha256,
          deletedAt: row.deleted_at,
        })),
        ledgers: ledgers.rows.map((row) => ({
          userId: row.user_id,
          bytes: safeSignedInteger(row.bytes),
        })),
      };
    } catch (error) {
      if (error instanceof StorageReconciliationError) throw error;
      throw new StorageReconciliationError("DATABASE_FAILURE");
    }
  }

  async apply(input: {
    readonly runId: string;
    readonly now: Date;
    readonly driftUserIds: readonly string[];
    readonly objectIssues: readonly StorageObjectIntegrityIssue[];
  }): Promise<StorageReconciliationApplyResult> {
    const client = await this.database.connect().catch(() => {
      throw new StorageReconciliationError("DATABASE_FAILURE");
    });
    let ledgerAdjustmentsInserted = 0;
    let objectsFailedClosed = 0;
    let applyConflicts = 0;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [STORAGE_RECONCILIATION_POLICY_VERSION]);
      const orderedIssues = [...input.objectIssues].sort((left, right) => left.object.id.localeCompare(right.object.id));
      for (const issue of orderedIssues) {
        const scanErrorCode = issue.code === "MISSING_FILE"
          ? "file_missing"
          : issue.code === "INVALID_STORAGE_KEY"
            ? "path_invalid"
            : "file_changed";
        const updated = await client.query(
          `update stored_object
              set scan_status = 'scanner_error', scan_error_code = $2,
                  scan_lease_token = null, scan_lease_expires_at = null, updated_at = $3
            where id = $1 and deleted_at is null and storage_key = $4
              and size_bytes = $5 and sha256 = $6`,
          [issue.object.id, scanErrorCode, input.now, issue.object.storageKey, issue.object.sizeBytes, issue.object.sha256],
        );
        if (updated.rowCount === 1) objectsFailedClosed += 1;
        else applyConflicts += 1;
      }
      for (const userId of [...new Set(input.driftUserIds)].sort()) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [userId]);
        // pg clients serialize one statement at a time. Keep these reads
        // sequential so the transaction stays compatible with pg 9.
        const active = await client.query<{ bytes: string }>(
          `select coalesce(sum(size_bytes), 0)::text bytes from stored_object
            where owner_user_id = $1 and deleted_at is null`,
          [userId],
        );
        const ledger = await client.query<{ bytes: string }>(
          `select coalesce(sum(bytes), 0)::text bytes from quota_ledger where user_id = $1`,
          [userId],
        );
        const activeBytes = safeNonnegativeInteger(active.rows[0]?.bytes ?? 0);
        const ledgerBytes = safeSignedInteger(ledger.rows[0]?.bytes ?? 0);
        const adjustment = activeBytes - ledgerBytes;
        if (adjustment === 0) continue;
        const inserted = await client.query(
          `insert into quota_ledger
            (user_id, object_id, operation, bytes, idempotency_key, occurred_at)
           values ($1, null, 'reconcile_adjustment', $2, $3, $4)
           on conflict (user_id, idempotency_key) do nothing returning id`,
          [userId, adjustment, adjustmentKey(input.runId, userId, activeBytes, ledgerBytes), input.now],
        );
        if (inserted.rowCount === 1) ledgerAdjustmentsInserted += 1;
        else applyConflicts += 1;
      }
      await client.query("commit");
      return { ledgerAdjustmentsInserted, objectsFailedClosed, applyConflicts };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      if (error instanceof StorageReconciliationError) throw error;
      throw new StorageReconciliationError("DATABASE_FAILURE");
    } finally {
      client.release();
    }
  }
}
