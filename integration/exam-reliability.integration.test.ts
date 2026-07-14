import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { processExamFinalizationBatch } from "@/app/api/exams/_lib/finalization-worker";
import { finalizeExam } from "@/app/api/exams/_lib/service";
import {
  BLUEPRINT_RESPONSE_KEY,
  RESULT_RESPONSE_KEY,
  type ExamFormSnapshot,
} from "@/lib/exams/contracts";
import { db, pool } from "@/lib/db/client";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import {
  attempt,
  emailOutbox,
  examEvent,
  examFinalizationJob,
  examMasteryRecheck,
  examReexamGrant,
  examSession,
  notification,
  response,
  user,
  userAchievement,
} from "@/lib/db/schema";
import { issueExamReexamGrant } from "@/lib/exams/reexam-grant";
import { and, eq } from "drizzle-orm";

const LEARNER_ID = "exam-reliability-learner";
const ADMIN_ID = "exam-reliability-admin";

function assertDisposableDatabase() {
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Exam reliability tests require the disposable integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  if (result.rows.length) {
    await pool.query(`truncate table ${result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(",")} restart identity cascade`);
  }
}

async function waitForAdvisoryWaitHeldBy(blockerPid: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: boolean }>(`
      select exists (
        select 1
          from pg_locks held
          join pg_locks waiter
            on waiter.locktype = held.locktype
           and waiter.database is not distinct from held.database
           and waiter.classid is not distinct from held.classid
           and waiter.objid is not distinct from held.objid
           and waiter.objsubid is not distinct from held.objsubid
         where held.pid = $1 and held.locktype = 'advisory' and held.granted
           and waiter.pid <> held.pid and not waiter.granted
      ) as waiting
    `, [blockerPid]);
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Grant issuance did not reach the held module advisory lock.");
}

function fullForm(formId = "81000000-0000-4000-8000-000000000001"): ExamFormSnapshot {
  return {
    schemaVersion: 1,
    purpose: "formal-exam",
    formId,
    seed: `seed-${formId}`,
    courseId: "reviewed-course",
    courseTitle: "Reviewed course",
    moduleId: "reviewed.module",
    moduleTitle: "Reviewed module",
    contentVersion: "published:reviewed-v1:1.0.0",
    policyVersion: "formal-exam-v1",
    durationMinutes: 10,
    generatedAt: "2026-07-12T09:00:00.000Z",
    instructions: [],
    integrityDisclosure: { version: "v1", summary: "Bounded events", capturedEvents: [], notCaptured: [] },
    items: [
      { id: "q1", skillId: "skill.one", clusterId: "cluster.one", title: "One", prompt: "yes", kind: "short-answer", points: 80, critical: false, gradingEvidence: { kind: "exact-answer", acceptedAnswers: ["yes"], caseSensitive: false } },
      { id: "q2", skillId: "skill.two", clusterId: "cluster.two", title: "Two", prompt: "yes", kind: "short-answer", points: 20, critical: false, gradingEvidence: { kind: "exact-answer", acceptedAnswers: ["yes"], caseSensitive: false } },
    ],
  };
}

async function seedExactAnswerMasteryExam(input: {
  attemptId: string;
  sessionId: string;
  formId: string;
  now: Date;
}) {
  const form = fullForm(input.formId);
  const deadline = new Date(input.now.getTime() - 60_000);
  await db.insert(attempt).values({
    id: input.attemptId,
    userId: LEARNER_ID,
    kind: "exam",
    status: "in_progress",
    policyVersion: form.policyVersion,
    contentVersion: form.contentVersion,
    startedAt: new Date(input.now.getTime() - 11 * 60_000),
  });
  await db.insert(examSession).values({
    id: input.sessionId,
    attemptId: input.attemptId,
    userId: LEARNER_ID,
    status: "active",
    serverStartedAt: new Date(input.now.getTime() - 11 * 60_000),
    serverDeadlineAt: deadline,
    lastHeartbeatAt: deadline,
  });
  await db.insert(response).values([
    {
      attemptId: input.attemptId,
      itemKey: BLUEPRINT_RESPONSE_KEY,
      revision: 1,
      answer: { snapshot: form },
      source: "server",
      savedAt: new Date(input.now.getTime() - 10 * 60_000),
    },
    { attemptId: input.attemptId, itemKey: "q1", revision: 1, answer: { text: "yes" }, savedAt: deadline },
    { attemptId: input.attemptId, itemKey: "q2", revision: 1, answer: { text: "yes" }, savedAt: deadline },
  ]);
}

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values([
    { id: LEARNER_ID, name: "Learner", email: "exam-reliability@integration.invalid", role: "learner", status: "active" },
    { id: ADMIN_ID, name: "Admin", email: "exam-reliability-admin@integration.invalid", role: "admin", status: "active" },
  ]);
});

afterAll(async () => { await pool.end(); });

describe("real PostgreSQL exam reliability", () => {
  it("finalizes the latest autosave once, persists outage evidence, and cannot lower the source pass with a shorter recheck", async () => {
    const sourceAttemptId = "82000000-0000-4000-8000-000000000001";
    const sourceSessionId = "83000000-0000-4000-8000-000000000001";
    const form = fullForm();
    const deadline = new Date("2026-07-12T09:10:00.000Z");
    await db.insert(attempt).values({ id: sourceAttemptId, userId: LEARNER_ID, kind: "exam", status: "in_progress", policyVersion: form.policyVersion, contentVersion: form.contentVersion, startedAt: new Date("2026-07-12T09:00:00.000Z") });
    await db.insert(examSession).values({ id: sourceSessionId, attemptId: sourceAttemptId, userId: LEARNER_ID, status: "active", serverStartedAt: new Date("2026-07-12T09:00:00.000Z"), serverDeadlineAt: deadline, lastHeartbeatAt: new Date("2026-07-12T09:08:00.000Z") });
    await db.insert(response).values([
      { attemptId: sourceAttemptId, itemKey: BLUEPRINT_RESPONSE_KEY, revision: 1, answer: { snapshot: form }, source: "server", savedAt: new Date("2026-07-12T09:00:00.000Z") },
      { attemptId: sourceAttemptId, itemKey: "q1", revision: 1, answer: { text: "no" }, savedAt: new Date("2026-07-12T09:02:00.000Z") },
      { attemptId: sourceAttemptId, itemKey: "q1", revision: 2, answer: { text: "yes" }, savedAt: new Date("2026-07-12T09:09:00.000Z") },
      { attemptId: sourceAttemptId, itemKey: "q2", revision: 1, answer: { text: "no" }, savedAt: new Date("2026-07-12T09:09:30.000Z") },
    ]);
    await db.insert(examFinalizationJob).values({ examSessionId: sourceSessionId, dueAt: deadline });

    const now = new Date("2026-07-12T09:11:00.000Z");
    await expect(processExamFinalizationBatch({ workerId: "worker-a", limit: 2, now, clock: () => now })).resolves.toEqual({ processed: 1, succeeded: 1, retried: 0, failed: 0, leaseLost: 0 });
    await expect(processExamFinalizationBatch({ workerId: "worker-b", limit: 2, now, clock: () => now })).resolves.toEqual({ processed: 0, succeeded: 0, retried: 0, failed: 0, leaseLost: 0 });
    await db.update(examFinalizationJob).set({
      status: "leased", leaseOwner: "reclaimed-worker", leaseExpiresAt: new Date("2026-07-12T10:00:00.000Z"),
      attemptCount: 2, completedAt: null, lastErrorCode: "STALE",
    }).where(eq(examFinalizationJob.examSessionId, sourceSessionId));
    await expect(processExamFinalizationBatch({ workerId: "reconciler", limit: 1, now, clock: () => now })).resolves.toEqual({ processed: 0, succeeded: 0, retried: 0, failed: 0, leaseLost: 0 });
    expect((await db.select().from(examFinalizationJob).where(eq(examFinalizationJob.examSessionId, sourceSessionId)))[0]).toMatchObject({
      status: "succeeded", leaseOwner: null, lastErrorCode: null,
    });
    const resultRows = await db.select().from(response).where(and(eq(response.attemptId, sourceAttemptId), eq(response.itemKey, RESULT_RESPONSE_KEY)));
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0]?.answer).toMatchObject({ result: { outcome: "PASSED", officialScorePercent: 80, masteryRecheck: { required: true, clusterIds: ["cluster.two"] } } });
    expect((await db.select().from(attempt).where(eq(attempt.id, sourceAttemptId)))[0]?.passed).toBe(true);
    expect((await db.select().from(examSession).where(eq(examSession.id, sourceSessionId)))[0]?.disconnectedSeconds).toBe(105);
    expect(await db.select().from(examEvent).where(and(eq(examEvent.examSessionId, sourceSessionId), eq(examEvent.type, "server_deadline_disconnect")))).toHaveLength(1);
    const [schedule] = await db.select().from(examMasteryRecheck).where(eq(examMasteryRecheck.sourceAttemptId, sourceAttemptId));
    expect(schedule).toMatchObject({ status: "scheduled", targetClusterIds: ["cluster.two"] });

    const recheckAttemptId = "84000000-0000-4000-8000-000000000001";
    const recheckSessionId = "85000000-0000-4000-8000-000000000001";
    const recheckForm: ExamFormSnapshot = { ...form, purpose: "mastery-recheck", formId: "86000000-0000-4000-8000-000000000001", seed: "fresh-recheck", durationMinutes: 10, items: [form.items[1]!] };
    await db.insert(attempt).values({ id: recheckAttemptId, userId: LEARNER_ID, kind: "mastery_check", status: "in_progress", policyVersion: form.policyVersion, contentVersion: form.contentVersion, startedAt: now });
    await db.insert(examSession).values({ id: recheckSessionId, attemptId: recheckAttemptId, userId: LEARNER_ID, status: "active", serverStartedAt: now, serverDeadlineAt: new Date("2026-07-12T09:20:00.000Z"), lastHeartbeatAt: new Date("2026-07-12T09:20:00.000Z") });
    await db.insert(response).values([
      { attemptId: recheckAttemptId, itemKey: BLUEPRINT_RESPONSE_KEY, revision: 1, answer: { snapshot: recheckForm }, source: "server", savedAt: now },
      { attemptId: recheckAttemptId, itemKey: "q2", revision: 1, answer: { text: "no" }, savedAt: new Date("2026-07-12T09:19:00.000Z") },
    ]);
    await db.insert(examFinalizationJob).values({ examSessionId: recheckSessionId, dueAt: new Date("2026-07-12T09:20:00.000Z") });
    await db.update(examMasteryRecheck).set({ status: "active", recheckAttemptId }).where(eq(examMasteryRecheck.id, schedule!.id));
    const recheckNow = new Date("2026-07-12T09:21:00.000Z");
    await expect(processExamFinalizationBatch({
      workerId: "worker-c", limit: 1, now: recheckNow, clock: () => recheckNow,
    })).resolves.toMatchObject({ succeeded: 1 });
    expect((await db.select().from(attempt).where(eq(attempt.id, sourceAttemptId)))[0]?.passed).toBe(true);
    expect((await db.select().from(attempt).where(eq(attempt.id, recheckAttemptId)))[0]?.passed).toBe(false);
    const [terminalRecheck] = await db.select().from(examMasteryRecheck).where(eq(examMasteryRecheck.id, schedule!.id));
    expect(terminalRecheck).toMatchObject({ status: "completed", resultOutcome: "NOT_PASSED" });
    await expect(finalizeExam(
      LEARNER_ID,
      recheckSessionId,
      "deadline",
      new Date("2026-07-12T09:22:00.000Z"),
    )).resolves.toMatchObject({ outcome: "NOT_PASSED" });
    const [replayedRecheck] = await db.select().from(examMasteryRecheck).where(eq(examMasteryRecheck.id, schedule!.id));
    expect(replayedRecheck?.completedAt).toEqual(terminalRecheck?.completedAt);
    expect(replayedRecheck?.resultOutcome).toBe(terminalRecheck?.resultOutcome);
    expect(replayedRecheck?.updatedAt).toEqual(terminalRecheck?.updatedAt);
    await expect(pool.query(
      "update exam_mastery_recheck set result_outcome = 'PASSED' where id = $1",
      [schedule!.id],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      "update exam_mastery_recheck set module_id = 'tampered.module' where id = $1",
      [schedule!.id],
    )).rejects.toMatchObject({ code: "23514" });
    const exported = await createLearnerExport({
      learnerId: LEARNER_ID, actorUserId: ADMIN_ID,
      requestId: "8b000000-0000-4000-8000-000000000001", maxRecords: 500, maxBytes: 1_000_000,
    });
    const exportLines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(exportLines).toContainEqual(expect.objectContaining({
      category: "examMasteryRechecks",
      data: expect.objectContaining({ sourceAttemptId, resultOutcome: "NOT_PASSED" }),
    }));
    expect(exportLines).toContainEqual(expect.objectContaining({
      category: "examFinalizationJobs",
      data: expect.objectContaining({ examSessionId: sourceSessionId, workerIdentityIncluded: false }),
    }));
  });

  it("fences a stale finalizer after lease reclaim and keeps only the persisted winner projections", async () => {
    const attemptId = "b1000000-0000-4000-8000-000000000001";
    const sessionId = "b2000000-0000-4000-8000-000000000001";
    const jobId = "b3000000-0000-4000-8000-000000000001";
    const form = fullForm("b4000000-0000-4000-8000-000000000001");
    const staleNow = new Date();
    const deadline = new Date(staleNow.getTime() - 60_000);
    const initialLeaseExpiry = new Date(staleNow.getTime() + 60_000);
    await db.insert(attempt).values({
      id: attemptId,
      userId: LEARNER_ID,
      kind: "exam",
      status: "in_progress",
      policyVersion: form.policyVersion,
      contentVersion: form.contentVersion,
      startedAt: new Date(staleNow.getTime() - 11 * 60_000),
    });
    await db.insert(examSession).values({
      id: sessionId,
      attemptId,
      userId: LEARNER_ID,
      status: "active",
      serverStartedAt: new Date(staleNow.getTime() - 11 * 60_000),
      serverDeadlineAt: deadline,
      lastHeartbeatAt: deadline,
    });
    await db.insert(response).values([
      {
        attemptId,
        itemKey: BLUEPRINT_RESPONSE_KEY,
        revision: 1,
        answer: { snapshot: form },
        source: "server",
        savedAt: new Date(staleNow.getTime() - 10 * 60_000),
      },
      { attemptId, itemKey: "q1", revision: 1, answer: { text: "yes" }, savedAt: deadline },
      { attemptId, itemKey: "q2", revision: 1, answer: { text: "no" }, savedAt: deadline },
    ]);
    await db.insert(examFinalizationJob).values({
      id: jobId,
      examSessionId: sessionId,
      status: "leased",
      dueAt: deadline,
      attemptCount: 1,
      runnerRequestGeneration: 1,
      leaseOwner: "stale-worker",
      leaseExpiresAt: initialLeaseExpiry,
    });

    let releasePersistence!: () => void;
    let markPersistenceReached!: () => void;
    const persistenceReached = new Promise<void>((resolve) => { markPersistenceReached = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    let staleClock = staleNow;
    const staleFinalization = finalizeExam(LEARNER_ID, sessionId, "deadline", staleNow, {
      leaseFence: {
        jobId,
        owner: "stale-worker",
        attemptCount: 1,
        clock: () => staleClock,
      },
      beforePersist: async () => {
        markPersistenceReached();
        await persistenceGate;
      },
    });

    await Promise.race([
      persistenceReached,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("Stale finalizer did not reach the persistence barrier.")),
        3_000,
      )),
    ]);
    expect(await db.select().from(response).where(and(
      eq(response.attemptId, attemptId),
      eq(response.itemKey, RESULT_RESPONSE_KEY),
    ))).toHaveLength(0);
    expect((await db.select().from(attempt).where(eq(attempt.id, attemptId)))[0]).toMatchObject({
      status: "submitted",
      score: null,
      passed: null,
    });
    expect((await db.select().from(examSession).where(eq(examSession.id, sessionId)))[0]).toMatchObject({
      status: "expired",
      finalizedBy: "deadline",
    });

    const reclaimAt = new Date(staleNow.getTime() + 4 * 60_000);
    staleClock = reclaimAt;
    let winningAttempt: typeof attempt.$inferSelect | undefined;
    let winningSession: typeof examSession.$inferSelect | undefined;
    let winningJob: typeof examFinalizationJob.$inferSelect | undefined;
    let winningResults: Array<typeof response.$inferSelect> = [];
    try {
      await expect(processExamFinalizationBatch({
        workerId: "winner-worker",
        limit: 1,
        now: reclaimAt,
        clock: () => reclaimAt,
      })).resolves.toEqual({ processed: 1, succeeded: 1, retried: 0, failed: 0, leaseLost: 0 });

      [winningAttempt] = await db.select().from(attempt).where(eq(attempt.id, attemptId));
      [winningSession] = await db.select().from(examSession).where(eq(examSession.id, sessionId));
      [winningJob] = await db.select().from(examFinalizationJob).where(eq(examFinalizationJob.id, jobId));
      winningResults = await db.select().from(response).where(and(
        eq(response.attemptId, attemptId),
        eq(response.itemKey, RESULT_RESPONSE_KEY),
      ));
      expect(winningResults).toHaveLength(1);
      expect(winningResults[0]?.answer).toMatchObject({ result: {
        outcome: "PASSED",
        officialScorePercent: 80,
        finalizedAt: reclaimAt.toISOString(),
      } });
      expect(winningAttempt).toMatchObject({ status: "graded", score: 80, passed: true });
      expect(winningSession).toMatchObject({ status: "graded", integrityReviewState: "not_required" });
      expect(winningJob).toMatchObject({
        status: "succeeded",
        attemptCount: 2,
        runnerRequestGeneration: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    } finally {
      releasePersistence();
    }

    await expect(staleFinalization).rejects.toMatchObject({
      status: 409,
      code: "FINALIZATION_LEASE_LOST",
    });
    expect((await db.select().from(attempt).where(eq(attempt.id, attemptId)))[0]).toEqual(winningAttempt);
    expect((await db.select().from(examSession).where(eq(examSession.id, sessionId)))[0]).toEqual(winningSession);
    expect((await db.select().from(examFinalizationJob).where(eq(examFinalizationJob.id, jobId)))[0]).toEqual(winningJob);
    expect(await db.select().from(response).where(and(
      eq(response.attemptId, attemptId),
      eq(response.itemKey, RESULT_RESPONSE_KEY),
    ))).toEqual(winningResults);
  });

  it.each([
    {
      boundary: "before official result persistence",
      gate: "beforePersist" as const,
      attemptId: "c1000000-0000-4000-8000-000000000001",
      sessionId: "c2000000-0000-4000-8000-000000000001",
      formId: "c3000000-0000-4000-8000-000000000001",
      deletionRequestId: "c4000000-0000-4000-8000-000000000001",
    },
    {
      boundary: "before mastery badge, notification, and email projection",
      gate: "beforeMasteryAward" as const,
      attemptId: "d1000000-0000-4000-8000-000000000001",
      sessionId: "d2000000-0000-4000-8000-000000000001",
      formId: "d3000000-0000-4000-8000-000000000001",
      deletionRequestId: "d4000000-0000-4000-8000-000000000001",
    },
  ])("lets deletion win $boundary without surviving exam artifacts", async (scenario) => {
    const now = new Date();
    await seedExactAnswerMasteryExam({
      attemptId: scenario.attemptId,
      sessionId: scenario.sessionId,
      formId: scenario.formId,
      now,
    });

    let releaseBoundary!: () => void;
    let markBoundaryReached!: () => void;
    const boundaryReached = new Promise<void>((resolve) => { markBoundaryReached = resolve; });
    const boundaryGate = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    const waitAtBoundary = async () => {
      markBoundaryReached();
      await boundaryGate;
    };
    const finalization = finalizeExam(LEARNER_ID, scenario.sessionId, "deadline", now, {
      ...(scenario.gate === "beforePersist"
        ? { beforePersist: waitAtBoundary }
        : { beforeMasteryAward: waitAtBoundary }),
    });
    await Promise.race([
      boundaryReached,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`Finalization did not reach ${scenario.boundary}.`)),
        3_000,
      )),
    ]);

    const resultBeforeDeletion = await db.select().from(response).where(and(
      eq(response.attemptId, scenario.attemptId),
      eq(response.itemKey, RESULT_RESPONSE_KEY),
    ));
    expect(resultBeforeDeletion).toHaveLength(scenario.gate === "beforePersist" ? 0 : 1);

    const previousDeletionKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.DELETION_TOMBSTONE_KEY = "exam-reliability-deletion-key-that-is-long-enough";
    let deletionReport: Awaited<ReturnType<typeof deleteLearnerAccount>>;
    try {
      deletionReport = await deleteLearnerAccount({
        actorUserId: ADMIN_ID,
        learnerId: LEARNER_ID,
        requestId: scenario.deletionRequestId,
        reason: `Delete learner while exam finalization is paused ${scenario.boundary}.`,
        now: new Date(now.getTime() + 30_000),
        objectStorageRoot: "C:/synthetic-exam-reliability-objects",
      });
    } finally {
      releaseBoundary();
      if (previousDeletionKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousDeletionKey;
    }
    expect(deletionReport!.primaryStoreDeletionComplete).toBe(true);
    if (scenario.gate === "beforePersist") {
      await expect(finalization).rejects.toMatchObject({ code: "LEARNER_NOT_ACTIVE", status: 409 });
    } else {
      await expect(finalization).resolves.toMatchObject({ outcome: "MASTERED" });
    }

    expect((await db.select({ status: user.status }).from(user).where(eq(user.id, LEARNER_ID)))[0])
      .toEqual({ status: "deleted" });
    expect(await db.select().from(response).where(and(
      eq(response.attemptId, scenario.attemptId),
      eq(response.itemKey, RESULT_RESPONSE_KEY),
    ))).toHaveLength(0);
    expect(await db.select().from(examMasteryRecheck).where(
      eq(examMasteryRecheck.userId, LEARNER_ID),
    )).toHaveLength(0);
    expect(await db.select().from(userAchievement).where(
      eq(userAchievement.userId, LEARNER_ID),
    )).toHaveLength(0);
    expect(await db.select().from(notification).where(
      eq(notification.userId, LEARNER_ID),
    )).toHaveLength(0);
    expect(await db.select().from(emailOutbox).where(and(
      eq(emailOutbox.template, "mastery-awarded"),
      eq(emailOutbox.userId, LEARNER_ID),
    ))).toHaveLength(0);
    expect(await db.select().from(emailOutbox).where(
      eq(emailOutbox.template, "account-deleted"),
    )).toHaveLength(1);
  });

  it("creates one idempotent admin grant only from durable material-outage evidence", async () => {
    const attemptId = "87000000-0000-4000-8000-000000000001";
    const sessionId = "88000000-0000-4000-8000-000000000001";
    const form = fullForm("89000000-0000-4000-8000-000000000001");
    await db.insert(attempt).values({ id: attemptId, userId: LEARNER_ID, kind: "exam", status: "graded", passed: false, policyVersion: form.policyVersion, contentVersion: form.contentVersion });
    await db.insert(examSession).values({ id: sessionId, attemptId, userId: LEARNER_ID, status: "graded", disconnectedSeconds: 90, integrityReviewState: "not_required" });
    await db.insert(response).values([
      { attemptId, itemKey: BLUEPRINT_RESPONSE_KEY, revision: 1, answer: { snapshot: form }, source: "server" },
      { attemptId, itemKey: RESULT_RESPONSE_KEY, revision: 1, answer: { result: {
        schemaVersion: 1, gradingStatus: "graded", outcome: "NOT_PASSED", officialScorePercent: 50,
        earnedPoints: 50, possiblePoints: 100, pendingReviewItemIds: [], failedCriticalClusters: [],
        masteryBlockingCodingItems: [], compilationGatePassed: true, infrastructureFailure: false,
        finalizedAt: "2026-07-12T10:00:00.000Z", finalizedBy: "deadline", policyVersion: form.policyVersion,
        remediation: { required: true, targets: ["cluster.two"] },
        masteryRecheck: { required: false, clusterIds: [], codingItemIds: [] },
      } }, source: "server" },
    ]);
    const input = { actorUserId: ADMIN_ID, sourceExamSessionId: sessionId, requestId: "8a000000-0000-4000-8000-000000000001", reason: "Durable server evidence proves a ninety-second material examination outage." };
    const reports = await Promise.all([issueExamReexamGrant(input), issueExamReexamGrant(input)]);
    const first = reports.find((report) => !report.replayed)!;
    const replay = reports.find((report) => report.replayed)!;
    expect(first).toMatchObject({ status: "available", replayed: false });
    expect(replay).toMatchObject({ id: first.id, replayed: true, evidenceHash: first.evidenceHash });
    expect(await db.select().from(examReexamGrant)).toHaveLength(1);
    expect(first).not.toHaveProperty("evidence");
    const exported = await createLearnerExport({
      learnerId: LEARNER_ID, actorUserId: ADMIN_ID,
      requestId: "8b000000-0000-4000-8000-000000000002", maxRecords: 500, maxBytes: 1_000_000,
    });
    const exportLines = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    await exported.completion;
    expect(exportLines).toContainEqual(expect.objectContaining({
      category: "examReexamGrants",
      data: expect.objectContaining({ id: first.id, evidenceHash: first.evidenceHash, administratorIdentityIncluded: false }),
    }));
    await expect(pool.query(
      "update exam_reexam_grant set evidence = $2::jsonb where id = $1",
      [first.id, JSON.stringify({ tampered: true })],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      "update exam_reexam_grant set status = 'consumed' where id = $1",
      [first.id],
    )).rejects.toMatchObject({ code: "23514" });

    const newerAttemptId = "8c000000-0000-4000-8000-000000000001";
    const newerSessionId = "8d000000-0000-4000-8000-000000000001";
    await db.insert(attempt).values({ id: newerAttemptId, userId: LEARNER_ID, kind: "retake", attemptNumber: 2, status: "graded", passed: false, policyVersion: form.policyVersion, contentVersion: form.contentVersion });
    await db.insert(examSession).values({ id: newerSessionId, attemptId: newerAttemptId, userId: LEARNER_ID, status: "graded", disconnectedSeconds: 90 });
    await db.insert(response).values([
      { attemptId: newerAttemptId, itemKey: BLUEPRINT_RESPONSE_KEY, revision: 1, answer: { snapshot: { ...form, formId: "8e000000-0000-4000-8000-000000000001", seed: "newer" } }, source: "server" },
      { attemptId: newerAttemptId, itemKey: RESULT_RESPONSE_KEY, revision: 1, answer: { result: {
        schemaVersion: 1, gradingStatus: "graded", outcome: "NOT_PASSED", officialScorePercent: 50,
        earnedPoints: 50, possiblePoints: 100, pendingReviewItemIds: [], failedCriticalClusters: [],
        masteryBlockingCodingItems: [], compilationGatePassed: true, infrastructureFailure: false,
        finalizedAt: "2026-07-12T11:00:00.000Z", finalizedBy: "deadline", policyVersion: form.policyVersion,
        remediation: { required: true, targets: ["cluster.two"] },
      } }, source: "server" },
    ]);
    await expect(issueExamReexamGrant({
      ...input,
      requestId: "8a000000-0000-4000-8000-000000000002",
    })).rejects.toMatchObject({ code: "REEXAM_SOURCE_NOT_CURRENT" });
  });

  it("keeps grant issuance in module-before-attempt lock order with concurrent exam admission", async () => {
    const attemptId = "a7000000-0000-4000-8000-000000000001";
    const sessionId = "a8000000-0000-4000-8000-000000000001";
    const form = fullForm("a9000000-0000-4000-8000-000000000001");
    await db.insert(attempt).values({
      id: attemptId,
      userId: LEARNER_ID,
      kind: "exam",
      status: "graded",
      passed: false,
      policyVersion: form.policyVersion,
      contentVersion: form.contentVersion,
    });
    await db.insert(examSession).values({
      id: sessionId,
      attemptId,
      userId: LEARNER_ID,
      status: "graded",
      disconnectedSeconds: 90,
      integrityReviewState: "not_required",
    });
    await db.insert(response).values([
      {
        attemptId,
        itemKey: BLUEPRINT_RESPONSE_KEY,
        revision: 1,
        answer: { snapshot: form },
        source: "server",
      },
      {
        attemptId,
        itemKey: RESULT_RESPONSE_KEY,
        revision: 1,
        answer: { result: {
          schemaVersion: 1,
          gradingStatus: "graded",
          outcome: "NOT_PASSED",
          officialScorePercent: 50,
          earnedPoints: 50,
          possiblePoints: 100,
          pendingReviewItemIds: [],
          failedCriticalClusters: [],
          masteryBlockingCodingItems: [],
          compilationGatePassed: true,
          infrastructureFailure: false,
          finalizedAt: "2026-07-12T10:00:00.000Z",
          finalizedBy: "deadline",
          policyVersion: form.policyVersion,
          remediation: { required: true, targets: ["cluster.two"] },
          masteryRecheck: { required: false, clusterIds: [], codingItemIds: [] },
        } },
        source: "server",
      },
    ]);

    const blocker = await pool.connect();
    let grantPromise: ReturnType<typeof issueExamReexamGrant> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query("set local lock_timeout = '3s'");
      const blockerPid = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
      await blocker.query("select pg_advisory_xact_lock(hashtext($1))", [
        `exam:${LEARNER_ID}:${form.moduleId}`,
      ]);
      grantPromise = issueExamReexamGrant({
        actorUserId: ADMIN_ID,
        sourceExamSessionId: sessionId,
        requestId: "aa000000-0000-4000-8000-000000000001",
        reason: "A concurrent module admission must not deadlock reviewed outage grant issuance.",
      });
      await waitForAdvisoryWaitHeldBy(blockerPid.rows[0]!.pid);
      await expect(blocker.query(
        "select id from attempt where id = $1 for update",
        [attemptId],
      )).resolves.toMatchObject({ rowCount: 1 });
      await blocker.query("commit");
      await expect(grantPromise).resolves.toMatchObject({ status: "available", replayed: false });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await grantPromise?.catch(() => undefined);
    }
  });

  it("refuses to bypass pending review or a protected mastered result", async () => {
    const cases = [
      {
        suffix: "1", moduleId: "pending.module", sessionStatus: "under_review",
        attemptStatus: "grading", passed: null, gradingStatus: "pending-review",
        outcome: "PENDING_REVIEW", expected: "PENDING_REVIEW_CANNOT_BE_BYPASSED",
      },
      {
        suffix: "2", moduleId: "mastered.module", sessionStatus: "graded",
        attemptStatus: "graded", passed: true, gradingStatus: "graded",
        outcome: "MASTERED", expected: "PASS_ALREADY_PROTECTED",
      },
    ] as const;
    for (const item of cases) {
      const attemptId = `9${item.suffix}000000-0000-4000-8000-000000000001`;
      const sessionId = `9${item.suffix}000000-0000-4000-8000-000000000002`;
      const form = { ...fullForm(`9${item.suffix}000000-0000-4000-8000-000000000003`), moduleId: item.moduleId };
      await db.insert(attempt).values({ id: attemptId, userId: LEARNER_ID, kind: "exam", status: item.attemptStatus, passed: item.passed, policyVersion: form.policyVersion, contentVersion: form.contentVersion });
      await db.insert(examSession).values({ id: sessionId, attemptId, userId: LEARNER_ID, status: item.sessionStatus, disconnectedSeconds: 90 });
      await db.insert(response).values([
        { attemptId, itemKey: BLUEPRINT_RESPONSE_KEY, revision: 1, answer: { snapshot: form }, source: "server" },
        { attemptId, itemKey: RESULT_RESPONSE_KEY, revision: 1, answer: { result: {
          schemaVersion: 1, gradingStatus: item.gradingStatus, outcome: item.outcome,
          officialScorePercent: item.outcome === "MASTERED" ? 100 : null,
          earnedPoints: item.outcome === "MASTERED" ? 100 : null, possiblePoints: 100,
          pendingReviewItemIds: item.outcome === "PENDING_REVIEW" ? ["q1"] : [],
          failedCriticalClusters: [], masteryBlockingCodingItems: [], compilationGatePassed: true,
          infrastructureFailure: false, finalizedAt: "2026-07-12T12:00:00.000Z",
          finalizedBy: "deadline", policyVersion: form.policyVersion,
          remediation: { required: false, targets: [] },
        } }, source: "server" },
      ]);
      await expect(issueExamReexamGrant({
        actorUserId: ADMIN_ID, sourceExamSessionId: sessionId,
        requestId: `9${item.suffix}000000-0000-4000-8000-000000000004`,
        reason: "Durable server evidence was reviewed, but authoritative outcome policy must prevail.",
      })).rejects.toMatchObject({ code: item.expected });
    }
  });
});
