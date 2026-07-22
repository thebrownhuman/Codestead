import path from "node:path";
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import { backgroundJob, dataLifecycleRun, quotaLedger, storedObject, user } from "@/lib/db/schema";
import {
  enqueueFileErasures,
  fileErasureSummary,
  processFileErasures,
  purgeCompletedFileErasureJobs,
} from "@/lib/data-lifecycle/file-erasure";
import { resolveStoredObjectPath } from "@/lib/storage/upload-scanner";
import { ownerStorageSegment } from "@/lib/storage/upload-service";

const USER_ID = "file-erasure-integration-user";
const PUBLIC_ID = "e1000000-0000-4000-8000-000000000001";
const OWNER = ownerStorageSegment(USER_ID);
const RUN_ID = "e2000000-0000-4000-8000-000000000001";
const RUN_ID_2 = "e2000000-0000-4000-8000-000000000002";
const OBJECT_1 = "e3000000-0000-4000-8000-000000000001";
const OBJECT_2 = "e3000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-14T00:00:00.000Z");

let root = "";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("File-erasure integration requires the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`truncate table ${names} restart identity cascade`);
}

async function seedRun(runId: string) {
  await db.insert(dataLifecycleRun).values({
    id: runId,
    operation: "retention",
    policyVersion: "2026-07-12.v3",
    idempotencyKey: `file-erasure-integration:${runId}`,
    status: "running",
    report: { phase: "file_erasure_pending" },
    startedAt: NOW,
  });
}

async function seedObject(objectId: string, body: string) {
  const storageKey = `${OWNER}/${objectId}`;
  await db.insert(storedObject).values({
    id: objectId,
    ownerUserId: USER_ID,
    storageKey,
    originalName: "removed-before-pilot.txt",
    mediaType: "text/plain",
    sizeBytes: Buffer.byteLength(body),
    sha256: "a".repeat(64),
    scanStatus: "safe",
    retentionClass: "temporary",
  });
  await db.insert(quotaLedger).values({
    userId: USER_ID,
    objectId,
    operation: "reserve_and_finalize",
    bytes: Buffer.byteLength(body),
    idempotencyKey: `file-erasure-ledger:${objectId}`,
  });
  const filePath = path.join(root, OWNER, objectId);
  await writeFile(filePath, body, "utf8");
  return { storageKey, filePath };
}

function processIntegrationFileErasures(
  input: Parameters<typeof processFileErasures>[0],
) {
  return processFileErasures({
    ...input,
    preparePath: async (objectRoot, storageKey) => resolveStoredObjectPath(objectRoot, storageKey),
    unlinkFile: unlink,
    // This cross-platform suite proves the real queue/processor/DB transitions.
    // Linux procfd identity checks and directory fsync are exercised separately.
    syncParentDirectory: async (objectRoot, storageKey) => {
      await access(path.dirname(resolveStoredObjectPath(objectRoot, storageKey)));
    },
  });
}

beforeEach(async () => {
  await truncateApplicationTables();
  root = await mkdtemp(path.join(tmpdir(), "learncoding-file-erasure-it-"));
  expect(OWNER).toMatch(/^[0-9a-f]{64}$/);
  await mkdir(path.join(root, OWNER), { recursive: true });
  await db.insert(user).values({
    id: USER_ID,
    publicId: PUBLIC_ID,
    name: "File Erasure Learner",
    email: "file-erasure@integration.invalid",
    role: "learner",
    status: "active",
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await pool.end();
});

describe("durable PostgreSQL file-erasure queue", () => {
  it("commits metadata removal before unlink and never exposes completion before the durable terminal state", async () => {
    await seedRun(RUN_ID);
    const object = await seedObject(OBJECT_1, "delete after commit");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await enqueueFileErasures(client, {
        lifecycleRunId: RUN_ID,
        operation: "retention",
        objects: [{ id: OBJECT_1, storageKey: object.storageKey }],
        now: NOW,
      });
      await client.query("delete from quota_ledger where object_id = $1", [OBJECT_1]);
      await client.query("delete from stored_object where id = $1", [OBJECT_1]);
      await client.query("commit");
    } finally {
      client.release();
    }

    expect(await db.select().from(storedObject).where(eq(storedObject.id, OBJECT_1))).toHaveLength(0);
    await expect(access(object.filePath)).resolves.toBeUndefined();
    await expect(fileErasureSummary(pool as never, RUN_ID)).resolves.toMatchObject({
      total: 1,
      pending: 1,
      complete: false,
    });
    const runBeforeWorker = await db.select().from(dataLifecycleRun).where(eq(dataLifecycleRun.id, RUN_ID));
    expect(runBeforeWorker[0]).toMatchObject({ status: "running", completedAt: null });

    const finished = await processIntegrationFileErasures({
      lifecycleRunId: RUN_ID, objectStorageRoot: root,
    });
    expect(finished).toMatchObject({ removed: 1, alreadyAbsent: 0, complete: true });
    await expect(access(object.filePath)).rejects.toMatchObject({ code: "ENOENT" });

    const cleanup = await pool.connect();
    try {
      await cleanup.query("begin");
      await expect(purgeCompletedFileErasureJobs(cleanup, RUN_ID)).resolves.toBe(1);
      await cleanup.query("commit");
    } finally {
      cleanup.release();
    }
    expect(await db.select().from(backgroundJob)).toHaveLength(0);
  });

  it("serializes concurrent drainers and reclaims an expired crash lease without a duplicate unlink", async () => {
    await seedRun(RUN_ID_2);
    const first = await seedObject(OBJECT_1, "first");
    const second = await seedObject(OBJECT_2, "second");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await enqueueFileErasures(client, {
        lifecycleRunId: RUN_ID_2,
        operation: "retention",
        objects: [
          { id: OBJECT_1, storageKey: first.storageKey },
          { id: OBJECT_2, storageKey: second.storageKey },
        ],
        now: NOW,
      });
      await client.query(
        `update background_job
            set status = 'leased', lease_owner = 'crashed-worker',
                lease_expires_at = $2
          where payload ->> 'objectId' = $1`,
        [OBJECT_1, new Date("2026-07-13T00:00:00.000Z")],
      );
      await client.query("delete from quota_ledger where object_id = any($1::uuid[])", [[OBJECT_1, OBJECT_2]]);
      await client.query("delete from stored_object where id = any($1::uuid[])", [[OBJECT_1, OBJECT_2]]);
      await client.query("commit");
    } finally {
      client.release();
    }

    const [drainerA, drainerB] = await Promise.all([
      processIntegrationFileErasures({
        lifecycleRunId: RUN_ID_2, objectStorageRoot: root,
      }),
      processIntegrationFileErasures({
        lifecycleRunId: RUN_ID_2, objectStorageRoot: root,
      }),
    ]);
    expect(drainerA).toMatchObject({ total: 2, removed: 2, complete: true });
    expect(drainerB).toMatchObject({ total: 2, removed: 2, complete: true });
    await expect(access(first.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(second.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    const jobs = await db.select().from(backgroundJob);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.attemptCount).sort()).toEqual([1, 1]);
    expect(jobs.every((job) => job.status === "succeeded")).toBe(true);
  });
});
