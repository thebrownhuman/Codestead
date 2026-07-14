import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeStorageReconciliationInspector } from "../reconciliation-filesystem";
import {
  reconcileStorage,
  STORAGE_RECONCILIATION_APPLY_CONFIRMATION,
  StorageReconciliationError,
  storageCapacityBand,
  toAdminStorageReconciliationSummary,
  type StorageFilesystemInspection,
  type StorageObjectSnapshot,
  type StorageReconciliationApplyResult,
  type StorageReconciliationRepository,
  type StorageReconciliationSnapshot,
} from "../reconciliation";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_STORAGE_QUOTA_BYTES,
} from "../policy";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-12T12:00:00.000Z");
const SECRET_USER = "learner-secret-identity";
const SECRET_KEY = "secret-owner/10000000-0000-4000-8000-000000000009";
const SECRET_HASH = "a".repeat(64);

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot(overrides: Partial<StorageReconciliationSnapshot> = {}): StorageReconciliationSnapshot {
  return {
    learners: [{ userId: SECRET_USER, quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES }],
    objects: [{
      id: "10000000-0000-4000-8000-000000000009",
      ownerUserId: SECRET_USER,
      storageKey: SECRET_KEY,
      sizeBytes: 4,
      sha256: SECRET_HASH,
      deletedAt: null,
    }],
    ledgers: [{ userId: SECRET_USER, bytes: 4 }],
    ...overrides,
  };
}

function inspection(overrides: Partial<StorageFilesystemInspection> = {}): StorageFilesystemInspection {
  return {
    verifiedActiveObjects: 1,
    objectIssues: [],
    orphanEntries: 0,
    orphanBytes: 0,
    retainedDeletedFiles: 0,
    retainedDeletedBytes: 0,
    inspectionErrors: 0,
    capacity: { totalBytes: 1_000_000, availableBytes: 500_000 },
    ...overrides,
  };
}

function fakeRepository(
  snapshots: readonly StorageReconciliationSnapshot[],
  applied: StorageReconciliationApplyResult = {
    ledgerAdjustmentsInserted: 0,
    objectsFailedClosed: 0,
    applyConflicts: 0,
  },
) {
  let index = 0;
  const repository: StorageReconciliationRepository = {
    snapshot: vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]!),
    apply: vi.fn(async () => applied),
  };
  return repository;
}

describe("storage reconciliation analysis", () => {
  it("returns a deterministic redacted healthy dry-run without mutating storage", async () => {
    const repository = fakeRepository([snapshot()]);
    const inspector = { inspect: vi.fn(async () => inspection()) };
    const report = await reconcileStorage({
      repository,
      inspector,
      root: "C:/never-reported/root",
      runId: RUN_ID,
      now: NOW,
    });
    expect(report).toMatchObject({
      schemaVersion: "1.0.0",
      runId: RUN_ID,
      mode: "dry-run",
      generatedAt: NOW.toISOString(),
      status: "HEALTHY",
      summary: {
        learners: 1,
        activeObjects: 1,
        databaseActiveBytes: 4,
        ledgerBytes: 4,
        remainingLedgerDriftLearners: 0,
        capacity: { usedBasisPoints: 5000, band: "NORMAL" },
      },
      actions: {
        ledgerAdjustmentsInserted: 0,
        objectsFailedClosed: 0,
        applyConflicts: 0,
        unknownFilesDeleted: 0,
        metadataRewrittenFromDisk: 0,
      },
    });
    expect(repository.apply).not.toHaveBeenCalled();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SECRET_USER);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain(SECRET_HASH);
    expect(serialized).not.toContain("filename");
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("sha256");
  });

  it("counts integrity, orphan, quota, ledger, ownership, and emergency-capacity findings", async () => {
    const activeOwned: StorageObjectSnapshot = {
      id: "10000000-0000-4000-8000-000000000010",
      ownerUserId: SECRET_USER,
      storageKey: SECRET_KEY,
      sizeBytes: DEFAULT_STORAGE_QUOTA_BYTES + 1,
      sha256: SECRET_HASH,
      deletedAt: null,
    };
    const activeUnowned: StorageObjectSnapshot = {
      ...activeOwned,
      id: "10000000-0000-4000-8000-000000000011",
      ownerUserId: "non-learner-owner",
      storageKey: "shared/10000000-0000-4000-8000-000000000011",
      sizeBytes: 1,
    };
    const deleted: StorageObjectSnapshot = {
      ...activeOwned,
      id: "10000000-0000-4000-8000-000000000012",
      storageKey: "secret-owner/10000000-0000-4000-8000-000000000012",
      sizeBytes: 2,
      deletedAt: NOW,
    };
    const database = snapshot({
      learners: [
        { userId: SECRET_USER, quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES },
        { userId: "out-of-policy", quotaBytes: MAX_STORAGE_QUOTA_BYTES + 1 },
      ],
      objects: [activeOwned, activeUnowned, deleted],
      ledgers: [{ userId: SECRET_USER, bytes: 0 }],
    });
    const filesystem = inspection({
      verifiedActiveObjects: 0,
      objectIssues: [
        { code: "MISSING_FILE", object: activeOwned },
        { code: "INVALID_STORAGE_KEY", object: activeUnowned },
      ],
      orphanEntries: 3,
      orphanBytes: 20,
      retainedDeletedFiles: 1,
      retainedDeletedBytes: 2,
      inspectionErrors: 2,
      capacity: { totalBytes: 1000, availableBytes: 49 },
    });
    const report = await reconcileStorage({
      repository: fakeRepository([database]),
      inspector: { inspect: vi.fn(async () => filesystem) },
      root: "C:/redacted",
      runId: RUN_ID,
      now: NOW,
    });
    expect(report.status).toBe("FINDINGS");
    expect(report.issueCounts).toMatchObject({
      MISSING_FILE: 1,
      INVALID_STORAGE_KEY: 1,
      INSPECTION_ERROR: 2,
      ORPHAN_FILESYSTEM_ENTRY: 3,
      DELETED_FILE_RETAINED: 1,
      LEDGER_DRIFT: 1,
      USAGE_EXCEEDS_QUOTA: 1,
      QUOTA_OUT_OF_POLICY: 1,
      UNOWNED_ACTIVE_OBJECT: 1,
      CAPACITY_EMERGENCY: 1,
    });
    expect(report.summary).toMatchObject({
      activeObjects: 2,
      deletedObjects: 1,
      orphanFilesystemBytes: 20,
      retainedDeletedBytes: 2,
      ledgerDriftLearners: 1,
      learnersOverQuota: 1,
      learnersQuotaOutOfPolicy: 1,
      unownedActiveObjects: 1,
      capacity: { usedBasisPoints: 9510, band: "EMERGENCY" },
    });
  });

  it("requires explicit confirmation before apply and validates deterministic identifiers", async () => {
    const repository = fakeRepository([snapshot()]);
    const inspector = { inspect: vi.fn(async () => inspection()) };
    await expect(reconcileStorage({
      repository,
      inspector,
      root: "C:/redacted",
      mode: "apply",
      runId: RUN_ID,
      now: NOW,
    })).rejects.toEqual(expect.objectContaining({ code: "APPLY_CONFIRMATION_REQUIRED" }));
    await expect(reconcileStorage({
      repository,
      inspector,
      root: "C:/redacted",
      runId: "not-a-uuid",
      now: NOW,
    })).rejects.toEqual(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(repository.snapshot).not.toHaveBeenCalled();
  });

  it("applies only fail-closed status and ledger repairs, then verifies remaining drift", async () => {
    const initial = snapshot({ ledgers: [{ userId: SECRET_USER, bytes: 1 }] });
    const final = snapshot({ ledgers: [{ userId: SECRET_USER, bytes: 4 }] });
    const missing = initial.objects[0]!;
    const repository = fakeRepository([initial, final], {
      ledgerAdjustmentsInserted: 1,
      objectsFailedClosed: 1,
      applyConflicts: 0,
    });
    const report = await reconcileStorage({
      repository,
      inspector: { inspect: vi.fn(async () => inspection({
        verifiedActiveObjects: 0,
        objectIssues: [{ code: "MISSING_FILE", object: missing }],
      })) },
      root: "C:/redacted",
      mode: "apply",
      confirmation: STORAGE_RECONCILIATION_APPLY_CONFIRMATION,
      runId: RUN_ID,
      now: NOW,
    });
    expect(report.status).toBe("APPLIED_WITH_FINDINGS");
    expect(report.summary.remainingLedgerDriftLearners).toBe(0);
    expect(report.actions).toMatchObject({
      ledgerAdjustmentsInserted: 1,
      objectsFailedClosed: 1,
      applyConflicts: 0,
      unknownFilesDeleted: 0,
      metadataRewrittenFromDisk: 0,
    });
    expect(repository.apply).toHaveBeenCalledWith(expect.objectContaining({
      driftUserIds: [SECRET_USER],
      objectIssues: [{ code: "MISSING_FILE", object: missing }],
    }));
  });

  it("reports a fully repaired ledger-only run and flags apply conflicts", async () => {
    const initial = snapshot({ ledgers: [] });
    const final = snapshot();
    const applied = await reconcileStorage({
      repository: fakeRepository([initial, final], {
        ledgerAdjustmentsInserted: 1,
        objectsFailedClosed: 0,
        applyConflicts: 0,
      }),
      inspector: { inspect: vi.fn(async () => inspection()) },
      root: "C:/redacted",
      mode: "apply",
      confirmation: STORAGE_RECONCILIATION_APPLY_CONFIRMATION,
      runId: RUN_ID,
      now: NOW,
    });
    expect(applied.status).toBe("APPLIED");

    const conflicted = await reconcileStorage({
      repository: fakeRepository([initial, initial], {
        ledgerAdjustmentsInserted: 0,
        objectsFailedClosed: 0,
        applyConflicts: 1,
      }),
      inspector: { inspect: vi.fn(async () => inspection()) },
      root: "C:/redacted",
      mode: "apply",
      confirmation: STORAGE_RECONCILIATION_APPLY_CONFIRMATION,
      runId: RUN_ID,
      now: NOW,
    });
    expect(conflicted.status).toBe("APPLY_INCOMPLETE");
    expect(conflicted.issueCounts.APPLY_CONFLICT).toBe(1);
  });

  it.each([
    [0, "NORMAL"], [6999, "NORMAL"], [7000, "WARNING"], [8499, "WARNING"],
    [8500, "CRITICAL"], [9499, "CRITICAL"], [9500, "EMERGENCY"], [10000, "EMERGENCY"],
  ])("maps %i basis points to %s", (basisPoints, band) => {
    expect(storageCapacityBand(basisPoints)).toBe(band);
  });

  it.each([-1, 10_001, 1.5, Number.NaN])("rejects invalid capacity basis points %s", (basisPoints) => {
    expect(() => storageCapacityBand(basisPoints)).toThrowError(
      expect.objectContaining({ code: "CAPACITY_UNAVAILABLE" }),
    );
  });

  it("computes exact basis points for multi-terabyte volumes without numeric overflow", async () => {
    const report = await reconcileStorage({
      repository: fakeRepository([snapshot()]),
      inspector: { inspect: vi.fn(async () => inspection({
        capacity: { totalBytes: 2_000_000_000_000, availableBytes: 600_000_000_000 },
      })) },
      root: "C:/redacted",
      runId: RUN_ID,
      now: NOW,
    });
    expect(report.summary.capacity).toMatchObject({
      usedBytes: 1_400_000_000_000,
      usedBasisPoints: 7000,
      band: "WARNING",
    });
  });

  it("projects only aggregate redacted fields for a future admin surface", async () => {
    const report = await reconcileStorage({
      repository: fakeRepository([snapshot()]),
      inspector: { inspect: vi.fn(async () => inspection()) },
      root: "C:/redacted",
      runId: RUN_ID,
      now: NOW,
    });
    const projection = toAdminStorageReconciliationSummary(report);
    expect(projection).toMatchObject({
      status: "HEALTHY",
      objects: { active: 1, verified: 1, integrityFindings: 0 },
      quota: { learners: 1, driftLearners: 0 },
      capacity: { band: "NORMAL" },
    });
    expect(JSON.stringify(projection)).not.toMatch(/learner-secret|storageKey|sha256|filename|path/i);
  });
});

describe("real filesystem storage inspection", () => {
  it("verifies content and reports missing, changed, invalid, deleted-retained, and unknown files without deleting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "learncoding-reconcile-unit-"));
    temporaryRoots.push(root);
    const owner = "a".repeat(64);
    const ids = [1, 2, 3, 4, 5, 6].map((suffix) =>
      "20000000-0000-4000-8000-" + String(suffix).padStart(12, "0"));
    await mkdir(path.join(root, owner), { recursive: true });
    await writeFile(path.join(root, owner, ids[0]!), "good");
    await writeFile(path.join(root, owner, ids[1]!), "bad");
    await writeFile(path.join(root, owner, ids[4]!), "deleted");
    await writeFile(path.join(root, owner, ids[5]!), "orphan");
    const object = (
      index: number,
      options: Partial<StorageObjectSnapshot> = {},
    ): StorageObjectSnapshot => ({
      id: ids[index]!,
      ownerUserId: SECRET_USER,
      storageKey: owner + "/" + ids[index],
      sizeBytes: index === 0 ? 4 : 3,
      sha256: createHash("sha256").update(index === 0 ? "good" : "expected").digest("hex"),
      deletedAt: null,
      ...options,
    });
    const objects = [
      object(0),
      object(1),
      object(2, { sizeBytes: 1 }),
      object(3, { storageKey: "../invalid" }),
      object(4, {
        sizeBytes: 7,
        sha256: createHash("sha256").update("deleted").digest("hex"),
        deletedAt: NOW,
      }),
    ];
    const result = await new NodeStorageReconciliationInspector().inspect(root, objects);
    expect(result.verifiedActiveObjects).toBe(1);
    expect(result.objectIssues.map((issue) => issue.code).sort()).toEqual([
      "INTEGRITY_MISMATCH",
      "INVALID_STORAGE_KEY",
      "MISSING_FILE",
    ]);
    expect(result).toMatchObject({
      orphanEntries: 1,
      orphanBytes: 6,
      retainedDeletedFiles: 1,
      retainedDeletedBytes: 7,
      inspectionErrors: 0,
    });
    await expect(lstatExists(path.join(root, owner, ids[4]!))).resolves.toBe(true);
    await expect(lstatExists(path.join(root, owner, ids[5]!))).resolves.toBe(true);
  });

  it("fails safely when the root is relative or unavailable", async () => {
    const inspector = new NodeStorageReconciliationInspector();
    await expect(inspector.inspect("relative", [])).rejects.toEqual(
      expect.objectContaining({ code: "ROOT_UNAVAILABLE" }),
    );
    await expect(inspector.inspect(path.join(tmpdir(), "definitely-missing-storage-root"), [])).rejects.toEqual(
      expect.objectContaining({ code: "ROOT_UNAVAILABLE" }),
    );
  });
});

async function lstatExists(filePath: string) {
  try {
    await import("node:fs/promises").then(({ lstat }) => lstat(filePath));
    return true;
  } catch {
    return false;
  }
}

it("uses named safe reconciliation errors", () => {
  const error = new StorageReconciliationError("DATABASE_FAILURE");
  expect(error.name).toBe("StorageReconciliationError");
  expect(error.message).toBe("DATABASE_FAILURE");
});
