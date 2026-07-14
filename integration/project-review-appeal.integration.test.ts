import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  decideAppeal,
  getAdminAppealDetail,
  listAdminAppeals,
} from "@/lib/appeals/admin-service";
import { hashAppealEvidence } from "@/lib/appeals/evidence";
import {
  ProjectReviewAppealError,
  submitProjectReviewAppeal,
} from "@/lib/appeals/project-review-service";
import { db, pool } from "@/lib/db/client";
import {
  appeal,
  appealEvent,
  notification,
  project,
  projectReview,
  user,
} from "@/lib/db/schema";

const ADMIN_ID = "project-appeal-admin";
const LEARNER_ID = "project-appeal-learner";
const OTHER_ID = "project-appeal-other";
const PROJECT_ID = "91000000-0000-4000-8000-000000000001";
const REVIEW_ID = "91000000-0000-4000-8000-000000000002";
const PENDING_REVIEW_ID = "91000000-0000-4000-8000-000000000003";
const REQUEST_ID = "92000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-07-12T10:00:00.000Z");
const REASON = "The high-severity secret finding points to an intentional test fixture.";
const FINDINGS = [{
  rule: "secret-scan",
  severity: "high",
  file: "src/fixtures/provider.ts",
  line: 8,
  message: "A token-shaped test fixture was detected.",
}];

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Project-review appeal integration tests require the disposable learncoding_integration database.");
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

async function seedProjectReview() {
  await db.insert(user).values([
    { id: ADMIN_ID, publicId: "90000000-0000-4000-8000-000000000001", name: "Appeal Admin", email: "appeal-admin@integration.invalid", role: "admin", status: "active" },
    { id: LEARNER_ID, publicId: "90000000-0000-4000-8000-000000000002", name: "Appeal Learner", email: "appeal-learner@integration.invalid", role: "learner", status: "active" },
    { id: OTHER_ID, publicId: "90000000-0000-4000-8000-000000000003", name: "Other Learner", email: "other-appeal@integration.invalid", role: "learner", status: "active" },
  ]);
  await db.insert(project).values({
    id: PROJECT_ID,
    userId: LEARNER_ID,
    title: "Portfolio API",
    summary: "A small tested API submitted for immutable repository review.",
    status: "reviewed",
    githubUrl: "https://github.com/example/portfolio-api",
    githubCommitSha: "abc123immutable",
  });
  await db.insert(projectReview).values([
    {
      id: REVIEW_ID,
      projectId: PROJECT_ID,
      commitSha: "abc123immutable",
      analyzerVersion: "static-review-v1",
      findings: FINDINGS,
      status: "complete",
      createdAt: new Date("2026-07-12T09:00:00.000Z"),
    },
    {
      id: PENDING_REVIEW_ID,
      projectId: PROJECT_ID,
      commitSha: "pending456",
      analyzerVersion: "static-review-v1",
      findings: [],
      status: "pending",
      createdAt: new Date("2026-07-12T09:30:00.000Z"),
    },
  ]);
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seedProjectReview();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL project-review appeals", () => {
  it("binds ownership, snapshots evidence, replays once, reaches the admin queue, and never rewrites the review", async () => {
    const originalReview = (await db.select().from(projectReview).where(eq(projectReview.id, REVIEW_ID)))[0];
    const created = await submitProjectReviewAppeal({
      userId: LEARNER_ID,
      projectId: PROJECT_ID,
      projectReviewId: REVIEW_ID,
      clientRequestId: REQUEST_ID,
      category: "project_finding",
      reason: REASON,
      now: NOW,
    });
    expect(created).toMatchObject({ accepted: true, duplicate: false });

    const storedAppeals = await db.select().from(appeal);
    expect(storedAppeals).toHaveLength(1);
    expect(storedAppeals[0]).toMatchObject({
      id: created.appealId,
      userId: LEARNER_ID,
      attemptId: null,
      projectReviewId: REVIEW_ID,
      category: "project_finding",
      evidenceHash: created.evidenceHash,
      status: "open",
    });
    expect(storedAppeals[0]?.evidence).toMatchObject({
      targetType: "project_review",
      project: { id: PROJECT_ID },
      review: {
        id: REVIEW_ID,
        commitSha: "abc123immutable",
        analyzerVersion: "static-review-v1",
        findings: FINDINGS,
      },
    });
    expect(hashAppealEvidence(storedAppeals[0]?.evidence)).toBe(created.evidenceHash);

    const events = await db.select().from(appealEvent);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      appealId: created.appealId,
      actorUserId: LEARNER_ID,
      actorRole: "learner",
      event: "submitted",
      clientRequestId: REQUEST_ID,
    });
    const adminNotices = await db.select().from(notification).where(eq(notification.userId, ADMIN_ID));
    expect(adminNotices).toHaveLength(1);
    expect(adminNotices[0]?.actionUrl).toBe(`/admin/appeals?appeal=${created.appealId}`);

    const replay = await submitProjectReviewAppeal({
      userId: LEARNER_ID,
      projectId: PROJECT_ID,
      projectReviewId: REVIEW_ID,
      clientRequestId: REQUEST_ID,
      category: "project_finding",
      reason: REASON,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(replay).toMatchObject({ duplicate: true, appealId: created.appealId, evidenceHash: created.evidenceHash });
    expect(await db.select().from(appeal)).toHaveLength(1);
    expect(await db.select().from(appealEvent)).toHaveLength(1);
    expect(await db.select().from(notification).where(eq(notification.userId, ADMIN_ID))).toHaveLength(1);

    await expect(submitProjectReviewAppeal({
      userId: LEARNER_ID,
      projectId: PROJECT_ID,
      projectReviewId: REVIEW_ID,
      clientRequestId: REQUEST_ID,
      category: "project_finding",
      reason: "This changed claim must not reuse the original request identifier.",
      now: NOW,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(submitProjectReviewAppeal({
      userId: LEARNER_ID,
      projectId: PROJECT_ID,
      projectReviewId: REVIEW_ID,
      clientRequestId: "92000000-0000-4000-8000-000000000002",
      category: "project_finding",
      reason: REASON,
      now: NOW,
    })).rejects.toMatchObject({ code: "ALREADY_OPEN" });
    await expect(submitProjectReviewAppeal({
      userId: OTHER_ID,
      projectId: PROJECT_ID,
      projectReviewId: REVIEW_ID,
      clientRequestId: "92000000-0000-4000-8000-000000000003",
      category: "project_finding",
      reason: REASON,
      now: NOW,
    })).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });

    const queue = await listAdminAppeals();
    expect(queue).toContainEqual(expect.objectContaining({
      id: created.appealId,
      target: "project_review",
      projectReviewId: REVIEW_ID,
    }));
    const detail = await getAdminAppealDetail(created.appealId);
    expect(detail.appeal.evidenceHashValid).toBe(true);
    expect(detail.target).toMatchObject({
      projectReviewId: REVIEW_ID,
      projectId: PROJECT_ID,
      projectTitle: "Portfolio API",
      reviewCommitSha: "abc123immutable",
      reviewAnalyzerVersion: "static-review-v1",
      reviewStatus: "complete",
    });

    const decision = await decideAppeal({
      actorUserId: ADMIN_ID,
      appealId: created.appealId,
      requestId: "92000000-0000-4000-8000-000000000004",
      expectedVersion: 1,
      decision: "upheld",
      reason: "The preserved finding and commit support the original static review.",
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(decision).toMatchObject({ decision: "upheld", examSessionId: null, correctionPending: false });
    const learnerNotices = await db.select().from(notification).where(eq(notification.userId, LEARNER_ID));
    expect(learnerNotices).toContainEqual(expect.objectContaining({ actionUrl: "/projects" }));
    const reviewAfterDecision = (await db.select().from(projectReview).where(eq(projectReview.id, REVIEW_ID)))[0];
    expect(reviewAfterDecision).toEqual(originalReview);
  });

  it("rejects a non-complete stored review without appending evidence", async () => {
    await expect(submitProjectReviewAppeal({
      userId: LEARNER_ID,
      projectId: PROJECT_ID,
      projectReviewId: PENDING_REVIEW_ID,
      clientRequestId: "92000000-0000-4000-8000-000000000005",
      category: "project_finding",
      reason: "A pending review must not enter the human appeal queue yet.",
      now: NOW,
    })).rejects.toBeInstanceOf(ProjectReviewAppealError);
    expect(await db.select().from(appeal)).toHaveLength(0);
    expect(await db.select().from(appealEvent)).toHaveLength(0);
  });
});
