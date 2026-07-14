import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = { userId: "runtime-auth-learner-a" };
  return {
    state,
    requireAuth: vi.fn(async () => ({
      session: {
        user: {
          id: state.userId,
          name: state.userId.endsWith("-a") ? "Learner A" : "Learner B",
          email: `${state.userId}@integration.invalid`,
        },
        session: { id: `session:${state.userId}`, userId: state.userId, mfaVerifiedAt: new Date() },
      },
      account: { status: "active", role: "learner", twoFactorEnabled: true },
      response: null,
    })),
    withRateLimit: vi.fn(async (_policy: unknown, work: () => Promise<Response>) => work()),
    requireRecentMfa: vi.fn(async () => ({ allowed: true as const })),
  };
});

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/rate-limit")>()),
  withRateLimit: mocks.withRateLimit,
}));
vi.mock("@/lib/security/recent-mfa", () => ({ requireRecentMfa: mocks.requireRecentMfa }));

import { GET as getDraft, PUT as putDraft } from "@/app/api/drafts/route";
import { DELETE as deleteCredential, PATCH as patchCredential } from "@/app/api/credentials/[id]/route";
import { DELETE as deleteFile, GET as getFile } from "@/app/api/files/[id]/route";
import { POST as submitAttempt } from "@/app/api/learning/attempts/[attemptId]/submit/route";
import { POST as revealAttemptHelp } from "@/app/api/learning/attempts/[attemptId]/help/route";
import { GET as listProjects } from "@/app/api/projects/route";
import {
  GET as listProjectRevisions,
  POST as createProjectRevision,
} from "@/app/api/projects/[id]/revisions/route";
import { db, pool } from "@/lib/db/client";
import {
  attempt,
  practiceHelpEvent,
  project,
  projectRevision,
  providerCredential,
  quotaLedger,
  response as learningResponse,
  storedObject,
  user,
} from "@/lib/db/schema";
import { PostgresLearnerDraftRepository } from "@/lib/drafts/repository";

const LEARNER_A = "runtime-auth-learner-a";
const LEARNER_B = "runtime-auth-learner-b";
const PROJECT_A = "a1000000-0000-4000-8000-000000000001";
const PROJECT_B = "a1000000-0000-4000-8000-000000000002";
const FILE_B = "a2000000-0000-4000-8000-000000000001";
const CREDENTIAL_B = "a3000000-0000-4000-8000-000000000001";
const ATTEMPT_B = "a4000000-0000-4000-8000-000000000001";
const DRAFT_REQUEST_A = "a5000000-0000-4000-8000-000000000001";
const DRAFT_REQUEST_B = "a5000000-0000-4000-8000-000000000002";

const draftKey = {
  kind: "code" as const,
  courseId: "python",
  skillId: "free-playground",
  language: "python",
};

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Runtime authorization integration requires the disposable learncoding_integration database.");
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

function asLearner(userId: typeof LEARNER_A | typeof LEARNER_B) {
  mocks.state.userId = userId;
}

function request(url: string, method: string, body?: unknown) {
  return new NextRequest(`https://learn.test${url}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
}

beforeEach(async () => {
  await truncateApplicationTables();
  vi.clearAllMocks();
  asLearner(LEARNER_A);
  await db.insert(user).values([
    {
      id: LEARNER_A,
      publicId: "b1000000-0000-4000-8000-000000000001",
      name: "Runtime Learner A",
      email: "runtime-a@integration.invalid",
      role: "learner",
      status: "active",
    },
    {
      id: LEARNER_B,
      publicId: "b1000000-0000-4000-8000-000000000002",
      name: "Runtime Learner B",
      email: "runtime-b@integration.invalid",
      role: "learner",
      status: "active",
    },
  ]);
  await db.insert(project).values([
    {
      id: PROJECT_A,
      userId: LEARNER_A,
      title: "Learner A private project",
      summary: "A project that must be visible only to learner A.",
      status: "idea",
      visibility: "private",
    },
    {
      id: PROJECT_B,
      userId: LEARNER_B,
      title: "Learner B private project",
      summary: "A project that must be visible only to learner B.",
      status: "idea",
      visibility: "private",
    },
  ]);
  await db.insert(storedObject).values({
    id: FILE_B,
    ownerUserId: LEARNER_B,
    storageKey: `runtime-owner-b/${FILE_B}`,
    originalName: "learner-b-private.txt",
    mediaType: "text/plain",
    sizeBytes: 17,
    sha256: "a".repeat(64),
    retentionClass: "user_upload",
    scanStatus: "safe",
  });
  await db.insert(providerCredential).values({
    id: CREDENTIAL_B,
    userId: LEARNER_B,
    provider: "nvidia_nim",
    label: "Learner B NIM",
    ciphertext: "opaque-ciphertext",
    wrappedDataKey: "opaque-wrapped-key",
    wrapIv: "opaque-wrap-iv",
    dataIv: "opaque-data-iv",
    authTag: "opaque-auth-tag",
    lastFour: "B123",
    status: "active",
  });
  await pool.query(
    `insert into course (id,slug,title,summary,domain)
       values ('b2000000-0000-4000-8000-000000000001','runtime-auth','Runtime Auth','Authorization fixture.','programming')`,
  );
  await pool.query(
    `insert into course_version (id,course_id,version,stage,scope_statement,content_hash,published_at)
       values ('b2000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','1.0.0','beta','Authorization fixture.',$1,now())`,
    ["b".repeat(64)],
  );
  await pool.query(
    `insert into course_module (id,course_version_id,slug,title,objective,position,estimated_minutes)
       values ('b2000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000002','owner','Owner','Enforce ownership.',1,10)`,
  );
  await pool.query(
    `insert into concept (id,slug,title,domain,description)
       values ('b2000000-0000-4000-8000-000000000004','runtime-auth.owner','Owner binding','programming','Owner binding fixture.')`,
  );
  await pool.query(
    `insert into lesson (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status)
       values ('b2000000-0000-4000-8000-000000000005','b2000000-0000-4000-8000-000000000003','owner','Owner','Enforce ownership.',10,'beginner',1,'beta')`,
  );
  await pool.query(
    `insert into activity (id,lesson_id,concept_id,slug,type,instructions,specification,difficulty,max_points)
       values ('b2000000-0000-4000-8000-000000000006','b2000000-0000-4000-8000-000000000005','b2000000-0000-4000-8000-000000000004','owner-check','mcq','Choose the owner.','{"itemKey":"runtime-owner-item"}'::jsonb,'beginner',100)`,
  );
  await pool.query(
    `insert into enrollment (id,user_id,course_version_id,status,source,started_at)
       values ('b2000000-0000-4000-8000-000000000007',$1,'b2000000-0000-4000-8000-000000000002','active','test',now())`,
    [LEARNER_B],
  );
  await pool.query(
    `insert into attempt (id,user_id,activity_id,enrollment_id,kind,status,policy_version,content_version,started_at)
       values ($1,$2,'b2000000-0000-4000-8000-000000000006','b2000000-0000-4000-8000-000000000007','practice','in_progress','learning-policy-v1','1.0.0',now())`,
    [ATTEMPT_B, LEARNER_B],
  );
  const drafts = new PostgresLearnerDraftRepository();
  await drafts.save({
    userId: LEARNER_A,
    ...draftKey,
    content: "owner = 'learner-a'\n",
    expectedRowVersion: 0,
    requestId: DRAFT_REQUEST_A,
  });
  await drafts.save({
    userId: LEARNER_B,
    ...draftKey,
    content: "owner = 'learner-b private'\n",
    expectedRowVersion: 0,
    requestId: DRAFT_REQUEST_B,
  });
});

afterAll(async () => {
  await pool.end();
});

describe("behavioral route authorization with two real owners", () => {
  it("returns only the authenticated learner's draft and rejects a cross-owner idempotency receipt", async () => {
    const loaded = await getDraft(request(
      "/api/drafts?kind=code&courseId=python&skillId=free-playground&language=python",
      "GET",
    ));
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toMatchObject({
      draft: { content: "owner = 'learner-a'\n" },
    });

    const collision = await putDraft(request("/api/drafts", "PUT", {
      ...draftKey,
      content: "try to overwrite learner b",
      expectedRowVersion: 1,
      requestId: DRAFT_REQUEST_B,
    }));
    expect(collision.status).toBe(409);
    const repository = new PostgresLearnerDraftRepository();
    await expect(repository.load(LEARNER_B, draftKey)).resolves.toMatchObject({
      content: "owner = 'learner-b private'\n",
      rowVersion: 1,
    });
  });

  it("returns 404 for another learner's file and cannot soft-delete it or release their quota", async () => {
    const context = { params: Promise.resolve({ id: FILE_B }) };
    expect((await getFile(request(`/api/files/${FILE_B}`, "GET"), context)).status).toBe(404);
    expect((await deleteFile(request(`/api/files/${FILE_B}`, "DELETE"), context)).status).toBe(404);
    const [persisted] = await db.select().from(storedObject).where(eq(storedObject.id, FILE_B));
    expect(persisted).toMatchObject({ ownerUserId: LEARNER_B, deletedAt: null, scanStatus: "safe" });
    expect(await db.select().from(quotaLedger)).toHaveLength(0);
  });

  it("lists only owned projects and rejects cross-owner revision reads and writes", async () => {
    const listed = await listProjects();
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { projects: Array<{ id: string; title: string }> };
    expect(listBody.projects).toEqual([
      expect.objectContaining({ id: PROJECT_A, title: "Learner A private project" }),
    ]);
    expect(JSON.stringify(listBody)).not.toContain("Learner B private project");

    const context = { params: Promise.resolve({ id: PROJECT_B }) };
    const crossRead = await listProjectRevisions(
      request(`/api/projects/${PROJECT_B}/revisions`, "GET"),
      context,
    );
    expect(crossRead.status).toBe(404);
    const crossWrite = await createProjectRevision(
      request(`/api/projects/${PROJECT_B}/revisions`, "POST", {
        clientRequestId: "a6000000-0000-4000-8000-000000000001",
        expectedLatestRevision: 0,
        changeSummary: "Attempt to add evidence to another learner project.",
        reflection: null,
        fileIds: [],
      }),
      context,
    );
    expect(crossWrite.status).toBe(404);
    expect(await db.select().from(projectRevision)).toHaveLength(0);
  });

  it("returns 404 for another learner's credential and cannot disable or delete it", async () => {
    const context = { params: Promise.resolve({ id: CREDENTIAL_B }) };
    const disabled = await patchCredential(
      request(`/api/credentials/${CREDENTIAL_B}`, "PATCH", { action: "disable" }),
      context,
    );
    expect(disabled.status).toBe(404);
    const removed = await deleteCredential(
      request(`/api/credentials/${CREDENTIAL_B}`, "DELETE"),
      context,
    );
    expect(removed.status).toBe(404);
    const [persisted] = await db.select().from(providerCredential).where(eq(providerCredential.id, CREDENTIAL_B));
    expect(persisted).toMatchObject({ userId: LEARNER_B, status: "active" });
  });

  it("returns 404 for another learner's attempt and records neither answer nor help evidence", async () => {
    const context = { params: Promise.resolve({ attemptId: ATTEMPT_B }) };
    const submitted = await submitAttempt(
      request(`/api/learning/attempts/${ATTEMPT_B}/submit`, "POST", {
        itemKey: "runtime-owner-item",
        responseRevision: 1,
        answer: { selected: "A" },
        assistanceLevel: "A0",
        solutionRevealed: false,
      }),
      context,
    );
    expect(submitted.status).toBe(404);
    const helped = await revealAttemptHelp(
      request(`/api/learning/attempts/${ATTEMPT_B}/help`, "POST", {
        requestId: "a7000000-0000-4000-8000-000000000001",
      }),
      context,
    );
    expect(helped.status).toBe(404);
    expect(await db.select().from(learningResponse)).toHaveLength(0);
    expect(await db.select().from(practiceHelpEvent)).toHaveLength(0);
    const [persisted] = await db.select().from(attempt).where(eq(attempt.id, ATTEMPT_B));
    expect(persisted).toMatchObject({ userId: LEARNER_B, status: "in_progress", helpStep: 0 });
  });
});
