import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  autosaveExamAnswer,
  listExamCatalog,
  startExam,
  submitExam,
} from "@/app/api/exams/_lib/service";
import {
  ContentRepository,
  parseAssessmentBank,
  parseAuthoredLesson,
  parseContentCatalog,
  parseCourseManifest,
  type AssessmentBank,
  type AuthoredLesson,
  type ContentCatalog,
  type CourseManifest,
} from "@/lib/content";
import {
  publishCurriculumVersion,
  reviewCurriculumArtifact,
  submitCurriculumReleaseEvidence,
} from "@/lib/curriculum-publication/admin-service";
import type {
  CurriculumReleaseEvidence,
  CurriculumReviewChecklist,
} from "@/lib/curriculum-publication/contracts";
import { evaluateCurriculumPublicationGate } from "@/lib/curriculum-publication/gate";
import { aggregateArtifactHash, hashCurriculumValue } from "@/lib/curriculum-publication/hash";
import { db, pool } from "@/lib/db/client";
import {
  achievement,
  activity,
  attempt,
  concept,
  conceptMastery,
  course,
  courseModule,
  courseVersion,
  curriculumArtifact,
  enrollment,
  learnerProfile,
  learningSession,
  lesson,
  lessonBlock,
  lessonConcept,
  masteryEvidence,
  planRevision,
  response,
  reviewSchedule,
  sessionEvent,
  user,
  userAchievement,
} from "@/lib/db/schema";
import { decodeEvidenceEnvelope } from "@/lib/learning-service/evidence-engine";
import { toLearnerAttemptCreationPayload } from "@/lib/learning-service/learner-activity";
import { DrizzleLearningStore } from "@/lib/learning-service/drizzle-store";
import { LearningService } from "@/lib/learning-service/service";
import type {
  AttemptCreationResult,
  AttemptSubmissionResult,
  SupportedAttemptKind,
} from "@/lib/learning-service/types";
import { LESSON_COMPLETION_AUTHORITY } from "@/lib/learning-service/types";

const ADMIN_ID = "journey-integration-admin";
const LEARNER_ID = "journey-integration-learner";
const COURSE_ID = "a7000000-0000-4000-8000-000000000001";
const OLD_VERSION_ID = "a7000000-0000-4000-8000-000000000002";
const VERSION_ID = "a7000000-0000-4000-8000-000000000003";
const OLD_MODULE_ROW_ID = "a7000000-0000-4000-8000-000000000014";
const OLD_LESSON_ROW_ID = "a7000000-0000-4000-8000-000000000015";
const MODULE_ROW_ID = "a7000000-0000-4000-8000-000000000004";
const LESSON_ROW_ID = "a7000000-0000-4000-8000-000000000005";
const BLOCK_ROW_ID = "a7000000-0000-4000-8000-000000000006";
const CONCEPT_ROW_ID = "a7000000-0000-4000-8000-000000000007";
const COURSE_SLUG = "programming-foundations";
const MODULE_SLUG = "pf.computing";
const SKILL_ID = "pf.computing.program";
const REVIEW_HASH = "a".repeat(64);
const BASE_TIME = new Date("2026-07-12T08:00:00.000Z");

const checklist: CurriculumReviewChecklist = {
  technical: { passed: true, evidenceRef: "evidence://journey/technical", note: "The deterministic behavior was independently checked." },
  source: { passed: true, evidenceRef: "evidence://journey/source", note: "The source-bound claims were independently checked." },
  pedagogy: { passed: true, evidenceRef: "evidence://journey/pedagogy", note: "The lesson progression was independently checked." },
  accessibility: { passed: true, evidenceRef: "evidence://journey/accessibility", note: "The semantic learner surface was independently checked." },
  security: { passed: true, evidenceRef: "evidence://journey/security", note: "The learner and hidden-answer boundaries were checked." },
  answerOracle: { passed: true, evidenceRef: "evidence://journey/oracle", note: "The deterministic answer oracle was independently checked." },
  exampleExecution: { passed: true, evidenceRef: "evidence://journey/examples", note: "The bounded examples were independently reproduced." },
};

interface ReviewedFixture {
  readonly catalog: ContentCatalog;
  readonly course: CourseManifest;
  readonly lesson: AuthoredLesson;
  readonly bank: AssessmentBank;
  readonly repository: ContentRepository;
  readonly root: string;
}

interface PublicationArtifact {
  readonly key: string;
  readonly type: "course_manifest" | "authored_lesson" | "assessment_bank";
  readonly skill: string | null;
  readonly path: string;
  readonly content: Record<string, unknown>;
  readonly hash: string;
}

let fixture: ReviewedFixture;

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Learner-journey integration requires the disposable learncoding_integration database.");
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

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), relativePath), "utf8")) as Record<string, unknown>;
}

async function buildReviewedFixture(): Promise<ReviewedFixture> {
  const [rawCatalog, rawCourse, rawLesson, rawBank] = await Promise.all([
    readJson("content/catalog.json"),
    readJson("content/courses/programming-foundations.json"),
    readJson("content/authored/lessons/pf.computing.program.json"),
    readJson("content/authored/assessment-banks/pf.computing.program.json"),
  ]);
  const originalCourse = parseCourseManifest(rawCourse, "journey:source-course");
  const sourceModule = originalCourse.modules.find((item) => item.id === MODULE_SLUG)!;
  const sourceSkill = sourceModule.skills.find((item) => item.id === SKILL_ID)!;
  const reviewedCourse = parseCourseManifest({
    ...originalCourse,
    summary: "A one-skill, independently reviewed synthetic publication used only in the disposable learner-journey test.",
    modules: [{ ...sourceModule, skills: [sourceSkill] }],
    exit_outcomes: [
      "Independently distinguish an algorithm from source code and a running program.",
      "Apply the distinction to a new deterministic classification example.",
    ],
    coverage_summary: {
      required_skills: 1,
      elective_skills: 0,
      total_skills: 1,
      covered: 1,
      partial: 0,
      planned: 0,
    },
  }, "journey:reviewed-course");

  const sourceCatalog = parseContentCatalog(rawCatalog, "journey:source-catalog");
  const sourceTrack = sourceCatalog.tracks.find((item) => item.id === COURSE_SLUG)!;
  const reviewedCatalog = parseContentCatalog({
    ...sourceCatalog,
    description: "Disposable catalog containing one independently reviewed learner-journey fixture.",
    tracks: [{ ...sourceTrack, summary: reviewedCourse.summary }],
    recommended_paths: [{ id: "reviewed-journey", tracks: [COURSE_SLUG] }],
  }, "journey:reviewed-catalog");

  const reviewedAt = "2026-07-12T07:00:00.000Z";
  const reviewer = {
    id: "journey-human-reviewer",
    displayName: "Journey Human Reviewer",
    kind: "human" as const,
    reviewedAt,
    reviewVersion: "1.0.0",
  };
  const reviewedLesson = parseAuthoredLesson({
    ...rawLesson,
    publication: {
      ...(rawLesson.publication as Record<string, unknown>),
      stage: "approved",
      reviewer,
      changeSummary: "Synthetic fixture independently reviewed for the persisted learner-journey integration test only.",
    },
  }, "journey:reviewed-lesson");
  const sourceItems = rawBank.items as Array<Record<string, unknown>>;
  const itemBase = { ...sourceItems[0]! };
  delete itemBase.options;
  delete itemBase.answer;
  const reviewedItems = Array.from({ length: 6 }, (_, index) => ({
    ...itemBase,
    id: `pf-program-journey-${index + 1}`,
    title: `Classify the method, reviewed variant ${index + 1}`,
    kind: "trace",
    prompt: "Name the role of the language-neutral ordered method in this one-step artifact trace.",
    evidenceLevel: index >= 4 ? "transfer" : "apply",
    examEligibility: {
      eligible: true,
      rationale: "This deterministic constructed-response variant was independently reviewed for the disposable formal-exam fixture.",
    },
    artifact: ["A finite, language-neutral ordered method for solving a class of problems."],
    misconceptionMappings: [{
      tag: "program.layer-confusion",
      answers: ["source code"],
    }],
    answer: {
      acceptedTraces: ["algorithm"],
      caseSensitive: false,
      explanation: "A finite, language-neutral ordered method is an algorithm.",
    },
  }));
  const reviewedBank = parseAssessmentBank({
    ...rawBank,
    publication: {
      ...(rawBank.publication as Record<string, unknown>),
      stage: "approved",
      reviewer,
      changeSummary: "Synthetic deterministic bank independently reviewed for the persisted learner-journey test only.",
    },
    items: reviewedItems,
  }, "journey:reviewed-bank");

  const root = await mkdtemp(path.join(tmpdir(), "learncoding-reviewed-journey-"));
  await Promise.all([
    mkdir(path.join(root, "courses"), { recursive: true }),
    mkdir(path.join(root, "roadmap"), { recursive: true }),
    mkdir(path.join(root, "authored", "lessons"), { recursive: true }),
    mkdir(path.join(root, "authored", "assessment-banks"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "catalog.json"), JSON.stringify(reviewedCatalog), "utf8"),
    writeFile(path.join(root, "courses", "programming-foundations.json"), JSON.stringify(reviewedCourse), "utf8"),
    writeFile(path.join(root, "authored", "lessons", "pf.computing.program.json"), JSON.stringify(reviewedLesson), "utf8"),
    writeFile(path.join(root, "authored", "assessment-banks", "pf.computing.program.json"), JSON.stringify(reviewedBank), "utf8"),
  ]);
  const repository = new ContentRepository({ contentRoot: root });
  await repository.getSnapshot();
  return { catalog: reviewedCatalog, course: reviewedCourse, lesson: reviewedLesson, bank: reviewedBank, repository, root };
}

function activitySpecification(
  kind: "diagnostic" | "practice" | "mastery",
  variant: number,
  authoredItemId: string,
) {
  const codeCompletion = kind === "practice";
  const correct = codeCompletion ? 'classification = "algorithm"' : "algorithm";
  const wrong = codeCompletion ? 'classification = "source code"' : "source code";
  return {
    kind: codeCompletion ? "code-completion" : "short-answer",
    authoredItemId,
    itemKey: `journey-${kind}-${variant}`,
    title: `${kind} classification ${variant}`,
    prompt: codeCompletion
      ? "Complete the pseudocode assignment with the role of a language-neutral ordered method."
      : "Name the role of a language-neutral ordered method for solving a class of problems.",
    ...(codeCompletion ? { starterCode: 'classification = ""', language: "pseudocode" } : {}),
    hints: ["Separate a reusable method from one language-specific expression."],
    alternateExplanation: "An algorithm names the method; source code is one expression of it.",
    workedExample: "A maximum-finding method can be expressed by different source files.",
    grading: {
      kind: "exact",
      acceptedAnswers: [correct],
      misconceptions: [{ tag: "program.layer-confusion", answers: [wrong] }],
    },
    feedback: {
      correct: "The answer correctly identifies the language-neutral method as an algorithm.",
      incorrect: "The method is the algorithm; source code is a language-specific representation.",
    },
    remediation: [{
      tag: "program.layer-confusion",
      explanation: "Classify the reusable method before considering its syntax or execution environment.",
      retryPrompt: "State the method first, then separately name one possible source representation.",
    }],
    solutionReveal: {
      answer: correct,
      explanation: "The ordered, language-neutral method is an algorithm.",
    },
  };
}

async function seedCandidate(): Promise<{
  readonly artifacts: readonly PublicationArtifact[];
  readonly artifactIds: readonly string[];
  readonly contentHash: string;
}> {
  await db.insert(user).values([
    {
      id: ADMIN_ID,
      publicId: "a7000000-0000-4000-8000-000000000011",
      name: "Journey Admin",
      email: "journey-admin@integration.invalid",
      role: "admin",
      status: "active",
    },
    {
      id: LEARNER_ID,
      publicId: "a7000000-0000-4000-8000-000000000012",
      name: "Journey Learner",
      email: "journey-learner@integration.invalid",
      role: "learner",
      status: "active",
    },
  ]);
  await db.insert(learnerProfile).values({
    userId: LEARNER_ID,
    selfReportedLevel: "advanced",
    preferredSessionMinutes: 30,
    weeklyGoalMinutes: 180,
    learningGoals: ["Build durable programming foundations"],
    selectedTracks: [COURSE_SLUG],
    onboardingStep: "complete",
    onboardingCompletedAt: BASE_TIME,
  });
  await db.insert(course).values({
    id: COURSE_ID,
    slug: COURSE_SLUG,
    title: fixture.course.title,
    summary: fixture.course.summary,
    domain: "programming",
  });

  const manifestContent = fixture.course as unknown as Record<string, unknown>;
  const lessonContent = fixture.lesson as unknown as Record<string, unknown>;
  const bankContent = fixture.bank as unknown as Record<string, unknown>;
  const artifacts: PublicationArtifact[] = [
    {
      key: `manifest.${COURSE_SLUG}.${fixture.course.version}`,
      type: "course_manifest",
      skill: null,
      path: "courses/programming-foundations.json",
      content: manifestContent,
      hash: hashCurriculumValue(manifestContent),
    },
    {
      key: fixture.lesson.id,
      type: "authored_lesson",
      skill: SKILL_ID,
      path: "authored/lessons/pf.computing.program.json",
      content: lessonContent,
      hash: hashCurriculumValue(lessonContent),
    },
    {
      key: fixture.bank.id,
      type: "assessment_bank",
      skill: SKILL_ID,
      path: "authored/assessment-banks/pf.computing.program.json",
      content: bankContent,
      hash: hashCurriculumValue(bankContent),
    },
  ];
  const contentHash = aggregateArtifactHash(artifacts.map((item) => ({
    artifactKey: item.key,
    artifactType: item.type,
    contentHash: item.hash,
  })));
  await db.insert(courseVersion).values([
    {
      id: OLD_VERSION_ID,
      courseId: COURSE_ID,
      version: "0.0.9",
      stage: "beta",
      scopeStatement: "Older synthetic beta that is deliberately not the canonical pointer.",
      contentHash: "b".repeat(64),
      updatedAt: new Date(BASE_TIME.getTime() - 60_000),
    },
    {
      id: VERSION_ID,
      courseId: COURSE_ID,
      version: fixture.course.version,
      stage: "draft",
      scopeStatement: "Reviewed synthetic one-skill learner journey.",
      contentHash,
      updatedAt: BASE_TIME,
    },
  ]);
  await db.insert(courseModule).values({
    id: MODULE_ROW_ID,
    courseVersionId: VERSION_ID,
    slug: MODULE_SLUG,
    title: fixture.course.modules[0]!.title,
    objective: "Distinguish program, source code, and algorithm with deterministic evidence.",
    position: 0,
    estimatedMinutes: 20,
  });
  await db.insert(courseModule).values({
    id: OLD_MODULE_ROW_ID,
    courseVersionId: OLD_VERSION_ID,
    slug: "pf.old-computing",
    title: "Old programming foundations",
    objective: "A stale module that must never authorize current learner evidence.",
    position: 0,
    estimatedMinutes: 20,
  });
  await db.insert(lesson).values({
    id: OLD_LESSON_ROW_ID,
    moduleId: OLD_MODULE_ROW_ID,
    slug: "pf.old-computing.program",
    title: "Old source-code foundations",
    objective: "A stale lesson outside the learner's current enrollment.",
    estimatedMinutes: 15,
    difficulty: "beginner",
    position: 0,
    contentStatus: "beta",
  });
  await db.insert(lesson).values({
    id: LESSON_ROW_ID,
    moduleId: MODULE_ROW_ID,
    slug: SKILL_ID,
    title: fixture.lesson.title,
    objective: fixture.lesson.outcomes[0]!,
    estimatedMinutes: 15,
    difficulty: "beginner",
    position: 0,
    contentStatus: "beta",
  });
  await db.insert(lessonBlock).values({
    id: BLOCK_ROW_ID,
    lessonId: LESSON_ROW_ID,
    position: 0,
    type: "explanation",
    payload: { text: fixture.lesson.canonicalExplanation.summary },
    interestTags: [],
  });
  await db.insert(concept).values({
    id: CONCEPT_ROW_ID,
    slug: SKILL_ID,
    title: fixture.course.modules[0]!.skills[0]!.title,
    domain: "programming",
    description: fixture.course.modules[0]!.skills[0]!.description,
    critical: true,
  });
  await db.insert(lessonConcept).values({
    lessonId: LESSON_ROW_ID,
    conceptId: CONCEPT_ROW_ID,
    coverage: "primary",
    weight: 1,
  });
  const activityRows = [
    {
      id: "a7100000-0000-4000-8000-000000000001",
      slug: "journey-diagnostic-a",
      type: "diagnostic-check",
      specification: activitySpecification("diagnostic", 1, fixture.bank.items[0]!.id),
    },
    {
      id: "a7100000-0000-4000-8000-000000000002",
      slug: "journey-mastery-a",
      type: "mastery-check",
      specification: activitySpecification("mastery", 1, fixture.bank.items[1]!.id),
    },
    ...[1, 2, 3, 4].map((variant) => ({
      id: `a7200000-0000-4000-8000-00000000000${variant}`,
      slug: `journey-practice-code-${variant}`,
      type: "practice-code-completion",
      specification: activitySpecification("practice", variant, fixture.bank.items[variant + 1]!.id),
    })),
  ];
  await db.insert(activity).values(activityRows.map((item, index) => ({
    ...item,
    lessonId: LESSON_ROW_ID,
    conceptId: CONCEPT_ROW_ID,
    instructions: String(item.specification.prompt),
    difficulty: "beginner",
    maxPoints: 1,
    createdAt: new Date(BASE_TIME.getTime() + index),
    updatedAt: new Date(BASE_TIME.getTime() + index),
  })));

  const artifactIds: string[] = [];
  for (const item of artifacts) {
    const [inserted] = await db.insert(curriculumArtifact).values({
      courseVersionId: VERSION_ID,
      artifactKey: item.key,
      artifactType: item.type,
      skillKey: item.skill,
      sourcePath: item.path,
      content: item.content,
      contentHash: item.hash,
      publicationStage: "approved",
      aiAssisted: true,
      provenance: {
        fixture: "synthetic-reviewed-learner-journey",
        limitation: "Disposable integration evidence only; this does not approve the committed Launch 1 corpus.",
      },
    }).returning({ id: curriculumArtifact.id });
    artifactIds.push(inserted.id);
  }
  return { artifacts, artifactIds, contentHash };
}

function releaseEvidence(artifacts: readonly PublicationArtifact[]): CurriculumReleaseEvidence {
  return {
    schemaVersion: 1,
    generatedAt: BASE_TIME.toISOString(),
    generator: "learner-journey-integration",
    sourceCoverage: { passed: true, reportHash: REVIEW_HASH, sourceRefs: ["cs2023-sdf"] },
    skillCoverage: {
      passed: true,
      reportHash: REVIEW_HASH,
      skillIds: [SKILL_ID],
      lessonArtifactKeys: [artifacts.find((item) => item.type === "authored_lesson")!.key],
      assessmentBankArtifactKeys: [artifacts.find((item) => item.type === "assessment_bank")!.key],
    },
    dagMastery: { passed: true, reportHash: REVIEW_HASH },
    codeExecution: { passed: true, reportHash: REVIEW_HASH, executedItemIds: [], runtimeImageDigests: [] },
    languageParity: {
      status: "not_applicable",
      reportHash: REVIEW_HASH,
      rationale: "The reviewed fixture is intentionally language-neutral and declares no implementation parity promise.",
      languages: [],
    },
    webAccessibility: {
      status: "not_applicable",
      reportHash: REVIEW_HASH,
      rationale: "The fixture uses the already-tested semantic learner controls and adds no web-specific interaction.",
    },
    security: { passed: true, reportHash: REVIEW_HASH },
    exclusions: {
      reportHash: REVIEW_HASH,
      items: ["No code runner, external network, or live provider is part of this bounded fixture."],
    },
  };
}

async function publishReviewedCandidate() {
  const candidate = await seedCandidate();
  for (let index = 0; index < candidate.artifactIds.length; index += 1) {
    const artifact = candidate.artifacts[index]!;
    await reviewCurriculumArtifact({
      actorUserId: ADMIN_ID,
      artifactId: candidate.artifactIds[index]!,
      requestId: `a7300000-0000-4000-8000-00000000000${index + 1}`,
      expectedVersion: 1,
      decision: "approved",
      checklist,
      reviewedItemIds: artifact.type === "assessment_bank"
        ? fixture.bank.items.map((item) => item.id)
        : [artifact.key],
      reason: `Independently approve synthetic learner-journey artifact ${index + 1} for disposable integration evidence.`,
      now: BASE_TIME,
    });
  }
  await submitCurriculumReleaseEvidence({
    actorUserId: ADMIN_ID,
    courseVersionId: VERSION_ID,
    requestId: "a7300000-0000-4000-8000-000000000010",
    expectedVersion: 1,
    evidence: releaseEvidence(candidate.artifacts),
    reason: "Bind the independently reviewed synthetic learner journey to its complete release evidence.",
    now: BASE_TIME,
  });
  const gate = await evaluateCurriculumPublicationGate({ courseVersionId: VERSION_ID, targetStage: "beta" });
  expect(gate).toMatchObject({ allowed: true, summary: { promisedSkills: 1, approvedArtifacts: 3 } });
  await publishCurriculumVersion({
    actorUserId: ADMIN_ID,
    courseVersionId: VERSION_ID,
    requestId: "a7300000-0000-4000-8000-000000000011",
    expectedVersion: 2,
    targetStage: "beta",
    reason: "Publish the complete reviewed synthetic fixture for the disposable learner journey.",
    now: BASE_TIME,
  });
}

function acceptedAnswer(created: AttemptCreationResult): string {
  const grading = created.activity?.specification.grading as { acceptedAnswers?: unknown[] } | undefined;
  const answer = grading?.acceptedAnswers?.[0];
  if (typeof answer !== "string") throw new Error("Fixture activity lacks its server-side deterministic answer.");
  return answer;
}

function misconceptionAnswer(created: AttemptCreationResult): string {
  const grading = created.activity?.specification.grading as {
    misconceptions?: Array<{ answers?: unknown[] }>;
  } | undefined;
  const answer = grading?.misconceptions?.[0]?.answers?.[0];
  if (typeof answer !== "string") throw new Error("Fixture activity lacks its misconception probe.");
  return answer;
}

describe("canonical persisted learner journey", () => {
  beforeAll(async () => {
    fixture = await buildReviewedFixture();
  });

  beforeEach(async () => {
    await truncateApplicationTables();
  });

  afterAll(async () => {
    if (fixture?.root) await rm(fixture.root, { recursive: true, force: true });
    await pool.end();
  });

  it("runs reviewed placement, lesson, assisted practice, remediation, exam mastery, and delayed review through PostgreSQL", async () => {
    await publishReviewedCandidate();
    let now = new Date(BASE_TIME.getTime() + 60_000);
    const service = new LearningService({
      store: new DrizzleLearningStore(),
      content: fixture.repository,
      now: () => new Date(now),
    });

    const plans = await service.initializePlans(LEARNER_ID, "journey-plan-initialization");
    expect(plans).toMatchObject({
      state: "ready",
      selectedTrackIds: [COURSE_SLUG],
      resolvedTrackIds: [COURSE_SLUG],
      missingPublications: [],
      placement: { required: true, selfReportUsedAsEvidence: false },
    });
    expect(plans.plans).toHaveLength(1);
    const enrollmentId = plans.plans[0]!.enrollmentId;
    const [persistedEnrollment] = await db.select().from(enrollment).where(eq(enrollment.id, enrollmentId));
    expect(persistedEnrollment).toMatchObject({
      userId: LEARNER_ID,
      courseVersionId: VERSION_ID,
      status: "active",
      source: "adaptive_plan",
    });
    expect(persistedEnrollment.courseVersionId).not.toBe(OLD_VERSION_ID);
    expect(await db.select().from(planRevision)).toHaveLength(1);

    let learning = (await service.startSession({
      userId: LEARNER_ID,
      idempotencyKey: "journey-session-start",
      enrollmentId,
      goal: "Complete the reviewed foundations journey",
      plannedMinutes: 30,
    })).session;
    await expect(service.recordSessionEvent({
      userId: LEARNER_ID,
      sessionId: learning.id,
      clientEventId: "journey-cross-enrollment-completion",
      expectedRowVersion: learning.rowVersion,
      type: "lesson_completed",
      subjectType: "lesson",
      subjectId: OLD_LESSON_ROW_ID,
    })).rejects.toMatchObject({ code: "INVALID_EVENT_SUBJECT" });
    await expect(service.recordSessionEvent({
      userId: LEARNER_ID,
      sessionId: learning.id,
      clientEventId: "journey-forged-current-lesson-completion",
      expectedRowVersion: learning.rowVersion,
      type: "lesson_completed",
      subjectType: "lesson",
      subjectId: LESSON_ROW_ID,
    })).rejects.toMatchObject({ code: "INVALID_EVENT_SUBJECT" });
    learning = (await service.recordSessionEvent({
      userId: LEARNER_ID,
      sessionId: learning.id,
      clientEventId: "journey-lesson-viewed",
      expectedRowVersion: learning.rowVersion,
      type: "lesson_viewed",
      subjectType: "lesson",
      subjectId: LESSON_ROW_ID,
    })).session;

    const diagnostic = await service.createAttempt({
      userId: LEARNER_ID,
      idempotencyKey: "journey-placement-diagnostic",
      skillId: SKILL_ID,
      kind: "diagnostic",
    });
    const placementProjection = toLearnerAttemptCreationPayload(diagnostic);
    expect(placementProjection).toMatchObject({ state: "ready", attempt: { kind: "diagnostic" } });
    expect(JSON.stringify(placementProjection)).not.toMatch(/acceptedAnswers|misconceptions|solutionReveal|grading/);
    const diagnosticResult = await service.submitAttempt(LEARNER_ID, diagnostic.attempt!.id, {
      itemKey: String(diagnostic.activity!.specification.itemKey),
      responseRevision: 1,
      answer: { value: acceptedAnswer(diagnostic) },
      assistanceLevel: "A4",
      solutionRevealed: true,
      submittedAt: now,
    });
    expect(diagnosticResult).toMatchObject({
      state: "graded",
      passed: true,
      masteryAwarded: false,
      progress: { masteryProbability: 0 },
    });

    const examInput = {
      moduleId: MODULE_SLUG,
      integrityDisclosureAccepted: true,
      readinessAcknowledged: true,
      device: { viewportWidth: 1280, viewportHeight: 800, userAgent: "Integration Desktop" },
    } as const;
    await expect(startExam(LEARNER_ID, examInput, now)).rejects.toMatchObject({
      code: "EXAM_NOT_READY",
      details: { missingSkillIds: [SKILL_ID] },
    });

    let requestSequence = 0;
    const createDifferentVariant = async (
      kind: SupportedAttemptKind,
      excluded: ReadonlySet<string>,
      prefix: string,
    ): Promise<AttemptCreationResult> => {
      for (let probe = 0; probe < 64; probe += 1) {
        requestSequence += 1;
        const created = await service.createAttempt({
          userId: LEARNER_ID,
          idempotencyKey: `${prefix}-${String(requestSequence).padStart(4, "0")}`,
          skillId: SKILL_ID,
          kind,
        });
        if (created.state === "ready" && created.activity && !excluded.has(created.activity.activitySlug)) return created;
      }
      throw new Error(`Could not select a distinct ${kind} fixture variant.`);
    };
    const submit = async (
      created: AttemptCreationResult,
      value: string,
      clientAssistance: "A0" | "A4" = "A0",
    ): Promise<AttemptSubmissionResult> => {
      now = new Date(now.getTime() + 60_000);
      return service.submitAttempt(LEARNER_ID, created.attempt!.id, {
        itemKey: String(created.activity!.specification.itemKey),
        responseRevision: 1,
        answer: { value },
        assistanceLevel: clientAssistance,
        solutionRevealed: clientAssistance === "A4",
        submittedAt: now,
      });
    };

    const assisted = await createDifferentVariant("practice", new Set(), "journey-assisted-practice");
    const help = await service.revealNextPracticeHelp({
      userId: LEARNER_ID,
      attemptId: assisted.attempt!.id,
      requestId: "a7400000-0000-4000-8000-000000000001",
    });
    expect(help).toMatchObject({ state: "ready", assistanceLevel: "A1", solutionRevealed: false });
    const assistedWrong = await submit(assisted, misconceptionAnswer(assisted));
    expect(assistedWrong).toMatchObject({
      passed: false,
      feedback: {
        independent: false,
        assistanceLevel: "A1",
        misconceptionTags: ["program.layer-confusion"],
      },
      remediation: { activeTags: [] },
    });

    const failureSlugs = new Set<string>([assisted.activity!.activitySlug]);
    const wrongOne = await createDifferentVariant("practice", failureSlugs, "journey-wrong-one");
    failureSlugs.add(wrongOne.activity!.activitySlug);
    const firstWrong = await submit(wrongOne, misconceptionAnswer(wrongOne), "A4");
    expect(firstWrong).toMatchObject({
      feedback: { independent: true, assistanceLevel: "A0" },
      remediation: { activeTags: [], confirmingProbeTags: ["program.layer-confusion"] },
    });
    const wrongTwo = await createDifferentVariant("practice", failureSlugs, "journey-wrong-two");
    const secondWrong = await submit(wrongTwo, misconceptionAnswer(wrongTwo));
    expect(secondWrong).toMatchObject({
      passed: false,
      progress: { stage: "REMEDIATION" },
      remediation: { activeTags: ["program.layer-confusion"] },
    });
    await expect(service.recommendNext(LEARNER_ID, learning.id)).resolves.toMatchObject({
      state: "ready",
      action: { kind: "REMEDIATE", skillId: SKILL_ID, reason: "confirmed blocking misconception" },
    });

    const recoverySlugs = new Set<string>();
    const recoveryOne = await createDifferentVariant("practice", recoverySlugs, "journey-recovery-one");
    recoverySlugs.add(recoveryOne.activity!.activitySlug);
    const firstRecovery = await submit(recoveryOne, acceptedAnswer(recoveryOne));
    expect(firstRecovery).toMatchObject({
      passed: true,
      remediation: { activeTags: ["program.layer-confusion"] },
    });
    expect(firstRecovery.reviewDueAt).toBeTruthy();
    learning = (await service.recordSessionEvent({
      userId: LEARNER_ID,
      sessionId: learning.id,
      clientEventId: "journey-lesson-completed",
      expectedRowVersion: learning.rowVersion,
      type: "lesson_completed",
      subjectType: "lesson",
      subjectId: LESSON_ROW_ID,
    })).session;
    const recoveryTwo = await createDifferentVariant("practice", recoverySlugs, "journey-recovery-two");
    const secondRecovery = await submit(recoveryTwo, acceptedAnswer(recoveryTwo));
    expect(secondRecovery).toMatchObject({
      passed: true,
      remediation: { activeTags: [] },
    });

    const transferCheck = await createDifferentVariant("mastery_check", new Set(), "journey-transfer-check");
    const transfer = await submit(transferCheck, acceptedAnswer(transferCheck));
    expect(transfer).toMatchObject({
      passed: true,
      masteryAwarded: false,
      criticalGates: expect.arrayContaining(["delayed_check"]),
    });
    const [initialReview] = await db.select().from(reviewSchedule).where(eq(reviewSchedule.status, "scheduled"));
    expect(initialReview).toBeTruthy();
    now = new Date(initialReview.dueAt.getTime() + 1_000);
    const delayedCheck = await createDifferentVariant("mastery_check", new Set(), "journey-delayed-check");
    const mastered = await submit(delayedCheck, acceptedAnswer(delayedCheck));
    expect(mastered).toMatchObject({
      passed: true,
      masteryAwarded: true,
      progress: { stage: "MASTERED" },
      criticalGates: [],
    });

    now = new Date(now.getTime() + 60_000);
    const exam = await startExam(LEARNER_ID, examInput, now);
    expect(exam).toMatchObject({
      attemptNumber: 1,
      status: "active",
      form: {
        moduleId: MODULE_SLUG,
        items: [{ verificationAvailable: true }],
      },
    });
    expect(JSON.stringify(exam.form)).not.toMatch(/gradingEvidence|acceptedAnswers|correctOptionIds|seed/);
    const examItem = exam.form.items[0]!;
    await autosaveExamAnswer({
      userId: LEARNER_ID,
      sessionId: exam.sessionId,
      itemId: examItem.id,
      baseRevision: 0,
      answer: { text: "algorithm" },
      now: new Date(now.getTime() + 60_000),
    });
    const submittedExam = await submitExam(LEARNER_ID, exam.sessionId, new Date(now.getTime() + 120_000));
    expect(submittedExam).toMatchObject({
      status: "graded",
      result: {
        gradingStatus: "graded",
        outcome: "MASTERED",
        officialScorePercent: 100,
        pendingReviewItemIds: [],
        infrastructureFailure: false,
      },
    });
    const catalog = await listExamCatalog(LEARNER_ID, new Date(now.getTime() + 180_000));
    expect(catalog.find((item) => item.moduleId === MODULE_SLUG)).toMatchObject({
      readiness: "mastered",
      latestResult: { outcome: "MASTERED", officialScorePercent: 100 },
      retake: { eligible: false, reason: "already-mastered" },
    });

    const scheduledAfterMastery = (await db.select().from(reviewSchedule))
      .find((row) => row.status === "scheduled")!;
    now = new Date(scheduledAfterMastery.dueAt.getTime() + 1_000);
    await expect(service.recommendNext(LEARNER_ID, learning.id)).resolves.toMatchObject({
      state: "ready",
      action: { kind: "REVIEW", skillId: SKILL_ID },
    });
    const reviewAttempt = await createDifferentVariant("mastery_check", new Set(), "journey-due-review");
    const reviewed = await submit(reviewAttempt, acceptedAnswer(reviewAttempt));
    expect(reviewed).toMatchObject({ passed: true, masteryAwarded: true });
    learning = (await service.recordSessionEvent({
      userId: LEARNER_ID,
      sessionId: learning.id,
      clientEventId: "journey-review-completed",
      expectedRowVersion: learning.rowVersion,
      type: "review_completed",
      subjectType: "concept",
      subjectId: SKILL_ID,
    })).session;
    await expect(service.recommendNext(LEARNER_ID, learning.id)).resolves.toMatchObject({
      state: "ready",
      action: { kind: "NONE", reason: "no eligible activity" },
    });
    learning = (await service.mutateSession({
      userId: LEARNER_ID,
      sessionId: learning.id,
      expectedRowVersion: learning.rowVersion,
      action: "end",
    })).session;
    expect(learning).toMatchObject({
      status: "completed",
      reviewOnly: false,
      endedAt: expect.any(Date),
    });
    let reviewOnlySession = (await service.startSession({
      userId: LEARNER_ID,
      idempotencyKey: "journey-review-only-session",
      enrollmentId,
      goal: "Concentrate on currently due work",
      plannedMinutes: 15,
      reviewOnly: true,
    })).session;
    await expect(service.recommendNext(LEARNER_ID, reviewOnlySession.id)).resolves.toMatchObject({
      state: "ready",
      action: { kind: "NONE", reason: "no due reviews" },
    });
    reviewOnlySession = (await service.mutateSession({
      userId: LEARNER_ID,
      sessionId: reviewOnlySession.id,
      expectedRowVersion: reviewOnlySession.rowVersion,
      action: "end",
    })).session;
    expect(reviewOnlySession).toMatchObject({ status: "completed", reviewOnly: true });

    const evidenceRows = await db.select().from(masteryEvidence).where(eq(masteryEvidence.userId, LEARNER_ID));
    const envelopes = evidenceRows.map((row) => decodeEvidenceEnvelope({
      ...row,
      skillId: SKILL_ID,
    })).filter((item) => item !== null);
    expect(envelopes).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceLevel: "E2", correct: true }),
      expect.objectContaining({ evidenceLevel: "E4", assistanceLevel: "A1", correct: false }),
      expect.objectContaining({ evidenceLevel: "E4", assistanceLevel: "A0", correct: false }),
      expect.objectContaining({ evidenceLevel: "E4", assistanceLevel: "A0", correct: true }),
      expect.objectContaining({ evidenceLevel: "E5", correct: true }),
      expect.objectContaining({ evidenceLevel: "E6", correct: true }),
    ]));
    const [mastery] = await db.select().from(conceptMastery).where(eq(conceptMastery.userId, LEARNER_ID));
    expect(mastery).toMatchObject({
      status: "mastered",
      criticalRequirementsMet: true,
      nextReviewAt: expect.any(Date),
    });
    expect((await db.select().from(reviewSchedule)).map((row) => row.status).sort()).toEqual([
      "completed",
      "completed",
      "scheduled",
    ]);
    expect(await db.select().from(response)).not.toHaveLength(0);
    expect((await db.select().from(attempt)).some((row) =>
      row.kind === "exam" && row.masteryAwarded === true && row.passed === true
    )).toBe(true);
    expect(await db.select().from(achievement)).toHaveLength(1);
    expect(await db.select().from(userAchievement)).toEqual([
      expect.objectContaining({ userId: LEARNER_ID, evidenceId: `exam-attempt:${exam.attemptId}` }),
    ]);
    const persistedSessions = await db.select().from(learningSession);
    expect(persistedSessions).toHaveLength(2);
    expect(persistedSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: learning.id, status: "completed", reviewOnly: false }),
      expect.objectContaining({ id: reviewOnlySession.id, status: "completed", reviewOnly: true }),
    ]));
    const learningEvents = await db.select().from(sessionEvent);
    const learningEventTypes = learningEvents.map((row) => row.type);
    expect(learningEventTypes).toHaveLength(3);
    expect(learningEventTypes).toEqual(expect.arrayContaining([
      "lesson_viewed", "lesson_completed", "review_completed",
    ]));
    expect(learningEvents.map((row) => row.clientEventId))
      .not.toContain("journey-cross-enrollment-completion");
    expect(learningEvents.map((row) => row.clientEventId))
      .not.toContain("journey-forged-current-lesson-completion");
    expect(learningEvents.find((row) => row.clientEventId === "journey-lesson-completed")?.metadata)
      .toMatchObject({ meaningful: true, authority: LESSON_COMPLETION_AUTHORITY });
  });
});
