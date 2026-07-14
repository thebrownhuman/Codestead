import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import {
  activity,
  concept,
  conceptMastery,
  course,
  courseModule,
  courseVersion,
  curriculumArtifact,
  curriculumPublicationPointer,
  curriculumReviewEvent,
  enrollment,
  lesson,
  masteryEvidence,
  planRevision,
  reviewSchedule,
  user,
} from "@/lib/db/schema";
import { DailyReviewService } from "@/lib/daily-review/service";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { DrizzleLearningStore } from "@/lib/learning-service/drizzle-store";
import { LearningService } from "@/lib/learning-service/service";

const LEARNER = "daily-review-learner";
const OTHER = "daily-review-other";
const REVIEWER = "daily-review-reviewer";
const ADMIN = "daily-review-admin";
const COURSE = "d1000000-0000-4000-8000-000000000001";
const VERSION = "d1000000-0000-4000-8000-000000000002";
const MODULE = "d1000000-0000-4000-8000-000000000003";
const ENROLLMENT = "d1000000-0000-4000-8000-000000000004";
const OTHER_ENROLLMENT = "d1000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-07-13T08:00:00.000Z");
const SKILLS = [
  "python.collections.aliasing",
  "python.collections.dict-set",
  "python.collections.list-tuple",
  "python.collections.text",
  "python.control.iteration",
  "python.control.selection",
] as const;

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Daily review integration requires the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  if (names) await pool.query(`truncate table ${names} restart identity cascade`);
}

function reviewedBank(skillId: string, itemId: string): Record<string, unknown> {
  return {
    $schema: "../../schema/assessment-bank.schema.json",
    format: "assessment-bank",
    schemaVersion: "1.0.0",
    id: `bank.${skillId}.v1`,
    courseId: "python",
    courseVersion: "1.0.0",
    moduleId: "python.review",
    skillId,
    title: `${skillId} reviewed daily bank`,
    publication: {
      stage: "approved",
      author: { id: "integration-human-author", displayName: "Integration Human Author", kind: "human" },
      authoredAt: "2026-07-12T09:00:00.000Z",
      aiAssisted: false,
      reviewer: {
        id: REVIEWER,
        displayName: "Integration Human Reviewer",
        kind: "human",
        reviewedAt: "2026-07-12T10:00:00.000Z",
        reviewVersion: "1.0.0",
      },
      changeSummary: "Synthetic deterministic daily-review fixture independently reviewed by a human.",
    },
    sourceRefs: ["python-tutorial"],
    items: [{
      id: itemId,
      skillId,
      title: `Check ${skillId}`,
      kind: "mcq",
      prompt: "Which option is the reviewed answer?",
      points: 1,
      evidenceLevel: "apply",
      examEligibility: {
        eligible: true,
        rationale: "The deterministic answer oracle was independently reviewed for this disposable integration fixture.",
      },
      hints: ["Recall the reviewed rule before selecting."],
      feedback: { correct: "Correct reviewed answer.", incorrect: "Revisit the reviewed rule." },
      rubric: {
        passPoints: 1,
        criteria: [{ id: "reviewed-choice", description: "Selects the reviewed deterministic answer.", points: 1, critical: true }],
      },
      privateAuthorNotes: ["Synthetic answer oracle used only in the disposable integration database."],
      options: [{ id: "a", text: "Reviewed answer" }, { id: "b", text: "Distractor" }],
      answer: { correctOptionIds: ["a"], explanation: "A is the independently reviewed answer." },
    }],
  };
}

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values([
    { id: LEARNER, publicId: "d2000000-0000-4000-8000-000000000001", name: "Daily Learner", email: "daily@integration.invalid", role: "learner", status: "active", timezone: "Asia/Kolkata" },
    { id: OTHER, publicId: "d2000000-0000-4000-8000-000000000002", name: "Other Learner", email: "daily-other@integration.invalid", role: "learner", status: "active", timezone: "UTC" },
    { id: REVIEWER, publicId: "d2000000-0000-4000-8000-000000000003", name: "Human Reviewer", email: "daily-reviewer@integration.invalid", role: "learner", status: "active", timezone: "UTC" },
    { id: ADMIN, publicId: "d2000000-0000-4000-8000-000000000004", name: "Daily Admin", email: "daily-admin@integration.invalid", role: "admin", status: "active", timezone: "UTC" },
  ]);
  await db.insert(course).values({ id: COURSE, slug: "python", title: "Python", summary: "Daily review integration course.", domain: "programming" });
  await db.insert(courseVersion).values({ id: VERSION, courseId: COURSE, version: "1.0.0", stage: "beta", scopeStatement: "Disposable reviewed daily questions.", contentHash: "d".repeat(64) });
  await db.insert(courseModule).values({ id: MODULE, courseVersionId: VERSION, slug: "python-review", title: "Python review", objective: "Exercise reviewed concepts.", position: 1, estimatedMinutes: 60 });
  await db.insert(enrollment).values({ id: ENROLLMENT, userId: LEARNER, courseVersionId: VERSION, status: "active" });
  await db.insert(curriculumPublicationPointer).values({
    courseId: COURSE,
    currentCourseVersionId: VERSION,
    updatedBy: REVIEWER,
    reason: "Publish the independently reviewed disposable daily-review fixture.",
  });

  for (let index = 1; index <= 6; index += 1) {
    const conceptId = `d3000000-0000-4000-8000-00000000000${index}`;
    const lessonId = `d4000000-0000-4000-8000-00000000000${index}`;
    const activityId = `d5000000-0000-4000-8000-00000000000${index}`;
    const artifactId = `d6000000-0000-4000-8000-00000000000${index}`;
    const skillId = SKILLS[index - 1]!;
    const itemId = `${skillId}.mcq.a`;
    const hash = index.toString(16).repeat(64);
    await db.insert(concept).values({ id: conceptId, slug: skillId, title: `Review skill ${index}`, domain: "programming", description: `Reviewed concept ${index}.` });
    await db.insert(lesson).values({ id: lessonId, moduleId: MODULE, slug: `review-skill-${index}`, title: `Review skill ${index}`, objective: `Recall reviewed skill ${index}.`, estimatedMinutes: 10, difficulty: "beginner", position: index, contentStatus: "beta" });
    await db.insert(curriculumArtifact).values({
      id: artifactId,
      courseVersionId: VERSION,
      artifactKey: `bank.${skillId}.v1`,
      artifactType: "assessment_bank",
      skillKey: skillId,
      sourcePath: `integration/${skillId}.json`,
      content: reviewedBank(skillId, itemId),
      contentHash: hash,
      publicationStage: "published",
      aiAssisted: false,
      provenance: { fixture: "daily-review-integration" },
      reviewStatus: "approved",
      rowVersion: 2,
    });
    await db.insert(curriculumReviewEvent).values({
      artifactId,
      reviewerUserId: REVIEWER,
      reviewerKind: "human",
      decision: "approved",
      requestId: `d7000000-0000-4000-8000-00000000000${index}`,
      contentHash: hash,
      checklist: { technical: true, pedagogy: true, accessibility: true },
      reviewedItemIds: [itemId],
      reason: "Independently reviewed deterministic daily-review question fixture.",
      resultingVersion: 2,
    });
    await db.insert(activity).values({
      id: activityId,
      lessonId,
      conceptId,
      slug: itemId,
      type: "quiz-mcq",
      instructions: "Select the reviewed answer.",
      specification: {
        kind: "mcq",
        authoredItemId: itemId,
        itemKey: itemId,
        title: `Check review skill ${index}`,
        prompt: "Which option is the reviewed answer?",
        options: [{ id: "a", text: "Reviewed answer" }, { id: "b", text: "Distractor" }],
        grading: { kind: "choice", acceptedAnswers: ["a"] },
        feedback: { correct: "Correct reviewed answer.", incorrect: "Revisit the reviewed rule." },
      },
      difficulty: "beginner",
      maxPoints: 1,
    });
    await db.insert(conceptMastery).values({
      userId: LEARNER,
      enrollmentId: ENROLLMENT,
      conceptId,
      languageContext: "conceptual",
      score: 0.5,
      confidence: [0.9, 0.8, 0.1, 0.2, 0.3, 0.95][index - 1],
      status: index === 2 ? "needs_review" : "practicing",
      policyVersion: "adaptive-learning-v1",
      lastEvidenceAt: new Date(`2026-07-0${index}T08:00:00.000Z`),
      nextReviewAt: index === 2 ? new Date("2026-07-10T08:00:00.000Z") : null,
    });
    if (index === 1) {
      for (let failure = 1; failure <= 2; failure += 1) {
        await db.insert(masteryEvidence).values({
          id: randomUUID(),
          userId: LEARNER,
          enrollmentId: ENROLLMENT,
          conceptId,
          languageContext: "conceptual",
          evidenceType: JSON.stringify({
            version: 1,
            origin: "deterministic_spec",
            skillId,
            itemVariantId: `${itemId}.failure-${failure}`,
            evidenceLevel: "E3",
            assistanceLevel: "A0",
            correct: false,
            learningOpportunity: false,
            solutionRevealed: false,
            misconceptionTags: ["daily.review.confirmed"],
            languageContext: "conceptual",
          }),
          sourceType: "deterministic_attempt",
          sourceId: `${itemId}.failure-${failure}`,
          score: 0,
          weight: 1,
          validity: "valid",
          policyVersion: "adaptive-learning-v1",
          recordedAt: new Date(`2026-07-${String(failure + 1).padStart(2, "0")}T08:00:00.000Z`),
        });
      }
    }
    if (index === 2) {
      await db.insert(reviewSchedule).values({
        userId: LEARNER,
        enrollmentId: ENROLLMENT,
        conceptId,
        dueAt: new Date("2026-07-10T08:00:00.000Z"),
        intervalDays: 3,
        reason: "review_due",
        status: "scheduled",
      });
    }
  }
  await db.insert(planRevision).values({
    enrollmentId: ENROLLMENT,
    revision: 1,
    source: "admin",
    reason: "Publish the reviewed integration learning path.",
    policyVersion: "adaptive-learning-v1",
    createdBy: ADMIN,
    plan: SKILLS.map((skillId, position) => ({
      schemaVersion: 1,
      id: `daily-plan-${position + 1}`,
      kind: "learn",
      trackId: "python",
      courseVersion: "1.0.0",
      moduleId: "python.review",
      skillId,
      title: `Review skill ${position + 1}`,
      position: position + 1,
      required: true,
      prerequisites: [],
      evidenceTypes: ["quiz"],
      languageContext: "conceptual",
      goalPriority: 1,
      prerequisiteCentrality: 0,
    })),
  });
});

afterAll(async () => {
  await pool.end();
});

describe("daily review PostgreSQL journey", () => {
  it("rejects an official checkpoint outside the unlocked latest plan", async () => {
    await db.insert(planRevision).values({
      enrollmentId: ENROLLMENT,
      revision: 2,
      source: "admin",
      reason: "Require the first reviewed skill before the second.",
      policyVersion: "adaptive-learning-v1",
      createdBy: ADMIN,
      plan: SKILLS.slice(0, 2).map((skillId, position) => ({
        schemaVersion: 1,
        id: `gated-plan-${position + 1}`,
        kind: "learn",
        trackId: "python",
        courseVersion: "1.0.0",
        moduleId: "python.review",
        skillId,
        title: `Gated skill ${position + 1}`,
        position: position + 1,
        required: true,
        prerequisites: position === 1 ? [SKILLS[0]] : [],
        evidenceTypes: ["quiz"],
        languageContext: "conceptual",
        goalPriority: 1,
        prerequisiteCentrality: 0,
      })),
    });
    const learning = new LearningService({ store: new DrizzleLearningStore(), now: () => NOW });

    await expect(learning.createAttempt({
      userId: LEARNER,
      idempotencyKey: "locked-topic-checkpoint-0001",
      skillId: SKILLS[1]!,
      kind: "quiz",
    })).resolves.toMatchObject({ state: "degraded", reason: "activity_unavailable" });

    const prerequisiteConcept = await db.select({ id: concept.id }).from(concept)
      .where(eq(concept.slug, SKILLS[0]!)).limit(1);
    await db.update(conceptMastery).set({ status: "proficient" }).where(and(
      eq(conceptMastery.userId, LEARNER),
      eq(conceptMastery.enrollmentId, ENROLLMENT),
      eq(conceptMastery.conceptId, prerequisiteConcept[0]!.id),
    ));
    await expect(learning.createAttempt({
      userId: LEARNER,
      idempotencyKey: "unlocked-topic-checkpoint-0001",
      skillId: SKILLS[1]!,
      kind: "quiz",
    })).resolves.toMatchObject({ state: "ready", attempt: { kind: "quiz" } });
  });

  it("selects only a current human-reviewed MCQ for an owner-bound topic checkpoint and replays evidence idempotently", async () => {
    const learning = new LearningService({ store: new DrizzleLearningStore(), now: () => NOW });
    const skillId = SKILLS[0]!;
    const first = await learning.createAttempt({
      userId: LEARNER,
      idempotencyKey: "topic-checkpoint-integration-0001",
      skillId,
      kind: "quiz",
    });
    expect(first).toMatchObject({
      state: "ready",
      idempotent: false,
      attempt: { kind: "quiz", attemptNumber: 1 },
    });
    expect(first.activity?.specification).toMatchObject({
      kind: "mcq",
      authoredItemId: `${skillId}.mcq.a`,
    });

    const replayedCreation = await learning.createAttempt({
      userId: LEARNER,
      idempotencyKey: "topic-checkpoint-integration-0001",
      skillId,
      kind: "quiz",
    });
    expect(replayedCreation).toMatchObject({
      state: "ready",
      idempotent: true,
      attempt: { id: first.attempt!.id },
    });
    await expect(learning.createAttempt({
      userId: OTHER,
      idempotencyKey: "topic-checkpoint-other-0001",
      skillId,
      kind: "quiz",
    })).resolves.toMatchObject({
      state: "degraded",
      reason: "activity_unavailable",
      attempt: null,
    });

    const submission = {
      itemKey: `${skillId}.mcq.a`,
      responseRevision: 1,
      answer: { value: "a" },
      assistanceLevel: "A0" as const,
      solutionRevealed: false,
      submittedAt: NOW,
    };
    const graded = await learning.submitAttempt(LEARNER, first.attempt!.id, submission);
    expect(graded).toMatchObject({
      state: "graded",
      passed: true,
      officialEvidenceRecorded: true,
    });
    const replayedSubmission = await learning.submitAttempt(LEARNER, first.attempt!.id, submission);
    expect(replayedSubmission).toMatchObject({
      state: "graded",
      passed: true,
      officialEvidenceRecorded: true,
      idempotent: true,
    });
    const evidence = await pool.query<{ count: string }>(
      `select count(*)::text count from mastery_evidence where user_id = $1 and source_id = $2`,
      [LEARNER, first.attempt!.id],
    );
    expect(evidence.rows[0]?.count).toBe("1");

    const fresh = await learning.createAttempt({
      userId: LEARNER,
      idempotencyKey: "topic-checkpoint-integration-0002",
      skillId,
      kind: "quiz",
    });
    expect(fresh).toMatchObject({
      state: "ready",
      idempotent: false,
      attempt: { kind: "quiz", attemptNumber: 2 },
    });
  });

  it("allocates one stable human-reviewed daily five, enforces ownership, and completes through the existing grader", async () => {
    const learning = new LearningService({ store: new DrizzleLearningStore(), now: () => NOW });
    const daily = new DailyReviewService(pool, learning, () => NOW);

    const first = await daily.initialize(LEARNER);
    expect(first).toMatchObject({ state: "ready", localDate: "2026-07-13", session: { questionCount: 5, completedCount: 0 } });
    expect(first.session?.items.map((item) => item.skillId)).toEqual([
      "python.collections.aliasing",
      "python.collections.dict-set",
      "python.collections.list-tuple",
      "python.collections.text",
      "python.control.iteration",
    ]);
    expect(first.session?.items.map((item) => item.priorityReason)).toEqual([
      "confirmed_misconception",
      "overdue_review",
      "lowest_confidence",
      "lowest_confidence",
      "lowest_confidence",
    ]);

    const replay = await daily.initialize(LEARNER);
    expect(replay.session?.id).toBe(first.session?.id);
    expect(replay.session?.items.map((item) => item.id)).toEqual(first.session?.items.map((item) => item.id));

    const unavailable = await daily.initialize(OTHER);
    expect(unavailable).toMatchObject({
      state: "unavailable",
      session: { availableItemCount: 0, questionCount: 0, completedCount: 0, items: [] },
    });

    await db.insert(enrollment).values({
      id: OTHER_ENROLLMENT,
      userId: OTHER,
      courseVersionId: VERSION,
      status: "active",
    });
    await db.insert(conceptMastery).values([1, 2, 3, 4, 5].map((index) => ({
      userId: OTHER,
      enrollmentId: OTHER_ENROLLMENT,
      conceptId: `d3000000-0000-4000-8000-00000000000${index}`,
      languageContext: "conceptual",
      score: 0.4,
      confidence: index / 10,
      status: "practicing" as const,
      policyVersion: "adaptive-learning-v1",
      lastEvidenceAt: new Date(`2026-07-0${index}T08:00:00.000Z`),
    })));
    const unlocked = await daily.initialize(OTHER);
    expect(unlocked).toMatchObject({
      state: "ready",
      session: { id: unavailable.session?.id, availableItemCount: 5, questionCount: 5, completedCount: 0 },
    });
    expect(unlocked.session?.items).toHaveLength(5);

    await expect(daily.startItem(OTHER, first.session!.id, first.session!.items[0].id)).rejects.toMatchObject({ code: "DAILY_REVIEW_ITEM_NOT_FOUND" });
    await expect(pool.query(
      `update daily_review_item set user_id = $1 where id = $2`,
      [OTHER, first.session!.items[0].id],
    )).rejects.toMatchObject({ code: "23503" });

    for (const reviewItem of first.session!.items) {
      const created = await daily.startItem(LEARNER, first.session!.id, reviewItem.id);
      expect(created).toMatchObject({ state: "ready", attempt: { kind: "quiz" } });
      expect(JSON.stringify(created)).not.toMatch(/acceptedAnswers|grading|reviewedItemIds|privateAuthorNotes/);
      const submitted = await learning.submitAttempt(LEARNER, created.attempt!.id, {
        itemKey: created.activity!.specification.itemKey,
        responseRevision: 1,
        answer: { value: "a" },
        assistanceLevel: "A0",
        solutionRevealed: false,
        submittedAt: NOW,
      });
      expect(submitted).toMatchObject({ state: "graded", passed: true, officialEvidenceRecorded: true });
    }

    const completed = await daily.get(LEARNER);
    expect(completed).toMatchObject({ state: "completed", session: { completedCount: 5, questionCount: 5 } });
    expect(completed.session?.items.every((item) => item.status === "answered" && item.passed)).toBe(true);
  });

  it("exports deletion counts and erases an attempt-bound daily allocation before its source attempt", async () => {
    const learning = new LearningService({ store: new DrizzleLearningStore(), now: () => NOW });
    const daily = new DailyReviewService(pool, learning, () => NOW);
    const allocated = await daily.initialize(LEARNER);
    const firstItem = allocated.session!.items[0]!;
    const created = await daily.startItem(LEARNER, allocated.session!.id, firstItem.id);
    await learning.submitAttempt(LEARNER, created.attempt!.id, {
      itemKey: created.activity!.specification.itemKey,
      responseRevision: 1,
      answer: { value: "a" },
      assistanceLevel: "A0",
      solutionRevealed: false,
      submittedAt: NOW,
    });

    const previousKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.DELETION_TOMBSTONE_KEY = "daily-review-integration-tombstone-key-long-enough";
    try {
      const report = await deleteLearnerAccount({
        actorUserId: ADMIN,
        learnerId: LEARNER,
        requestId: "d8000000-0000-4000-8000-000000000001",
        reason: "Learner confirmed permanent deletion of daily review evidence.",
        now: NOW,
      });
      expect(report.deletedRows).toMatchObject({
        dailyReviewItems: 5,
        dailyReviewSessions: 1,
        attempts: 1,
      });
      const remaining = await pool.query<{ sessions: string; items: string; attempts: string }>(
        `select
          (select count(*)::text from daily_review_session where user_id = $1) sessions,
          (select count(*)::text from daily_review_item where user_id = $1) items,
          (select count(*)::text from attempt where user_id = $1) attempts`,
        [LEARNER],
      );
      expect(remaining.rows[0]).toEqual({ sessions: "0", items: "0", attempts: "0" });
    } finally {
      if (previousKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousKey;
    }
  });
});
