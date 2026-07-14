import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { decideAppeal } from "@/lib/appeals/admin-service";
import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { submitProjectReviewAppeal } from "@/lib/appeals/project-review-service";
import { db, pool } from "@/lib/db/client";
import {
  notification,
  project,
  projectReview,
  projectReviewCorrection,
  projectReviewCorrectionEvent,
  projectReviewEffective,
  modelCall,
  user,
} from "@/lib/db/schema";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import {
  DETERMINISTIC_PROJECT_REVIEW_PROVENANCE,
  PROJECT_REVIEW_ANALYZER_VERSION,
  PROJECT_REVIEW_RUBRIC_VERSION,
  type ReviewFinding,
} from "@/lib/github/reviewer";
import {
  processOneProjectReviewCorrection,
  queueProjectReviewCorrection,
  requestProjectReviewCorrectionRetry,
} from "@/lib/projects/review-correction-service";

const ADMIN_ID = "project-correction-admin";
const LEARNER_ID = "project-correction-learner";
const PROJECT_ID = "a1000000-0000-4000-8000-000000000001";
const REVIEW_ID = "a1000000-0000-4000-8000-000000000002";
const APPEAL_REQUEST_ID = "a1000000-0000-4000-8000-000000000003";
const DECISION_REQUEST_ID = "a1000000-0000-4000-8000-000000000004";
const SHA = "a".repeat(40);
const NOW = new Date("2026-07-12T12:00:00.000Z");
const ORIGINAL_FINDINGS = [{
  severity: "warning",
  category: "tests",
  message: "No test files were found.",
  evidence: "No conventional test path",
}];
const CORRECTED_FINDINGS = [{
  severity: "info",
  category: "unfinished-marker",
  path: "src/app.ts",
  line: 4,
  message: "Review this marker.",
  evidence: "TODO marker",
}] satisfies ReviewFinding[];

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Project-review correction tests require the disposable integration database.");
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

function reviewResult(commitSha: string, findings: ReviewFinding[] = CORRECTED_FINDINGS) {
  return {
    repositoryUrl: "https://github.com/example/corrected-project",
    defaultBranch: "main",
    commitSha,
    filesReviewed: 3,
    findings,
    analyzerVersion: PROJECT_REVIEW_ANALYZER_VERSION,
    rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
    provenance: DETERMINISTIC_PROJECT_REVIEW_PROVENANCE,
  };
}

async function seedProject(input: {
  projectId: string;
  reviewId: string;
  sha: string;
  title: string;
}) {
  const findingsHash = hashAppealEvidence(ORIGINAL_FINDINGS);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.project_review_projection_write', '1', true)`);
    await tx.insert(project).values({
      id: input.projectId,
      userId: LEARNER_ID,
      title: input.title,
      summary: "A stored public repository review with deterministic correction evidence.",
      status: "reviewed",
      githubUrl: "https://github.com/example/corrected-project",
      githubCommitSha: input.sha,
    });
    await tx.insert(projectReview).values({
      id: input.reviewId,
      projectId: input.projectId,
      commitSha: input.sha,
      analyzerVersion: PROJECT_REVIEW_ANALYZER_VERSION,
      rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
      analysisProvenance: { ...DETERMINISTIC_PROJECT_REVIEW_PROVENANCE },
      findings: ORIGINAL_FINDINGS,
      findingsHash,
      status: "complete",
      createdAt: NOW,
    });
    await tx.insert(projectReviewEffective).values({
      projectId: input.projectId,
      sourceReviewId: input.reviewId,
      commitSha: input.sha,
      analyzerVersion: PROJECT_REVIEW_ANALYZER_VERSION,
      rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
      provenance: { ...DETERMINISTIC_PROJECT_REVIEW_PROVENANCE },
      findings: ORIGINAL_FINDINGS,
      findingsHash,
      revision: 1,
      updatedAt: NOW,
    });
  });
}

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values([
    { id: ADMIN_ID, publicId: "a2000000-0000-4000-8000-000000000001", name: "Correction Admin", email: "correction-admin@integration.invalid", role: "admin", status: "active" },
    { id: LEARNER_ID, publicId: "a2000000-0000-4000-8000-000000000002", name: "Correction Learner", email: "correction-learner@integration.invalid", role: "learner", status: "active" },
  ]);
  await seedProject({ projectId: PROJECT_ID, reviewId: REVIEW_ID, sha: SHA, title: "Corrected Portfolio" });
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL project-review corrective re-analysis", () => {
  it("atomically queues an overturn, leases once, appends correction evidence, and advances only the effective projection", async () => {
    const original = (await db.select().from(projectReview).where(eq(projectReview.id, REVIEW_ID)))[0];
    const submitted = await submitProjectReviewAppeal({
      userId: LEARNER_ID,
      projectId: PROJECT_ID,
      projectReviewId: REVIEW_ID,
      clientRequestId: APPEAL_REQUEST_ID,
      category: "project_finding",
      reason: "The test-path finding ignored the repository's documented test convention.",
      now: new Date(NOW.getTime() + 1_000),
    });
    const decision = await decideAppeal({
      actorUserId: ADMIN_ID,
      appealId: submitted.appealId,
      requestId: DECISION_REQUEST_ID,
      expectedVersion: 1,
      decision: "overturned",
      reason: "The immutable commit evidence confirms that the original static finding is defective.",
      correctiveAction: "Re-run the deterministic static rubric against the exact original commit and append corrected evidence.",
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(decision).toMatchObject({
      decision: "overturned",
      correctionPending: true,
      projectReviewCorrectionStatus: "queued",
      projectReviewCorrectionRevision: 1,
    });
    const correctionId = decision.projectReviewCorrectionId!;
    await expect(pool.query(
      `update project_review_correction set source_appeal_id = null where id = $1`,
      [correctionId],
    )).rejects.toMatchObject({ code: "23514" });
    const analyzer = vi.fn(async (repositoryUrl: string, commitSha: string) => {
      expect(repositoryUrl).toBe("https://github.com/example/corrected-project");
      expect(commitSha).toBe(SHA);
      return reviewResult(commitSha);
    });
    const reports = await Promise.all([
      processOneProjectReviewCorrection({ workerId: "worker-a", correctionId, analyzer, now: new Date(NOW.getTime() + 3_000) }),
      processOneProjectReviewCorrection({ workerId: "worker-b", correctionId, analyzer, now: new Date(NOW.getTime() + 3_000) }),
    ]);
    expect(reports.filter((report) => report.processed)).toHaveLength(1);
    expect(reports.find((report) => report.processed)).toMatchObject({ succeeded: true, projectionApplied: true });
    expect(analyzer).toHaveBeenCalledOnce();

    expect((await db.select().from(projectReview).where(eq(projectReview.id, REVIEW_ID)))[0]).toEqual(original);
    const storedCorrection = (await db.select().from(projectReviewCorrection).where(eq(projectReviewCorrection.id, correctionId)))[0]!;
    expect(storedCorrection).toMatchObject({
      sourceReviewId: REVIEW_ID,
      sourceAppealId: submitted.appealId,
      sourceCommitSha: SHA,
      sourceAnalyzerVersion: PROJECT_REVIEW_ANALYZER_VERSION,
      sourceRubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
      status: "succeeded",
      resultFindings: CORRECTED_FINDINGS,
      projectionApplied: true,
      attemptCount: 1,
    });
    expect(storedCorrection.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAppealEvidence(storedCorrection.evidence)).toBe(storedCorrection.evidenceHash);
    expect(storedCorrection.evidence).toMatchObject({
      source: { reviewId: REVIEW_ID, commitSha: SHA },
      execution: { deterministic: true, aiRole: "none", repositoryExecution: "none", runnerTemplateId: null },
      projection: { applied: true, revision: 2 },
    });
    const persistedAdminReasonHash = hashAppealEvidence(storedCorrection.reason);
    expect(storedCorrection.evidence).toMatchObject({
      authority: { adminReasonHash: persistedAdminReasonHash },
    });
    const effective = (await db.select().from(projectReviewEffective).where(eq(projectReviewEffective.projectId, PROJECT_ID)))[0]!;
    expect(effective).toMatchObject({
      sourceReviewId: REVIEW_ID,
      correctionId,
      commitSha: SHA,
      findings: CORRECTED_FINDINGS,
      revision: 2,
    });
    const events = await db.select().from(projectReviewCorrectionEvent).where(eq(projectReviewCorrectionEvent.correctionId, correctionId));
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "queued", "analysis_started", "analysis_succeeded", "projection_applied",
    ]));
    expect(events.every((event) => hashAppealEvidence(event.evidence) === event.evidenceHash)).toBe(true);
    const notices = await db.select().from(notification).where(eq(notification.userId, LEARNER_ID));
    expect(notices.map((notice) => notice.type)).toEqual(expect.arrayContaining([
      "appeal-updated", "project-review-correction-queued", "project-review-corrected",
    ]));

    const exported = await createLearnerExport({
      learnerId: LEARNER_ID,
      actorUserId: ADMIN_ID,
      requestId: "a1000000-0000-4000-8000-000000000005",
      maxRecords: 2_000,
      maxBytes: 4 * 1024 * 1024,
      now: new Date(NOW.getTime() + 3_500),
    });
    const exportLines = (await new Response(exported.stream).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; category?: string; data?: Record<string, unknown> });
    await exported.completion;
    const exportRecord = (category: string) => exportLines.find(
      (line) => line.type === "record" && line.category === category,
    )?.data;
    expect(exportRecord("projectReviews")).toMatchObject({
      id: REVIEW_ID,
      rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
      findingsHash: hashAppealEvidence(ORIGINAL_FINDINGS),
      analysisProvenance: expect.objectContaining({ aiUsed: false, repositoryExecution: "none" }),
    });
    const exportedCorrection = exportRecord("projectReviewCorrections");
    expect(exportedCorrection).toMatchObject({
      id: correctionId,
      sourceReviewId: REVIEW_ID,
      sourceFindingsHash: hashAppealEvidence(ORIGINAL_FINDINGS),
      resultFindingsHash: storedCorrection.resultFindingsHash,
      workerIdentityIncluded: false,
      administratorIdentityIncluded: false,
      evidenceRedacted: true,
      evidenceHashVerifiableFromExport: false,
      evidence: {
        authority: { adminReasonHash: persistedAdminReasonHash },
      },
    });
    const exportedEvent = exportRecord("projectReviewCorrectionEvents");
    expect(exportedEvent).toMatchObject({
      correctionId,
      actorIdentityIncluded: false,
    });
    expect(exportRecord("projectReviewEffective")).toMatchObject({
      projectId: PROJECT_ID,
      correctionId,
      findingsHash: storedCorrection.resultFindingsHash,
    });
    expect(JSON.stringify(exportLines)).not.toContain("crashed-worker");
    expect(JSON.stringify([exportedCorrection, exportedEvent])).not.toContain(ADMIN_ID);
    expect((exportedCorrection?.evidence as { authority?: Record<string, unknown> })?.authority)
      .not.toHaveProperty("requestedBy");

    const replay = await decideAppeal({
      actorUserId: ADMIN_ID,
      appealId: submitted.appealId,
      requestId: DECISION_REQUEST_ID,
      expectedVersion: 1,
      decision: "overturned",
      reason: "The immutable commit evidence confirms that the original static finding is defective.",
      correctiveAction: "Re-run the deterministic static rubric against the exact original commit and append corrected evidence.",
      now: new Date(NOW.getTime() + 4_000),
    });
    expect(replay).toMatchObject({
      replayed: true,
      correctionPending: false,
      projectReviewCorrectionId: correctionId,
      projectReviewCorrectionStatus: "succeeded",
    });
    expect(await db.select().from(projectReviewCorrection)).toHaveLength(1);

    await expect(pool.query(
      `update project_review set findings = '[]'::jsonb where id = $1`,
      [REVIEW_ID],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `update project_review_correction set evidence_hash = $2 where id = $1`,
      [correctionId, "f".repeat(64)],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `update project_review_correction_event set reason = 'Mutated evidence' where correction_id = $1`,
      [correctionId],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `update project_review_effective set correction_id = null where project_id = $1`,
      [PROJECT_ID],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`delete from project_review_correction_event where correction_id = $1`, [correctionId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`delete from project_review_correction where id = $1`, [correctionId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`delete from project_review where id = $1`, [REVIEW_ID]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`delete from project_review_effective where project_id = $1`, [PROJECT_ID]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`delete from appeal where id = $1`, [submitted.appealId]))
      .rejects.toMatchObject({ code: "23503" });

    const deletion = await pool.connect();
    try {
      await deletion.query("begin");
      await deletion.query("select set_config('app.account_deletion_authorized', '1', true)");
      await deletion.query("delete from project_review_correction where project_id = $1", [PROJECT_ID]);
      await deletion.query("delete from appeal where id = $1", [submitted.appealId]);
      await deletion.query("delete from project where id = $1", [PROJECT_ID]);
      await deletion.query("commit");
    } catch (error) {
      await deletion.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      deletion.release();
    }
    expect(await db.select().from(projectReview).where(eq(projectReview.id, REVIEW_ID))).toHaveLength(0);
    expect(await db.select().from(projectReviewCorrection).where(eq(projectReviewCorrection.id, correctionId))).toHaveLength(0);
    expect(await db.select().from(projectReviewEffective).where(eq(projectReviewEffective.projectId, PROJECT_ID))).toHaveLength(0);
  });

  it("keeps a non-null model-call binding immutable", async () => {
    const modelCallId = "d1000000-0000-4000-8000-000000000001";
    const projectId = "d1000000-0000-4000-8000-000000000002";
    const reviewId = "d1000000-0000-4000-8000-000000000003";
    await db.insert(modelCall).values({
      id: modelCallId,
      userId: LEARNER_ID,
      provider: "nvidia_nim",
      model: "integration-review-model",
      operation: "project_review",
      promptVersion: "project-review-v2",
      status: "succeeded",
      requestHash: "model-call-binding-canary",
      createdAt: NOW,
    });
    await db.insert(project).values({
      id: projectId,
      userId: LEARNER_ID,
      title: "AI provenance binding",
      summary: "A fixture proving that a model-call attribution cannot be erased.",
      githubUrl: "https://github.com/example/corrected-project",
      githubCommitSha: SHA,
    });
    await db.insert(projectReview).values({
      id: reviewId,
      projectId,
      commitSha: SHA,
      analyzerVersion: "ai-assisted-review-v2",
      rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
      modelCallId,
      analysisProvenance: {
        schemaVersion: 1,
        analysisMode: "ai_assisted",
        aiUsed: true,
        promptVersion: "project-review-v2",
        provider: "nvidia_nim",
        model: "integration-review-model",
        modelCallId,
        rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
        repositoryExecution: "none",
        runnerTemplateId: null,
      },
      findings: ORIGINAL_FINDINGS,
      findingsHash: hashAppealEvidence(ORIGINAL_FINDINGS),
      status: "complete",
      createdAt: NOW,
    });

    await expect(pool.query(
      `update project_review set model_call_id = null where id = $1`,
      [reviewId],
    )).rejects.toMatchObject({ code: "23514" });
    expect((await db.select().from(projectReview).where(eq(projectReview.id, reviewId)))[0]?.modelCallId)
      .toBe(modelCallId);
  });

  it("fails without changing projection, enforces queue replay/actor authority, and never overwrites a newer review", async () => {
    const secondProjectId = "b1000000-0000-4000-8000-000000000001";
    const secondReviewId = "b1000000-0000-4000-8000-000000000002";
    const secondSha = "b".repeat(40);
    const queueRequestId = "b1000000-0000-4000-8000-000000000003";
    await seedProject({ projectId: secondProjectId, reviewId: secondReviewId, sha: secondSha, title: "Stale Correction" });
    const queued = await queueProjectReviewCorrection({
      actorUserId: ADMIN_ID,
      sourceReviewId: secondReviewId,
      requestId: queueRequestId,
      reason: "A reviewed deterministic rule defect requires an exact-commit re-analysis.",
      now: new Date(NOW.getTime() + 10_000),
    });
    await expect(queueProjectReviewCorrection({
      actorUserId: LEARNER_ID,
      sourceReviewId: secondReviewId,
      requestId: "b1000000-0000-4000-8000-000000000004",
      reason: "A learner must never self-authorize an official corrective re-analysis.",
      now: new Date(NOW.getTime() + 10_000),
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await expect(queueProjectReviewCorrection({
      actorUserId: ADMIN_ID,
      sourceReviewId: secondReviewId,
      requestId: queueRequestId,
      reason: "A changed reason cannot reuse the original correction request identifier.",
      now: new Date(NOW.getTime() + 10_000),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(queueProjectReviewCorrection({
      actorUserId: ADMIN_ID,
      sourceReviewId: secondReviewId,
      requestId: queueRequestId,
      reason: "A reviewed deterministic rule defect requires an exact-commit re-analysis.",
      now: new Date(NOW.getTime() + 10_000),
    })).resolves.toMatchObject({ duplicate: true, correctionId: queued.correctionId });

    const failed = await processOneProjectReviewCorrection({
      workerId: "failure-worker",
      correctionId: queued.correctionId,
      analyzer: async () => { throw new Error("simulated GitHub outage"); },
      now: new Date(NOW.getTime() + 11_000),
    });
    expect(failed).toMatchObject({ processed: true, succeeded: false, errorCode: "STATIC_ANALYSIS_FAILED" });
    expect((await db.select().from(projectReviewEffective).where(eq(projectReviewEffective.projectId, secondProjectId)))[0]).toMatchObject({
      sourceReviewId: secondReviewId,
      correctionId: null,
      revision: 1,
      findings: ORIGINAL_FINDINGS,
    });
    const retryRequestId = "b1000000-0000-4000-8000-000000000006";
    const retryReason = "The transient GitHub outage cleared; queue the preserved exact-commit correction again.";
    await expect(requestProjectReviewCorrectionRetry({
      actorUserId: ADMIN_ID,
      correctionId: queued.correctionId,
      requestId: retryRequestId,
      reason: retryReason,
      now: new Date(NOW.getTime() + 12_000),
    })).resolves.toMatchObject({ status: "queued", duplicate: false, attemptCount: 1 });
    await expect(requestProjectReviewCorrectionRetry({
      actorUserId: ADMIN_ID,
      correctionId: queued.correctionId,
      requestId: retryRequestId,
      reason: retryReason,
      now: new Date(NOW.getTime() + 13_000),
    })).resolves.toMatchObject({ status: "queued", duplicate: true });
    await expect(requestProjectReviewCorrectionRetry({
      actorUserId: ADMIN_ID,
      correctionId: queued.correctionId,
      requestId: retryRequestId,
      reason: "A changed retry reason must not reuse an existing retry request identifier.",
      now: new Date(NOW.getTime() + 13_000),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    const newerReviewId = "b1000000-0000-4000-8000-000000000005";
    const newerSha = "c".repeat(40);
    const newerFindings = [{ severity: "info", category: "documentation", message: "Current review", evidence: "README" }];
    const newerHash = hashAppealEvidence(newerFindings);
    await db.insert(projectReview).values({
      id: newerReviewId,
      projectId: secondProjectId,
      commitSha: newerSha,
      analyzerVersion: PROJECT_REVIEW_ANALYZER_VERSION,
      rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
      analysisProvenance: { ...DETERMINISTIC_PROJECT_REVIEW_PROVENANCE },
      findings: newerFindings,
      findingsHash: newerHash,
      status: "complete",
      createdAt: new Date(NOW.getTime() + 20_000),
    });
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.project_review_projection_write', '1', true)`);
      await tx.update(project).set({ githubCommitSha: newerSha }).where(eq(project.id, secondProjectId));
      await tx.update(projectReviewEffective).set({
        sourceReviewId: newerReviewId,
        correctionId: null,
        commitSha: newerSha,
        findings: newerFindings,
        findingsHash: newerHash,
        revision: 2,
        updatedAt: new Date(NOW.getTime() + 20_000),
      }).where(eq(projectReviewEffective.projectId, secondProjectId));
    });

    const stale = await processOneProjectReviewCorrection({
      workerId: "retry-worker",
      correctionId: queued.correctionId,
      analyzer: async (_url, commitSha) => reviewResult(commitSha),
      now: new Date(NOW.getTime() + 21_000),
    });
    expect(stale).toMatchObject({ processed: true, succeeded: true, projectionApplied: false });
    expect((await db.select().from(projectReviewEffective).where(eq(projectReviewEffective.projectId, secondProjectId)))[0]).toMatchObject({
      sourceReviewId: newerReviewId,
      correctionId: null,
      commitSha: newerSha,
      revision: 2,
      findings: newerFindings,
    });
    expect((await db.select().from(projectReviewCorrection).where(eq(projectReviewCorrection.id, queued.correctionId)))[0]).toMatchObject({
      status: "succeeded",
      projectionApplied: false,
      attemptCount: 2,
    });
  });

  it("fences a stale same-host attempt after lease recovery and reclaim", async () => {
    const queued = await queueProjectReviewCorrection({
      actorUserId: ADMIN_ID,
      sourceReviewId: REVIEW_ID,
      requestId: "e1000000-0000-4000-8000-000000000001",
      reason: "A same-host crash race fixture verifies unique attempt-generation fencing.",
      now: new Date(NOW.getTime() + 70_000),
    });
    const staleFindings = [{
      severity: "warning",
      category: "stale-attempt",
      message: "This stale result must never settle the reclaimed correction.",
      evidence: "expired lease generation",
    }] satisfies ReviewFinding[];
    const winnerFindings = [{
      severity: "info",
      category: "current-attempt",
      message: "Only the current lease generation may settle the correction.",
      evidence: "current lease generation",
    }] satisfies ReviewFinding[];
    let signalAnalyzerStarted!: () => void;
    const analyzerStarted = new Promise<void>((resolve) => { signalAnalyzerStarted = resolve; });
    let resolveStaleResult!: (value: ReturnType<typeof reviewResult>) => void;
    const staleResult = new Promise<ReturnType<typeof reviewResult>>((resolve) => { resolveStaleResult = resolve; });
    const staleAttempt = processOneProjectReviewCorrection({
      workerId: "same-host-worker",
      correctionId: queued.correctionId,
      analyzer: async () => {
        signalAnalyzerStarted();
        return staleResult;
      },
      now: new Date(NOW.getTime() + 71_000),
    });
    await analyzerStarted;
    expect((await db.select().from(projectReviewCorrection)
      .where(eq(projectReviewCorrection.id, queued.correctionId)))[0]).toMatchObject({
      status: "running",
      leaseOwner: "same-host-worker",
      attemptCount: 1,
    });
    await db.update(projectReviewCorrection).set({
      leaseExpiresAt: new Date(NOW.getTime() + 79_000),
    }).where(eq(projectReviewCorrection.id, queued.correctionId));

    const winner = await processOneProjectReviewCorrection({
      workerId: "same-host-worker",
      correctionId: queued.correctionId,
      analyzer: async (_url, commitSha) => reviewResult(commitSha, winnerFindings),
      now: new Date(NOW.getTime() + 80_000),
    });
    resolveStaleResult(reviewResult(SHA, staleFindings));
    const stale = await staleAttempt;

    expect(winner).toMatchObject({ processed: true, succeeded: true });
    expect(stale).toMatchObject({ processed: true, succeeded: false, errorCode: "WRITE_CONFLICT" });
    expect((await db.select().from(projectReviewCorrection)
      .where(eq(projectReviewCorrection.id, queued.correctionId)))[0]).toMatchObject({
      status: "succeeded",
      attemptCount: 2,
      resultFindings: winnerFindings,
    });
    const events = await db.select().from(projectReviewCorrectionEvent)
      .where(eq(projectReviewCorrectionEvent.correctionId, queued.correctionId));
    expect(events.filter((event) => event.event === "analysis_failed")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      event: "analysis_failed",
      evidence: expect.objectContaining({ leaseGeneration: 1, errorCode: "WORKER_LEASE_EXPIRED" }),
    }));
  });

  it("reclaims an interrupted worker with durable failure evidence and dead-letters an exhausted lease", async () => {
    const first = await queueProjectReviewCorrection({
      actorUserId: ADMIN_ID,
      sourceReviewId: REVIEW_ID,
      requestId: "c1000000-0000-4000-8000-000000000001",
      reason: "A process interruption fixture verifies durable correction lease recovery.",
      now: new Date(NOW.getTime() + 30_000),
    });
    await db.update(projectReviewCorrection).set({
      status: "running",
      attemptCount: 1,
      leaseOwner: "crashed-worker",
      leaseExpiresAt: new Date(NOW.getTime() + 31_000),
      startedAt: new Date(NOW.getTime() + 30_500),
    }).where(eq(projectReviewCorrection.id, first.correctionId));
    const reclaimed = await processOneProjectReviewCorrection({
      workerId: "replacement-worker",
      correctionId: first.correctionId,
      analyzer: async (_url, commitSha) => reviewResult(commitSha),
      now: new Date(NOW.getTime() + 40_000),
    });
    expect(reclaimed).toMatchObject({ processed: true, succeeded: true });
    expect((await db.select().from(projectReviewCorrection).where(eq(projectReviewCorrection.id, first.correctionId)))[0]).toMatchObject({
      status: "succeeded",
      attemptCount: 2,
      deadLetteredAt: null,
    });
    const reclaimedEvents = await db.select().from(projectReviewCorrectionEvent)
      .where(eq(projectReviewCorrectionEvent.correctionId, first.correctionId));
    expect(reclaimedEvents).toContainEqual(expect.objectContaining({
      event: "analysis_failed",
      evidence: expect.objectContaining({
        errorCode: "WORKER_LEASE_EXPIRED",
        attemptNumber: 1,
        retryAllowed: true,
        deadLettered: false,
      }),
    }));

    const exhausted = await queueProjectReviewCorrection({
      actorUserId: ADMIN_ID,
      sourceReviewId: REVIEW_ID,
      requestId: "c1000000-0000-4000-8000-000000000002",
      reason: "An exhausted process interruption fixture verifies visible dead-letter state.",
      now: new Date(NOW.getTime() + 50_000),
    });
    await db.update(projectReviewCorrection).set({
      status: "running",
      attemptCount: 3,
      leaseOwner: "third-crashed-worker",
      leaseExpiresAt: new Date(NOW.getTime() + 51_000),
      startedAt: new Date(NOW.getTime() + 50_500),
    }).where(eq(projectReviewCorrection.id, exhausted.correctionId));
    await expect(processOneProjectReviewCorrection({
      workerId: "dead-letter-observer",
      correctionId: exhausted.correctionId,
      analyzer: async (_url, commitSha) => reviewResult(commitSha),
      now: new Date(NOW.getTime() + 60_000),
    })).resolves.toEqual({ processed: false });
    const dead = (await db.select().from(projectReviewCorrection)
      .where(eq(projectReviewCorrection.id, exhausted.correctionId)))[0]!;
    expect(dead).toMatchObject({
      status: "failed",
      attemptCount: 3,
      lastErrorCode: "WORKER_LEASE_EXPIRED",
      deadLetteredAt: new Date(NOW.getTime() + 60_000),
    });
    await expect(requestProjectReviewCorrectionRetry({
      actorUserId: ADMIN_ID,
      correctionId: exhausted.correctionId,
      requestId: "c1000000-0000-4000-8000-000000000003",
      reason: "A dead-lettered correction must require a new reviewed correction version.",
      now: new Date(NOW.getTime() + 61_000),
    })).rejects.toMatchObject({ code: "CORRECTION_DEAD_LETTERED" });
    const adminNotices = await db.select().from(notification).where(eq(notification.userId, ADMIN_ID));
    expect(adminNotices).toContainEqual(expect.objectContaining({
      type: "project-review-correction-dead-lettered",
      actionUrl: "/admin/project-review-corrections",
    }));
  });
});
