import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import {
  learnerProfile,
  notification,
  storageQuotaChange,
  storedObject,
  user,
} from "@/lib/db/schema";
import {
  changeLearnerStorageQuota,
  getLearnerStorageQuota,
  StorageQuotaAdminError,
} from "@/lib/storage/admin-quota";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_STORAGE_QUOTA_BYTES,
} from "@/lib/storage/policy";

const LEARNER_ID = "quota-integration-learner";
const LEARNER_PUBLIC_ID = "b1000000-0000-4000-8000-000000000001";
const ADMIN_ID = "quota-integration-admin";
const ADMIN_PUBLIC_ID = "b1000000-0000-4000-8000-000000000003";
const OTHER_ID = "quota-integration-other";
const OTHER_PUBLIC_ID = "b1000000-0000-4000-8000-000000000002";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Storage quota integration tests require the disposable learncoding_integration database.");
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

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values([
    {
      id: LEARNER_ID,
      publicId: LEARNER_PUBLIC_ID,
      name: "Quota Learner",
      email: "quota-learner@integration.invalid",
      role: "learner",
      status: "active",
    },
    {
      id: OTHER_ID,
      publicId: OTHER_PUBLIC_ID,
      name: "Other Learner",
      email: "quota-other@integration.invalid",
      role: "learner",
      status: "active",
    },
    {
      id: ADMIN_ID,
      publicId: ADMIN_PUBLIC_ID,
      name: "Quota Administrator",
      email: "quota-admin@integration.invalid",
      role: "admin",
      status: "active",
    },
  ]);
  await db.insert(learnerProfile).values({
    userId: LEARNER_ID,
    storageQuotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
    rowVersion: 1,
  });
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL learner quota controls", () => {
  it("serializes concurrent administrator changes and preserves one current revision", async () => {
    const concurrent = await Promise.allSettled([
      changeLearnerStorageQuota({
        learnerPublicId: LEARNER_PUBLIC_ID,
        requestedBytes: MAX_STORAGE_QUOTA_BYTES,
        expectedRowVersion: 1,
        requestId: "b2000000-0000-4000-8000-000000000001",
        actorUserId: ADMIN_ID,
        reason: "Approve extra space for the learner's current coursework.",
      }),
      changeLearnerStorageQuota({
        learnerPublicId: LEARNER_PUBLIC_ID,
        requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES + 256 * 1024 ** 2,
        expectedRowVersion: 1,
        requestId: "b2000000-0000-4000-8000-000000000002",
        actorUserId: ADMIN_ID,
        reason: "Approve a smaller temporary increase for current coursework.",
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StorageQuotaAdminError);
    expect(rejected.reason).toMatchObject({ code: "VERSION_CONFLICT" });

    const current = await getLearnerStorageQuota(LEARNER_PUBLIC_ID);
    expect(current.rowVersion).toBe(2);
    expect([
      MAX_STORAGE_QUOTA_BYTES,
      DEFAULT_STORAGE_QUOTA_BYTES + 256 * 1024 ** 2,
    ]).toContain(current.quotaBytes);
    const notices = await db.select().from(notification);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ userId: LEARNER_ID, type: "storage-quota-changed" });
  });

  it("locks against real usage and refuses a destructive reduction", async () => {
    const usedBytes = DEFAULT_STORAGE_QUOTA_BYTES + 1;
    await db.insert(storedObject).values({
      id: "b3000000-0000-4000-8000-000000000001",
      ownerUserId: LEARNER_ID,
      storageKey: "quota-integration/object",
      originalName: "large-fixture.txt",
      mediaType: "text/plain",
      sizeBytes: usedBytes,
      sha256: "a".repeat(64),
      scanStatus: "safe",
    });
    await expect(changeLearnerStorageQuota({
      learnerPublicId: LEARNER_PUBLIC_ID,
      requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      expectedRowVersion: 1,
      requestId: "b2000000-0000-4000-8000-000000000003",
      actorUserId: ADMIN_ID,
      reason: "Reduce the quota after checking the learner's durable usage.",
    })).rejects.toMatchObject({ code: "QUOTA_BELOW_USAGE" });
    const current = await getLearnerStorageQuota(LEARNER_PUBLIC_ID);
    expect(current).toMatchObject({ usedBytes, quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES, rowVersion: 1 });
    expect(await db.select().from(notification)).toHaveLength(0);
  });

  it("creates a versioned default profile for a valid learner who has not onboarded", async () => {
    const changed = await changeLearnerStorageQuota({
      learnerPublicId: OTHER_PUBLIC_ID,
      requestedBytes: MAX_STORAGE_QUOTA_BYTES,
      expectedRowVersion: 0,
      requestId: "b2000000-0000-4000-8000-000000000004",
      actorUserId: ADMIN_ID,
      reason: "Create the initial quota profile for this approved learner.",
    });
    expect(changed).toMatchObject({
      learnerUserId: OTHER_ID,
      quotaBytes: MAX_STORAGE_QUOTA_BYTES,
      rowVersion: 1,
      usedBytes: 0,
    });
    await expect(changeLearnerStorageQuota({
      learnerPublicId: "b1000000-0000-4000-8000-000000000099",
      requestedBytes: MAX_STORAGE_QUOTA_BYTES,
      expectedRowVersion: 0,
      requestId: "b2000000-0000-4000-8000-000000000005",
      actorUserId: ADMIN_ID,
      reason: "Attempt a quota change for a learner identity that is absent.",
    })).rejects.toMatchObject({ code: "LEARNER_NOT_FOUND" });
  });

  it("durably replays one exact request and rejects changed payload reuse", async () => {
    const input = {
      learnerPublicId: LEARNER_PUBLIC_ID,
      requestedBytes: MAX_STORAGE_QUOTA_BYTES,
      expectedRowVersion: 1,
      requestId: "b2000000-0000-4000-8000-000000000006",
      actorUserId: ADMIN_ID,
      reason: "Approve extra project storage after reviewing current usage.",
    } as const;
    await expect(changeLearnerStorageQuota(input)).resolves.toMatchObject({
      quotaBytes: MAX_STORAGE_QUOTA_BYTES,
      rowVersion: 2,
      replayed: false,
    });
    await expect(changeLearnerStorageQuota(input)).resolves.toMatchObject({
      quotaBytes: MAX_STORAGE_QUOTA_BYTES,
      rowVersion: 2,
      replayed: true,
    });
    await expect(changeLearnerStorageQuota({
      ...input,
      requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES + 256 * 1024 ** 2,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    expect(await db.select().from(storageQuotaChange)).toHaveLength(1);
    expect(await db.select().from(notification)).toHaveLength(1);
    await expect(getLearnerStorageQuota(LEARNER_PUBLIC_ID)).resolves.toMatchObject({
      quotaBytes: MAX_STORAGE_QUOTA_BYTES,
      rowVersion: 2,
    });
  });

  it("enforces the one-administrator product invariant in PostgreSQL", async () => {
    await expect(pool.query(
      `insert into "user" (id, name, email, role, status, public_id)
       values ($1, $2, $3, 'admin', 'active', $4)`,
      [
        "quota-integration-second-admin",
        "Second Administrator",
        "quota-admin-2@integration.invalid",
        "b1000000-0000-4000-8000-000000000004",
      ],
    )).rejects.toMatchObject({
      code: "23505",
      constraint: "user_single_admin_unique",
    });
  });
});
