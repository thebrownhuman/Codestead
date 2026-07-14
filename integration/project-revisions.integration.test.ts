import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import {
  project,
  projectRevision,
  projectRevisionObject,
  quotaLedger,
  storedObject,
  user,
} from "@/lib/db/schema";
import {
  createProjectRevision,
  getProjectRevision,
  listProjectRevisions,
  ProjectRevisionError,
} from "@/lib/projects/revision-service";

const OWNER_ID = "project-revision-owner";
const OTHER_ID = "project-revision-other";
const PROJECT_ID = "15000000-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "15000000-0000-4000-8000-000000000002";
const SAFE_FILE_ID = "15000000-0000-4000-8000-000000000003";
const PENDING_FILE_ID = "15000000-0000-4000-8000-000000000004";
const FOREIGN_FILE_ID = "15000000-0000-4000-8000-000000000005";
const REQUEST_ID = "15000000-0000-4000-8000-000000000006";
const NOW = new Date("2026-07-12T12:00:00.000Z");

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Project revision integration tests require the disposable learncoding_integration database.");
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

async function seed() {
  await db.insert(user).values([
    { id: OWNER_ID, publicId: "15100000-0000-4000-8000-000000000001", name: "Revision Owner", email: "revision-owner@integration.invalid", role: "learner", status: "active" },
    { id: OTHER_ID, publicId: "15100000-0000-4000-8000-000000000002", name: "Other Learner", email: "revision-other@integration.invalid", role: "learner", status: "active" },
  ]);
  await db.insert(project).values([
    { id: PROJECT_ID, userId: OWNER_ID, title: "Owned project", summary: "An independently built project with durable checkpoints." },
    { id: OTHER_PROJECT_ID, userId: OTHER_ID, title: "Foreign project", summary: "A project that the first learner must never read." },
  ]);
  await db.insert(storedObject).values([
    {
      id: SAFE_FILE_ID,
      ownerUserId: OWNER_ID,
      storageKey: "owner/safe-file",
      originalName: "main.py",
      mediaType: "text/x-python",
      sizeBytes: 321,
      sha256: "a".repeat(64),
      retentionClass: "user_upload",
      scanStatus: "safe",
    },
    {
      id: PENDING_FILE_ID,
      ownerUserId: OWNER_ID,
      storageKey: "owner/pending-file",
      originalName: "pending.py",
      mediaType: "text/x-python",
      sizeBytes: 122,
      sha256: "b".repeat(64),
      retentionClass: "user_upload",
      scanStatus: "pending",
    },
    {
      id: FOREIGN_FILE_ID,
      ownerUserId: OTHER_ID,
      storageKey: "other/foreign-file",
      originalName: "foreign.py",
      mediaType: "text/x-python",
      sizeBytes: 999,
      sha256: "c".repeat(64),
      retentionClass: "user_upload",
      scanStatus: "safe",
    },
  ]);
  await db.insert(quotaLedger).values({
    userId: OWNER_ID,
    objectId: SAFE_FILE_ID,
    operation: "reserve",
    bytes: 321,
    idempotencyKey: "project-revision-upload-reserve",
  });
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL learner project revisions", () => {
  it("creates an immutable snapshot, replays exactly, and never duplicates quota", async () => {
    await pool.query(
      `insert into learning_session
        (id,user_id,goal,planned_minutes,status,started_at,last_activity_at,row_version)
       values ('15000000-0000-4000-8000-000000000020',$1,'Build an independent checkpoint.',30,'active',$2,$2,1)`,
      [OWNER_ID, new Date("2026-07-10T00:00:00.000Z")],
    );
    await pool.query(
      `insert into inactivity_episode
        (id,user_id,last_activity_at,eligible_at,second_eligible_at,opened_at)
       values ('15000000-0000-4000-8000-000000000021',$1,$2,$3,$4,$3)`,
      [OWNER_ID, new Date("2026-07-10T00:00:00.000Z"), new Date("2026-07-11T00:00:00.000Z"), new Date("2026-07-13T00:00:00.000Z")],
    );
    const first = await createProjectRevision({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: REQUEST_ID,
      expectedLatestRevision: 0,
      changeSummary: "Added deterministic input validation and boundary tests.",
      reflection: "I learned to make failure behavior part of the design.",
      fileIds: [SAFE_FILE_ID],
      now: NOW,
    });
    expect(first).toMatchObject({ duplicate: false, revision: { projectId: PROJECT_ID, sequence: 1 } });
    expect(first.revision.files).toEqual([expect.objectContaining({
      objectId: SAFE_FILE_ID,
      originalName: "main.py",
      sizeBytes: 321,
      sha256: "a".repeat(64),
      available: true,
      downloadUrl: `/api/files/${SAFE_FILE_ID}`,
    })]);
    expect(await db.select().from(projectRevision)).toHaveLength(1);
    expect(await db.select().from(projectRevisionObject)).toHaveLength(1);
    expect(await db.select().from(quotaLedger)).toHaveLength(1);
    const meaningful = await pool.query<{
      last_meaningful_activity_at: Date;
      event_count: string;
      event_type: string;
      closed_at: Date;
      session_last_activity_at: Date;
      session_row_version: string;
    }>(
      `select u.last_meaningful_activity_at,
              (select count(*)::text from learning_session_event where user_id = $1) event_count,
              (select type from learning_session_event where user_id = $1 limit 1) event_type,
              ie.closed_at,
              ls.last_activity_at session_last_activity_at,
              ls.row_version::text session_row_version
         from "user" u
         join inactivity_episode ie on ie.user_id = u.id
         join learning_session ls on ls.user_id = u.id
        where u.id = $1`,
      [OWNER_ID],
    );
    expect(meaningful.rows[0]).toMatchObject({
      event_count: "1",
      event_type: "project_milestone",
      session_row_version: "2",
    });
    expect(meaningful.rows[0]?.last_meaningful_activity_at.toISOString()).toBe(NOW.toISOString());
    expect(meaningful.rows[0]?.closed_at.toISOString()).toBe(NOW.toISOString());
    expect(meaningful.rows[0]?.session_last_activity_at.toISOString()).toBe(NOW.toISOString());
    const isolatedSideEffects = await pool.query<{
      reviews: string;
      model_calls: string;
      runner_jobs: string;
    }>(`select
      (select count(*)::text from project_review) as reviews,
      (select count(*)::text from model_call) as model_calls,
      (select count(*)::text from runner_job) as runner_jobs`);
    expect(isolatedSideEffects.rows[0]).toEqual({ reviews: "0", model_calls: "0", runner_jobs: "0" });
    await expect(pool.query(
      "update project_revision set change_summary = $2 where id = $1",
      [first.revision.id, "A database rewrite must be rejected."],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(
      "update project_revision_object set original_name = $2 where revision_id = $1",
      [first.revision.id, "rewritten.py"],
    )).rejects.toMatchObject({ code: "55000" });

    const replay = await createProjectRevision({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: REQUEST_ID,
      expectedLatestRevision: 0,
      changeSummary: "  Added deterministic input validation and boundary tests.  ",
      reflection: "I learned to make failure behavior part of the design.",
      fileIds: [SAFE_FILE_ID],
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(replay).toMatchObject({ duplicate: true, revision: { id: first.revision.id, sequence: 1 } });
    expect(await db.select().from(projectRevision)).toHaveLength(1);
    expect(await db.select().from(projectRevisionObject)).toHaveLength(1);
    expect(await db.select().from(quotaLedger)).toHaveLength(1);
    expect((await pool.query<{ count: string }>(
      `select count(*)::text as count from learning_session_event where user_id = $1`,
      [OWNER_ID],
    )).rows[0]?.count).toBe("1");
    expect((await pool.query<{ last_meaningful_activity_at: Date }>(
      `select last_meaningful_activity_at from "user" where id = $1`,
      [OWNER_ID],
    )).rows[0]?.last_meaningful_activity_at.toISOString()).toBe(NOW.toISOString());

    await expect(createProjectRevision({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: REQUEST_ID,
      expectedLatestRevision: 0,
      changeSummary: "Changed content must not reuse the committed request id.",
      fileIds: [SAFE_FILE_ID],
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("fails closed for foreign projects and files that are foreign or not safety-approved", async () => {
    await expect(listProjectRevisions({ userId: OWNER_ID, projectId: OTHER_PROJECT_ID }))
      .rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(createProjectRevision({
      userId: OWNER_ID,
      projectId: OTHER_PROJECT_ID,
      clientRequestId: "15000000-0000-4000-8000-000000000007",
      expectedLatestRevision: 0,
      changeSummary: "This checkpoint must not enter a project owned by somebody else.",
      fileIds: [],
    })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    for (const [requestId, fileId] of [
      ["15000000-0000-4000-8000-000000000008", PENDING_FILE_ID],
      ["15000000-0000-4000-8000-000000000009", FOREIGN_FILE_ID],
    ] as const) {
      await expect(createProjectRevision({
        userId: OWNER_ID,
        projectId: PROJECT_ID,
        clientRequestId: requestId,
        expectedLatestRevision: 0,
        changeSummary: "Unavailable file metadata must not be linked to this revision.",
        fileIds: [fileId],
      })).rejects.toMatchObject({ code: "FILE_NOT_AVAILABLE" });
    }
    expect(await db.select().from(projectRevision)).toHaveLength(0);
  });

  it("serializes competing writers and reports the new authoritative sequence", async () => {
    const attempts = await Promise.allSettled([
      createProjectRevision({
        userId: OWNER_ID,
        projectId: PROJECT_ID,
        clientRequestId: "15000000-0000-4000-8000-000000000010",
        expectedLatestRevision: 0,
        changeSummary: "First concurrent checkpoint with independent learner evidence.",
        fileIds: [],
      }),
      createProjectRevision({
        userId: OWNER_ID,
        projectId: PROJECT_ID,
        clientRequestId: "15000000-0000-4000-8000-000000000011",
        expectedLatestRevision: 0,
        changeSummary: "Second concurrent checkpoint with different learner evidence.",
        fileIds: [],
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const failure = attempts.find((attempt) => attempt.status === "rejected");
    expect(failure).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "VERSION_CONFLICT", currentLatestRevision: 1 }),
    });
    expect(await db.select().from(projectRevision)).toHaveLength(1);
  });

  it("paginates history, preserves snapshots after file erasure, and cascades with the project", async () => {
    const first = await createProjectRevision({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: REQUEST_ID,
      expectedLatestRevision: 0,
      changeSummary: "Captured a safety-approved source file as revision evidence.",
      fileIds: [SAFE_FILE_ID],
    });
    const second = await createProjectRevision({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: "15000000-0000-4000-8000-000000000012",
      expectedLatestRevision: 1,
      changeSummary: "Recorded the next checkpoint without copying file bytes.",
      fileIds: [],
    });
    const pageOne = await listProjectRevisions({ userId: OWNER_ID, projectId: PROJECT_ID, limit: 1 });
    expect(pageOne).toMatchObject({ latestSequence: 2, nextBeforeSequence: 2 });
    expect(pageOne.revisions.map((revision) => revision.id)).toEqual([second.revision.id]);
    const pageTwo = await listProjectRevisions({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      limit: 1,
      beforeSequence: pageOne.nextBeforeSequence!,
    });
    expect(pageTwo.revisions.map((revision) => revision.id)).toEqual([first.revision.id]);

    await db.delete(quotaLedger).where(eq(quotaLedger.objectId, SAFE_FILE_ID));
    await db.delete(storedObject).where(eq(storedObject.id, SAFE_FILE_ID));
    const afterErasure = await getProjectRevision({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      revisionId: first.revision.id,
    });
    expect(afterErasure.files).toEqual([expect.objectContaining({
      objectId: null,
      originalName: "main.py",
      sha256: "a".repeat(64),
      available: false,
      downloadUrl: null,
    })]);

    await db.delete(project).where(and(eq(project.id, PROJECT_ID), eq(project.userId, OWNER_ID)));
    expect(await db.select().from(projectRevision)).toHaveLength(0);
    expect(await db.select().from(projectRevisionObject)).toHaveLength(0);
    await expect(getProjectRevision({
      userId: OWNER_ID,
      projectId: PROJECT_ID,
      revisionId: first.revision.id,
    })).rejects.toBeInstanceOf(ProjectRevisionError);
  });
});
