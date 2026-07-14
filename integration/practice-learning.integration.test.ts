import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { db, pool } from "@/lib/db/client";
import {
  activity,
  attempt,
  concept,
  course,
  courseModule,
  courseVersion,
  curriculumArtifact,
  enrollment,
  learnerProfile,
  learningSession,
  lesson,
  masteryEvidence,
  planRevision,
  practiceHelpEvent,
  response,
  user,
} from "@/lib/db/schema";
import { DrizzleLearningStore } from "@/lib/learning-service/drizzle-store";
import { decodeEvidenceEnvelope } from "@/lib/learning-service/evidence-engine";
import { toLearnerAttemptCreationPayload } from "@/lib/learning-service/learner-activity";
import { LearningService } from "@/lib/learning-service/service";

const LEARNER = "practice-integration-learner";
const OTHER = "practice-integration-other";
const COURSE = "a1000000-0000-4000-8000-000000000001";
const VERSION = "a1000000-0000-4000-8000-000000000002";
const MODULE = "a1000000-0000-4000-8000-000000000003";
const CONCEPT = "a1000000-0000-4000-8000-000000000004";
const LESSON = "a1000000-0000-4000-8000-000000000005";
const ACTIVITY = "a1000000-0000-4000-8000-000000000006";
const ENROLLMENT = "a1000000-0000-4000-8000-000000000007";

const REVIEWED_BANK = {
  $schema: "../../schema/assessment-bank.schema.json",
  format: "assessment-bank",
  schemaVersion: "1.0.0",
  id: "bank.python.toolchain.repl.integration",
  courseId: "python",
  courseVersion: "1.0.0",
  moduleId: "python.toolchain",
  skillId: "python.toolchain.repl",
  title: "Reviewed integration REPL check",
  publication: {
    stage: "approved",
    author: { id: "integration-human-author", displayName: "Integration Human Author", kind: "human" },
    authoredAt: "2026-07-12T09:00:00.000Z",
    aiAssisted: false,
    reviewer: {
      id: "integration-human-reviewer",
      displayName: "Integration Human Reviewer",
      kind: "human",
      reviewedAt: "2026-07-12T09:30:00.000Z",
      reviewVersion: "1.0.0",
    },
    changeSummary: "Synthetic deterministic fixture independently reviewed for this disposable integration test.",
  },
  sourceRefs: ["py-tutorial"],
  items: [{
    id: "python-repl-practice-a",
    skillId: "python.toolchain.repl",
    title: "Observe one expression",
    kind: "trace",
    prompt: "What value is displayed after evaluating 40 + 2?",
    points: 1,
    evidenceLevel: "apply",
    examEligibility: {
      eligible: true,
      rationale: "The exact arithmetic oracle was independently reviewed for the disposable integration fixture.",
    },
    hints: ["Evaluate the addition before thinking about display formatting."],
    feedback: {
      correct: "The expression evaluates to 42, so the REPL displays 42.",
      incorrect: "A REPL displays the evaluated expression value even without print().",
    },
    rubric: {
      passPoints: 1,
      criteria: [{
        id: "exact-value",
        description: "Records the exact deterministic result of the arithmetic expression.",
        points: 1,
        critical: true,
      }],
    },
    privateAuthorNotes: ["Synthetic arithmetic oracle used only in the disposable database."],
    artifact: ["40 + 2"],
    answer: {
      acceptedTraces: ["42"],
      caseSensitive: true,
      explanation: "Forty plus two evaluates deterministically to forty-two.",
    },
  }],
} as const;

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Practice integration requires the disposable learncoding_integration database.");
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
      id: LEARNER,
      publicId: "a2000000-0000-4000-8000-000000000001",
      name: "Practice Learner",
      email: "practice@integration.invalid",
      role: "learner",
      status: "active",
    },
    {
      id: OTHER,
      publicId: "a2000000-0000-4000-8000-000000000002",
      name: "Other Learner",
      email: "practice-other@integration.invalid",
      role: "learner",
      status: "active",
    },
  ]);
  await db.insert(learnerProfile).values([{ userId: LEARNER }, { userId: OTHER }]);
  await db.insert(course).values({
    id: COURSE,
    slug: "python",
    title: "Python",
    summary: "Synthetic reviewed practice fixture.",
    domain: "programming",
  });
  await db.insert(courseVersion).values({
    id: VERSION,
    courseId: COURSE,
    version: "practice-reviewed-v1",
    stage: "beta",
    scopeStatement: "Synthetic reviewed integration activity only.",
    contentHash: "practice-reviewed-content-hash",
  });
  await db.insert(courseModule).values({
    id: MODULE,
    courseVersionId: VERSION,
    slug: "python-toolchain",
    title: "Python toolchain",
    objective: "Practice one reviewed deterministic prompt.",
    position: 1,
    estimatedMinutes: 10,
  });
  await db.insert(concept).values({
    id: CONCEPT,
    slug: "python.toolchain.repl",
    title: "Interactive interpreter",
    domain: "programming",
    description: "Synthetic reviewed concept.",
    critical: true,
  });
  await db.insert(curriculumArtifact).values({
    id: "a1000000-0000-4000-8000-000000000008",
    courseVersionId: VERSION,
    artifactKey: REVIEWED_BANK.id,
    artifactType: "assessment_bank",
    skillKey: "python.toolchain.repl",
    sourcePath: "integration/reviewed-python-repl-bank.json",
    content: REVIEWED_BANK,
    contentHash: "a".repeat(64),
    publicationStage: "approved",
    aiAssisted: false,
    provenance: { fixture: "synthetic-reviewed-practice-integration" },
    reviewStatus: "approved",
  });
  await db.insert(lesson).values({
    id: LESSON,
    moduleId: MODULE,
    slug: "python-repl-reviewed",
    title: "Reviewed REPL lesson",
    objective: "Distinguish a REPL expression from printed output.",
    estimatedMinutes: 10,
    difficulty: "beginner",
    position: 1,
    contentStatus: "beta",
  });
  await db.insert(activity).values({
    id: ACTIVITY,
    lessonId: LESSON,
    conceptId: CONCEPT,
    slug: "python-repl-practice-a",
    type: "practice-short-answer",
    instructions: "Enter the exact observed expression result.",
    specification: {
      kind: "short-answer",
      authoredItemId: "python-repl-practice-a",
      itemKey: "python-repl-practice-a",
      title: "Observe one expression",
      prompt: "What value is displayed after evaluating 40 + 2?",
      hints: ["Evaluate the addition before thinking about display formatting."],
      alternateExplanation: "A REPL displays the value of the expression you enter.",
      workedExample: "Evaluating 1 + 1 displays 2.",
      grading: {
        kind: "exact",
        acceptedAnswers: ["42"],
        misconceptions: [{ tag: "repl.print-confusion", answers: ["nothing", "no output"] }],
      },
      feedback: {
        correct: "The expression evaluates to 42, so the REPL displays 42.",
        incorrect: "A REPL displays the evaluated expression value even without print().",
      },
      remediation: [{
        tag: "repl.print-confusion",
        explanation: "Expression display and print output are separate REPL behaviors.",
        retryPrompt: "Evaluate the expression first; then state what the REPL displays.",
      }],
      solutionReveal: {
        answer: "42",
        explanation: "Addition is evaluated and its value is displayed by the REPL.",
      },
      hiddenTests: [{ expected: "must never cross learner boundary" }],
      referenceSolution: "private author answer",
    },
    difficulty: "beginner",
    maxPoints: 1,
  });
  await db.insert(enrollment).values({
    id: ENROLLMENT,
    userId: LEARNER,
    courseVersionId: VERSION,
    status: "active",
  });
});

afterAll(async () => {
  await pool.end();
});

describe("persisted reviewed practice PostgreSQL journey", () => {
  it("serializes concurrent attempt replay and allocates distinct attempt numbers", async () => {
    const service = new LearningService({
      store: new DrizzleLearningStore(),
      now: () => new Date("2026-07-12T09:55:00.000Z"),
    });
    const replayInput = {
      userId: LEARNER,
      idempotencyKey: "practice-concurrent-replay-0001",
      skillId: "python.toolchain.repl",
      kind: "practice" as const,
    };
    const replayed = await Promise.all([
      service.createAttempt(replayInput),
      service.createAttempt(replayInput),
    ]);
    expect(new Set(replayed.map((result) => result.attempt?.id))).toHaveProperty("size", 1);
    expect(replayed.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(replayed.map((result) => result.attempt?.attemptNumber)).toEqual([1, 1]);

    const distinct = await Promise.all(
      Array.from({ length: 8 }, (_, index) => service.createAttempt({
        ...replayInput,
        idempotencyKey: `practice-concurrent-distinct-${String(index).padStart(4, "0")}`,
      })),
    );
    expect(distinct.map((result) => result.attempt?.attemptNumber).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    const rows = await db.select().from(attempt).where(eq(attempt.userId, LEARNER));
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((row) => row.attemptNumber))).toHaveProperty("size", 9);
  });

  it("serializes deterministic session starts and keeps only one active session", async () => {
    const service = new LearningService({
      store: new DrizzleLearningStore(),
      now: () => new Date("2026-07-12T09:56:00.000Z"),
    });
    const input = {
      userId: LEARNER,
      idempotencyKey: "session-concurrent-replay-0001",
      enrollmentId: ENROLLMENT,
      goal: "Practice the reviewed REPL checkpoint",
      plannedMinutes: 25,
    };
    const replayed = await Promise.all([service.startSession(input), service.startSession(input)]);
    expect(new Set(replayed.map((result) => result.session.id))).toHaveProperty("size", 1);
    expect(replayed.map((result) => result.idempotent === true).sort()).toEqual([false, true]);

    const activeRace = await Promise.all([
      service.startSession({ ...input, idempotencyKey: "session-concurrent-distinct-0001" }),
      service.startSession({ ...input, idempotencyKey: "session-concurrent-distinct-0002" }),
    ]);
    expect(activeRace.every((result) => result.session.id === replayed[0]!.session.id)).toBe(true);
    const sessions = await db.select().from(learningSession).where(eq(learningSession.userId, LEARNER));
    expect(sessions).toHaveLength(1);

    await expect(service.startSession({
      ...input,
      goal: "Reuse the same key for a different goal",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("serializes same-key plan replay and distinct-key plan revision numbers", async () => {
    const store = new DrizzleLearningStore();
    const item = {
      schemaVersion: 1 as const,
      id: "python.toolchain.repl:learn",
      kind: "learn" as const,
      trackId: "python",
      courseVersion: "practice-reviewed-v1",
      moduleId: "python.toolchain",
      skillId: "python.toolchain.repl",
      title: "Use the reviewed REPL",
      position: 1,
      required: true,
      prerequisites: [],
      evidenceTypes: ["quiz"],
      languageContext: "conceptual",
      goalPriority: 10,
      prerequisiteCentrality: 1,
    };
    const persist = (idempotencyKey: string, title = item.title) => store.transaction((transaction) =>
      transaction.persistPlan({
        userId: LEARNER,
        idempotencyKey,
        publication: {
          trackId: "python",
          courseVersionId: VERSION,
          version: "practice-reviewed-v1",
          stage: "beta",
        },
        draft: {
          trackId: "python",
          manifestVersion: "practice-reviewed-v1",
          implementationLanguage: null,
          prerequisiteTrackIds: [],
          items: [{ ...item, title }],
        },
      }));

    const replayed = await Promise.all([
      persist("plan-concurrent-replay-0001"),
      persist("plan-concurrent-replay-0001"),
    ]);
    expect(new Set(replayed.map((result) => result.revisionId))).toHaveProperty("size", 1);
    expect(replayed.map((result) => result.idempotent).sort()).toEqual([false, true]);
    expect(replayed.map((result) => result.revision)).toEqual([1, 1]);

    const distinct = await Promise.all([
      persist("plan-concurrent-distinct-0001"),
      persist("plan-concurrent-distinct-0002"),
    ]);
    expect(distinct.map((result) => result.revision).sort((a, b) => a - b)).toEqual([2, 3]);
    const revisions = await db.select().from(planRevision).where(eq(planRevision.enrollmentId, ENROLLMENT));
    expect(revisions.map((row) => row.revision).sort((a, b) => a - b)).toEqual([1, 2, 3]);

    await expect(persist("plan-concurrent-replay-0001", "A conflicting replay"))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("serializes DSA language revisions and rejects same-key parameter reuse", async () => {
    const dsaCourseId = "a3000000-0000-4000-8000-000000000001";
    const dsaVersionId = "a3000000-0000-4000-8000-000000000002";
    const dsaEnrollmentId = "a3000000-0000-4000-8000-000000000003";
    await db.insert(course).values({
      id: dsaCourseId,
      slug: "dsa",
      title: "Data structures and algorithms",
      summary: "Synthetic language-switch concurrency fixture.",
      domain: "computer-science",
    });
    await db.insert(courseVersion).values({
      id: dsaVersionId,
      courseId: dsaCourseId,
      version: "0.1.0",
      stage: "beta",
      scopeStatement: "Synthetic DSA language-switch fixture.",
      contentHash: "dsa-language-switch-concurrency",
    });
    await db.insert(enrollment).values({
      id: dsaEnrollmentId,
      userId: LEARNER,
      courseVersionId: dsaVersionId,
      implementationLanguage: "C++",
      status: "active",
    });
    const service = new LearningService({
      store: new DrizzleLearningStore(),
      now: () => new Date("2026-07-12T09:57:00.000Z"),
    });
    const input = {
      userId: LEARNER,
      language: "Python" as const,
      idempotencyKey: "dsa-concurrent-replay-0001",
    };
    const replayed = await Promise.all([
      service.switchDsaLanguage(input),
      service.switchDsaLanguage(input),
    ]);
    expect(replayed.map((result) => result.state).sort()).toEqual(["unchanged", "updated"]);
    expect(new Set(replayed.map((result) => result.revisionId))).toHaveProperty("size", 1);
    const revisions = await db.select().from(planRevision)
      .where(eq(planRevision.enrollmentId, dsaEnrollmentId));
    expect(revisions).toHaveLength(1);

    await expect(service.switchDsaLanguage({
      ...input,
      language: "Java",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("binds attempts to the owner, persists wrong/assisted/revealed work, and never awards practice mastery", async () => {
    const service = new LearningService({
      store: new DrizzleLearningStore(),
      now: () => new Date("2026-07-12T10:00:00.000Z"),
    });
    const first = await service.createAttempt({
      userId: LEARNER,
      idempotencyKey: "practice-pg-request-0001",
      skillId: "python.toolchain.repl",
      kind: "practice",
    });
    expect(first).toMatchObject({ state: "ready", idempotent: false, attempt: { attemptNumber: 1 } });
    const projected = toLearnerAttemptCreationPayload(first);
    expect(projected.state).toBe("ready");
    expect(projected.activity?.specification.prompt).toBe(REVIEWED_BANK.items[0].prompt);
    expect(JSON.stringify(projected)).not.toMatch(/acceptedAnswers|hiddenTests|referenceSolution|must never cross|private author/);

    // The attempt must continue to use the immutable reviewed artifact even
    // if a mutable materialized activity row is tampered with after creation.
    await db.update(activity).set({
      specification: {
        ...((await db.select({ specification: activity.specification }).from(activity)
          .where(eq(activity.id, ACTIVITY)).limit(1))[0]!.specification),
        prompt: "Forged prompt after attempt creation",
        grading: { kind: "exact", acceptedAnswers: ["forged"] },
      },
    }).where(eq(activity.id, ACTIVITY));

    await expect(service.createAttempt({
      userId: OTHER,
      idempotencyKey: "practice-pg-request-other",
      skillId: "python.toolchain.repl",
      kind: "practice",
    })).resolves.toMatchObject({ state: "degraded", reason: "activity_unavailable", attempt: null });

    const firstHelp = await service.revealNextPracticeHelp({
      userId: LEARNER,
      attemptId: first.attempt!.id,
      requestId: "b1000000-0000-4000-8000-000000000001",
    });
    expect(firstHelp).toMatchObject({
      state: "ready", helpStep: 1, assistanceLevel: "A1", solutionRevealed: false,
      help: { kind: "hint", content: "Evaluate the addition before thinking about display formatting." },
    });

    const wrong = await service.submitAttempt(LEARNER, first.attempt!.id, {
      itemKey: "python-repl-practice-a",
      responseRevision: 1,
      answer: { value: "nothing" },
      assistanceLevel: "A0",
      solutionRevealed: false,
      submittedAt: new Date("2026-07-12T10:01:00.000Z"),
    });
    expect(wrong).toMatchObject({
      state: "graded",
      passed: false,
      masteryAwarded: false,
      officialEvidenceRecorded: true,
      feedback: {
        correct: false,
        independent: false,
        misconceptionTags: [],
        remediation: [],
        nextAction: "retry_fresh",
      },
    });

    const second = await service.createAttempt({
      userId: LEARNER,
      idempotencyKey: "practice-pg-request-0002",
      skillId: "python.toolchain.repl",
      kind: "practice",
    });
    expect(second).toMatchObject({ state: "ready", attempt: { attemptNumber: 2 } });
    const correct = await service.submitAttempt(LEARNER, second.attempt!.id, {
      itemKey: "python-repl-practice-a",
      responseRevision: 1,
      answer: { value: "42" },
      assistanceLevel: "A4",
      solutionRevealed: true,
      submittedAt: new Date("2026-07-12T10:02:00.000Z"),
    });
    expect(correct).toMatchObject({
      state: "graded",
      passed: true,
      masteryAwarded: false,
      feedback: { correct: true, independent: true, nextAction: "continue" },
    });

    const third = await service.createAttempt({
      userId: LEARNER,
      idempotencyKey: "practice-pg-request-0003",
      skillId: "python.toolchain.repl",
      kind: "practice",
    });
    for (let index = 1; index <= 2; index += 1) {
      await service.revealNextPracticeHelp({
        userId: LEARNER,
        attemptId: third.attempt!.id,
        requestId: `b2000000-0000-4000-8000-00000000000${index}`,
      });
    }
    const revealed = await service.submitAttempt(LEARNER, third.attempt!.id, {
      itemKey: "python-repl-practice-a",
      responseRevision: 1,
      answer: { value: "" },
      assistanceLevel: "A0",
      solutionRevealed: false,
      submittedAt: new Date("2026-07-12T10:03:00.000Z"),
    });
    expect(revealed).toMatchObject({
      masteryAwarded: false,
      feedback: {
        independent: false,
        solutionRevealed: true,
        solution: { answer: "42" },
        nextAction: "retry_fresh",
      },
    });

    const attempts = await db.select().from(attempt).where(eq(attempt.userId, LEARNER));
    const responses = await db.select().from(response);
    const evidence = await db.select().from(masteryEvidence).where(eq(masteryEvidence.userId, LEARNER));
    const helpEvents = await db.select().from(practiceHelpEvent).where(eq(practiceHelpEvent.userId, LEARNER));
    expect(attempts).toHaveLength(3);
    expect(attempts.every((row) => row.status === "graded" && row.masteryAwarded === false)).toBe(true);
    expect(responses).toHaveLength(3);
    // The immutable reviewed bank is the sole runtime help authority. Its
    // trace item publishes one hint followed by the final solution; mutable
    // activity-only alternate/example text must not silently extend it.
    expect(helpEvents).toHaveLength(3);
    expect(attempts.find((row) => row.id === first.attempt!.id)).toMatchObject({ assistanceLevel: "A1", solutionRevealed: false, helpStep: 1 });
    expect(attempts.find((row) => row.id === second.attempt!.id)).toMatchObject({ assistanceLevel: "A0", solutionRevealed: false, helpStep: 0 });
    expect(attempts.find((row) => row.id === third.attempt!.id)).toMatchObject({ assistanceLevel: "A4", solutionRevealed: true, helpStep: 2 });
    expect(responses.map((row) => row.answer)).toEqual(expect.arrayContaining([
      { value: "nothing" }, { value: "42" }, { value: "" },
    ]));
    const envelopes = evidence.map((row) => decodeEvidenceEnvelope({
      id: row.id,
      skillId: "python.toolchain.repl",
      enrollmentId: row.enrollmentId,
      conceptId: row.conceptId,
      languageContext: row.languageContext,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      evidenceType: row.evidenceType,
      score: row.score,
      weight: row.weight,
      criticalCriterion: row.criticalCriterion,
      validity: row.validity,
      recordedBy: row.recordedBy,
      recordedAt: row.recordedAt,
    }));
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ assistanceLevel: "A1", solutionRevealed: false, correct: false }),
      expect.objectContaining({ assistanceLevel: "A0", solutionRevealed: false, correct: true }),
      expect.objectContaining({ assistanceLevel: "A4", solutionRevealed: true, correct: false }),
    ]));
  });

  it("serializes concurrent help, replays one request exactly, and preserves step order", async () => {
    const service = new LearningService({ store: new DrizzleLearningStore() });
    const created = await service.createAttempt({
      userId: LEARNER,
      idempotencyKey: "practice-concurrency-0001",
      skillId: "python.toolchain.repl",
      kind: "practice",
    });
    const sameRequest = {
      userId: LEARNER,
      attemptId: created.attempt!.id,
      requestId: "b3000000-0000-4000-8000-000000000001",
    };
    const sameResults = await Promise.all([
      service.revealNextPracticeHelp(sameRequest),
      service.revealNextPracticeHelp(sameRequest),
    ]);
    expect(sameResults.map((result) => result.helpStep)).toEqual([1, 1]);
    expect(sameResults.map((result) => result.idempotent).sort()).toEqual([false, true]);

    const concurrent = await Promise.all([
      service.revealNextPracticeHelp({ ...sameRequest, requestId: "b3000000-0000-4000-8000-000000000002" }),
      service.revealNextPracticeHelp({ ...sameRequest, requestId: "b3000000-0000-4000-8000-000000000003" }),
    ]);
    // Only one reviewed step remains. The row lock lets one request reveal
    // the solution and makes the other observe an exhausted ladder at the
    // same durable step instead of inventing unreviewed help.
    expect(concurrent.map((result) => result.helpStep).sort()).toEqual([2, 2]);
    expect(concurrent.map((result) => result.state).sort()).toEqual(["exhausted", "ready"]);
    const rows = await db.select().from(practiceHelpEvent).where(eq(practiceHelpEvent.attemptId, created.attempt!.id));
    expect(rows.map((row) => row.step).sort()).toEqual([1, 2]);
    const [stored] = await db.select().from(attempt).where(eq(attempt.id, created.attempt!.id));
    expect(stored).toMatchObject({ helpStep: 2, assistanceLevel: "A4", solutionRevealed: true });
  });

  it("rolls the attempt assistance update back if the durable help receipt cannot be inserted", async () => {
    const service = new LearningService({ store: new DrizzleLearningStore() });
    const created = await service.createAttempt({
      userId: LEARNER,
      idempotencyKey: "practice-rollback-0001",
      skillId: "python.toolchain.repl",
      kind: "practice",
    });
    await pool.query(`
      create function practice_help_test_reject() returns trigger language plpgsql as $$
      begin raise exception 'forced practice help receipt failure'; end $$
    `);
    await pool.query(`create trigger practice_help_test_reject before insert on practice_help_event for each row execute function practice_help_test_reject()`);
    try {
      await expect(service.revealNextPracticeHelp({
        userId: LEARNER,
        attemptId: created.attempt!.id,
        requestId: "b4000000-0000-4000-8000-000000000001",
      })).rejects.toThrow(/Failed query: insert into "practice_help_event"/);
    } finally {
      await pool.query(`drop trigger if exists practice_help_test_reject on practice_help_event`);
      await pool.query(`drop function if exists practice_help_test_reject()`);
    }
    const [stored] = await db.select().from(attempt).where(eq(attempt.id, created.attempt!.id));
    const events = await db.select().from(practiceHelpEvent).where(eq(practiceHelpEvent.attemptId, created.attempt!.id));
    expect(stored).toMatchObject({ helpStep: 0, assistanceLevel: "A0", solutionRevealed: false });
    expect(events).toHaveLength(0);
  });
});
