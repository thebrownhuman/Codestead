import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import { learnerProfile, quotaLedger, storedObject, user } from "@/lib/db/schema";
import { NodeStorageReconciliationInspector } from "@/lib/storage/reconciliation-filesystem";
import {
  PostgresStorageReconciliationRepository,
  reconcileStorage,
  STORAGE_RECONCILIATION_APPLY_CONFIRMATION,
} from "@/lib/storage/reconciliation";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "@/lib/storage/policy";

const USER_ID = "storage-reconciliation-learner";
const PUBLIC_ID = "a1000000-0000-4000-8000-000000000001";
const RUN_ID = "a2000000-0000-4000-8000-000000000001";
const OWNER = "a".repeat(64);
const NOW = new Date("2026-07-12T12:00:00.000Z");
const OBJECT_IDS = {
  good: "a3000000-0000-4000-8000-000000000001",
  missing: "a3000000-0000-4000-8000-000000000002",
  changed: "a3000000-0000-4000-8000-000000000003",
  deleted: "a3000000-0000-4000-8000-000000000004",
  unknown: "a3000000-0000-4000-8000-000000000005",
} as const;

let root: string;

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Storage reconciliation integration requires the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

beforeEach(async () => {
  await truncateApplicationTables();
  root = await mkdtemp(path.join(tmpdir(), "learncoding-storage-reconciliation-it-"));
  await mkdir(path.join(root, OWNER), { recursive: true });
  await db.insert(user).values({
    id: USER_ID,
    publicId: PUBLIC_ID,
    name: "Storage Reconciliation Learner",
    email: "storage-reconciliation@integration.invalid",
    role: "learner",
    status: "active",
  });
  await db.insert(learnerProfile).values({
    userId: USER_ID,
    storageQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
    rowVersion: 1,
  });
  await db.insert(storedObject).values([
    {
      id: OBJECT_IDS.good,
      ownerUserId: USER_ID,
      storageKey: OWNER + "/" + OBJECT_IDS.good,
      originalName: "private-good-name.txt",
      mediaType: "text/plain",
      sizeBytes: 4,
      sha256: digest("good"),
      scanStatus: "safe",
    },
    {
      id: OBJECT_IDS.missing,
      ownerUserId: USER_ID,
      storageKey: OWNER + "/" + OBJECT_IDS.missing,
      originalName: "private-missing-name.txt",
      mediaType: "text/plain",
      sizeBytes: 7,
      sha256: digest("missing"),
      scanStatus: "safe",
    },
    {
      id: OBJECT_IDS.changed,
      ownerUserId: USER_ID,
      storageKey: OWNER + "/" + OBJECT_IDS.changed,
      originalName: "private-changed-name.txt",
      mediaType: "text/plain",
      sizeBytes: 3,
      sha256: digest("expected"),
      scanStatus: "safe",
    },
    {
      id: OBJECT_IDS.deleted,
      ownerUserId: USER_ID,
      storageKey: OWNER + "/" + OBJECT_IDS.deleted,
      originalName: "private-deleted-name.txt",
      mediaType: "text/plain",
      sizeBytes: 3,
      sha256: digest("old"),
      scanStatus: "deleted",
      deletedAt: NOW,
    },
  ]);
  await db.insert(quotaLedger).values({
    userId: USER_ID,
    objectId: OBJECT_IDS.good,
    operation: "reserve_and_finalize",
    bytes: 2,
    idempotencyKey: "deliberate-drift-fixture",
  });
  await writeFile(path.join(root, OWNER, OBJECT_IDS.good), "good");
  await writeFile(path.join(root, OWNER, OBJECT_IDS.changed), "bad");
  await writeFile(path.join(root, OWNER, OBJECT_IDS.deleted), "old");
  await writeFile(path.join(root, OWNER, OBJECT_IDS.unknown), "unknown");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL and filesystem storage reconciliation", () => {
  it("reports drift safely, applies only ledger/fail-closed repairs, and never deletes unknown bytes", async () => {
    const repository = new PostgresStorageReconciliationRepository();
    const inspector = new NodeStorageReconciliationInspector();
    const dryRun = await reconcileStorage({ repository, inspector, root, runId: RUN_ID, now: NOW });
    expect(dryRun.status).toBe("FINDINGS");
    expect(dryRun.summary).toMatchObject({
      learners: 1,
      activeObjects: 3,
      deletedObjects: 1,
      databaseActiveBytes: 14,
      ledgerBytes: 2,
      verifiedActiveObjects: 1,
      objectIntegrityFindings: 2,
      orphanFilesystemEntries: 1,
      orphanFilesystemBytes: 7,
      retainedDeletedFiles: 1,
      retainedDeletedBytes: 3,
      ledgerDriftLearners: 1,
      remainingLedgerDriftLearners: 1,
    });
    expect(dryRun.issueCounts).toMatchObject({
      MISSING_FILE: 1,
      INTEGRITY_MISMATCH: 1,
      ORPHAN_FILESYSTEM_ENTRY: 1,
      DELETED_FILE_RETAINED: 1,
      LEDGER_DRIFT: 1,
    });
    const serialized = JSON.stringify(dryRun);
    expect(serialized).not.toContain(USER_ID);
    expect(serialized).not.toContain("private-good-name.txt");
    expect(serialized).not.toContain(OWNER);
    expect(serialized).not.toContain(digest("good"));

    const applied = await reconcileStorage({
      repository,
      inspector,
      root,
      mode: "apply",
      confirmation: STORAGE_RECONCILIATION_APPLY_CONFIRMATION,
      runId: RUN_ID,
      now: NOW,
    });
    expect(applied.status).toBe("APPLIED_WITH_FINDINGS");
    expect(applied.actions).toMatchObject({
      ledgerAdjustmentsInserted: 1,
      objectsFailedClosed: 2,
      applyConflicts: 0,
      unknownFilesDeleted: 0,
      metadataRewrittenFromDisk: 0,
    });
    expect(applied.summary.remainingLedgerDriftLearners).toBe(0);

    const objects = await db.select().from(storedObject);
    expect(objects.find((object) => object.id === OBJECT_IDS.good)).toMatchObject({ scanStatus: "safe" });
    expect(objects.find((object) => object.id === OBJECT_IDS.missing)).toMatchObject({
      scanStatus: "scanner_error",
      scanErrorCode: "file_missing",
      sizeBytes: 7,
      sha256: digest("missing"),
    });
    expect(objects.find((object) => object.id === OBJECT_IDS.changed)).toMatchObject({
      scanStatus: "scanner_error",
      scanErrorCode: "file_changed",
      sizeBytes: 3,
      sha256: digest("expected"),
    });
    const ledger = await pool.query<{ bytes: string }>(
      "select coalesce(sum(bytes),0)::text bytes from quota_ledger where user_id = $1",
      [USER_ID],
    );
    expect(ledger.rows[0]?.bytes).toBe("14");
    await expect(access(path.join(root, OWNER, OBJECT_IDS.unknown))).resolves.toBeUndefined();
    await expect(access(path.join(root, OWNER, OBJECT_IDS.deleted))).resolves.toBeUndefined();

    const verified = await reconcileStorage({
      repository,
      inspector,
      root,
      runId: "a2000000-0000-4000-8000-000000000002",
      now: NOW,
    });
    expect(verified.summary.ledgerDriftLearners).toBe(0);
    expect(verified.issueCounts.LEDGER_DRIFT).toBe(0);
    expect(verified.issueCounts.MISSING_FILE).toBe(1);
    expect(verified.issueCounts.INTEGRITY_MISMATCH).toBe(1);
  });
});
