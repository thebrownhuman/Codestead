import path from "node:path";
import { access, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";

import { POST as activateInvitation } from "@/app/api/invitations/activate/route";
import {
  autosaveExamAnswer,
  ExamServiceError,
  recordExamEvent,
  startExam,
  submitExamAppeal,
  submitExamAppealReply,
} from "@/app/api/exams/_lib/service";
import {
  BLUEPRINT_RESPONSE_KEY,
  EXAM_POLICY_VERSION,
  RESULT_RESPONSE_KEY,
  type ExamFormSnapshot,
  type ExamResult,
} from "@/lib/exams/contracts";
import { buildEquivalentExamForm } from "@/app/api/exams/_lib/blueprint";
import {
  createContentRepository,
  type AssessmentBank,
  type CourseManifest,
} from "@/lib/content";
import { aggregateArtifactHash, hashCurriculumValue } from "@/lib/curriculum-publication/hash";
import { db, pool } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import {
  activity,
  adminFallbackGrant,
  adminFallbackReservation,
  appeal,
  appealEvent,
  assessmentCorrection,
  assessmentCorrectionImpact,
  account,
  accountDeletionTombstone,
  apiRateLimitWindow,
  auditEvent,
  authSessionHistory,
  attempt,
  chatMessage,
  chatThread,
  codeSubmission,
  concept,
  consentRecord,
  course,
  courseModule,
  courseVersion,
  curriculumArtifact,
  curriculumPublicationEvent,
  curriculumPublicationPointer,
  curriculumReleaseEvidence,
  curriculumReviewEvent,
  enrollment,
  examEvent,
  examSession,
  emailOutbox,
  invitation,
  learnerProfile,
  lesson,
  masteryEvidence,
  modelCall,
  notification,
  providerCredential,
  providerOperationReceipt,
  quotaLedger,
  response,
  runnerPowerRehearsalEvent,
  session,
  storedObject,
  twoFactor,
  user,
} from "@/lib/db/schema";
import { DrizzleLearningStore } from "@/lib/learning-service/drizzle-store";
import type { MasteryWriteInput } from "@/lib/learning-service/store";
import {
  consumeInvitationByToken,
  findUsableInvitationByToken,
  hashInvitationToken,
} from "@/lib/security/invitation-store";
import {
  openCredential,
  sealCredential,
} from "@/lib/security/credential-vault";
import { PostgresRateLimitStore } from "@/lib/security/rate-limit";
import {
  backupExpiryReport,
  deleteLearnerAccount,
} from "@/lib/data-lifecycle/deletion";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import { processFileErasures } from "@/lib/data-lifecycle/file-erasure";
import { runRetention } from "@/lib/data-lifecycle/retention";
import { revokeOneOwnedSession } from "@/lib/session-controls";
import { ownerStorageSegment } from "@/lib/storage/upload-service";
import {
  reserveStoredObject,
  StorageQuotaExceededError,
} from "@/lib/storage/quota-store";
import { resolveStoredObjectPath } from "@/lib/storage/upload-scanner";
import {
  reconcileFallbackBudget,
  reserveFallbackBudget,
} from "@/lib/ai/fallback-budget";
import { consentInsert } from "@/lib/privacy/consent";
import {
  decideAppeal,
  getAdminAppealDetail,
} from "@/lib/appeals/admin-service";


const USER_A = "integration-user-a";
const USER_B = "integration-user-b";
const COURSE_ID = "10000000-0000-4000-8000-000000000001";
const COURSE_VERSION_ID = "10000000-0000-4000-8000-000000000002";
const MODULE_ID = "10000000-0000-4000-8000-000000000003";
const CONCEPT_ID = "10000000-0000-4000-8000-000000000004";
const LESSON_ID = "10000000-0000-4000-8000-000000000005";
const ACTIVITY_ID = "10000000-0000-4000-8000-000000000006";
const ENROLLMENT_ID = "10000000-0000-4000-8000-000000000007";
const LEARNING_ATTEMPT_ID = "10000000-0000-4000-8000-000000000008";
const EXAM_ATTEMPT_ID = "20000000-0000-4000-8000-000000000001";
const EXAM_SESSION_ID = "20000000-0000-4000-8000-000000000002";
const FAILED_EXAM_ATTEMPT_ID = "20000000-0000-4000-8000-000000000003";
const FAILED_EXAM_SESSION_ID = "20000000-0000-4000-8000-000000000004";
const integrationFileErasureDependencies = {
  processFileErasures: (input: Parameters<typeof processFileErasures>[0]) => processFileErasures({
    ...input,
    preparePath: async (root, storageKey) => resolveStoredObjectPath(root, storageKey),
    unlinkFile: unlink,
    // This cross-platform suite proves queue/database orchestration. Linux
    // procfd identity checks and directory fsync are exercised separately.
    syncParentDirectory: async (root, storageKey) => {
      await access(path.dirname(resolveStoredObjectPath(root, storageKey)));
    },
  }),
} as const;

const REVIEWED_LEARNING_FIXTURE_BANK = {
  $schema: "../content/schema/assessment-bank.schema.json",
  format: "assessment-bank",
  schemaVersion: "1.0.0",
  id: "bank.integration-course.integration-concept",
  courseId: "integration-course",
  courseVersion: "1.0.0",
  moduleId: "integration-module",
  skillId: "integration-concept",
  title: "Reviewed integration concept check",
  publication: {
    stage: "approved",
    author: { id: "integration-author", displayName: "Integration Author", kind: "human" },
    authoredAt: "2026-01-01T00:00:00.000Z",
    aiAssisted: false,
    reviewer: {
      id: "integration-reviewer",
      displayName: "Integration Reviewer",
      kind: "human",
      reviewedAt: "2026-01-01T00:00:00.000Z",
      reviewVersion: "1.0.0",
    },
    changeSummary: "Synthetic deterministic fixture independently reviewed for disposable PostgreSQL tests.",
  },
  sourceRefs: ["integration-source"],
  items: [{
    id: "integration-check",
    skillId: "integration-concept",
    title: "Resolve the integration value",
    kind: "trace",
    prompt: "What value does the fixture produce?",
    points: 1,
    evidenceLevel: "apply",
    examEligibility: {
      eligible: true,
      rationale: "The exact fixture oracle is independently reviewed and deterministic.",
    },
    hints: ["Read the single fixture value."],
    feedback: { correct: "The fixture produces ok.", incorrect: "Re-read the fixture value." },
    rubric: {
      passPoints: 1,
      criteria: [{
        id: "exact-value",
        description: "Records the exact deterministic fixture value.",
        points: 1,
        critical: true,
      }],
    },
    privateAuthorNotes: ["Synthetic disposable-database oracle."],
    artifact: ["ok"],
    answer: {
      acceptedTraces: ["ok"],
      caseSensitive: true,
      explanation: "The fixture contains the exact value ok.",
    },
  }],
} as const;

const startDevice = {
  viewportWidth: 1_280,
  viewportHeight: 800,
  userAgent: "Integration desktop",
} as const;

const startInput = {
  moduleId: "python.toolchain",
  integrityDisclosureAccepted: true,
  readinessAcknowledged: true,
  device: startDevice,
} as const;

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (
    process.env.INTEGRATION_TEST !== "1" ||
    !/\/learncoding_integration(?:\?|$)/.test(connectionString)
  ) {
    throw new Error(
      "Integration tests refuse to run outside the disposable learncoding_integration database.",
    );
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const identifiers = result.rows
    .map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`)
    .join(", ");
  await pool.query(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
}

async function seedUsers(options: { quota?: number } = {}) {
  await db.insert(user).values([
    {
      id: USER_A,
      name: "Integration Learner A",
      email: "learner-a@integration.invalid",
      status: "active",
    },
    {
      id: USER_B,
      name: "Integration Learner B",
      email: "learner-b@integration.invalid",
      status: "active",
    },
  ]);
  await db.insert(learnerProfile).values([
    {
      userId: USER_A,
      ...(options.quota === undefined ? {} : { storageQuotaBytes: options.quota }),
    },
    { userId: USER_B },
  ]);
}

async function seedLearningGraph() {
  await seedUsers();
  await db.insert(course).values({
    id: COURSE_ID,
    slug: "integration-course",
    title: "Integration Course",
    summary: "Disposable integration fixture.",
    domain: "testing",
  });
  await db.insert(courseVersion).values({
    id: COURSE_VERSION_ID,
    courseId: COURSE_ID,
    version: "integration-v1",
    stage: "verified",
    scopeStatement: "Integration-only scope.",
    contentHash: "fixture-content-hash",
  });
  await db.insert(courseModule).values({
    id: MODULE_ID,
    courseVersionId: COURSE_VERSION_ID,
    slug: "integration-module",
    title: "Integration Module",
    objective: "Exercise persistence boundaries.",
    position: 1,
    estimatedMinutes: 10,
  });
  await db.insert(concept).values({
    id: CONCEPT_ID,
    slug: "integration-concept",
    title: "Integration Concept",
    domain: "testing",
    description: "Integration-only concept.",
    critical: true,
  });
  await db.insert(curriculumArtifact).values({
    id: "10000000-0000-4000-8000-000000000009",
    courseVersionId: COURSE_VERSION_ID,
    artifactKey: REVIEWED_LEARNING_FIXTURE_BANK.id,
    artifactType: "assessment_bank",
    skillKey: "integration-concept",
    sourcePath: "integration/reviewed-learning-fixture-bank.json",
    content: REVIEWED_LEARNING_FIXTURE_BANK,
    contentHash: "1".repeat(64),
    publicationStage: "approved",
    aiAssisted: false,
    provenance: { fixture: "synthetic-reviewed-postgres-integration" },
    reviewStatus: "approved",
  });
  await db.insert(lesson).values({
    id: LESSON_ID,
    moduleId: MODULE_ID,
    slug: "integration-lesson",
    title: "Integration Lesson",
    objective: "Persist evidence.",
    estimatedMinutes: 10,
    difficulty: "beginner",
    position: 1,
    contentStatus: "verified",
  });
  await db.insert(activity).values({
    id: ACTIVITY_ID,
    lessonId: LESSON_ID,
    conceptId: CONCEPT_ID,
    slug: "integration-check",
    type: "quiz-check",
    instructions: "Answer the integration fixture.",
    specification: { authoredItemId: "integration-check" },
    difficulty: "beginner",
  });
  await db.insert(enrollment).values({
    id: ENROLLMENT_ID,
    userId: USER_A,
    courseVersionId: COURSE_VERSION_ID,
    status: "active",
  });
  await db.insert(attempt).values({
    id: LEARNING_ATTEMPT_ID,
    userId: USER_A,
    activityId: ACTIVITY_ID,
    enrollmentId: ENROLLMENT_ID,
    kind: "quiz",
    status: "graded",
    policyVersion: "adaptive-learning-v1",
    contentVersion: "integration-v1",
    score: 1,
    passed: true,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    submittedAt: new Date("2026-01-01T00:01:00.000Z"),
    gradedAt: new Date("2026-01-01T00:01:00.000Z"),
  });
}

async function seedExam() {
  await seedUsers();
  const now = new Date();
  await db.insert(attempt).values({
    id: EXAM_ATTEMPT_ID,
    userId: USER_A,
    kind: "exam",
    status: "in_progress",
    policyVersion: EXAM_POLICY_VERSION,
    contentVersion: "integration-v1",
    startedAt: now,
  });
  await db.insert(examSession).values({
    id: EXAM_SESSION_ID,
    attemptId: EXAM_ATTEMPT_ID,
    userId: USER_A,
    status: "active",
    serverStartedAt: now,
    serverDeadlineAt: new Date(now.getTime() + 60 * 60 * 1_000),
    lastHeartbeatAt: now,
  });
  const form: ExamFormSnapshot = {
    schemaVersion: 1,
    formId: "integration-form-v1",
    seed: "integration-seed",
    courseId: "integration-course",
    courseTitle: "Integration Course",
    moduleId: "integration-module",
    moduleTitle: "Integration Module",
    contentVersion: "integration-v1",
    policyVersion: EXAM_POLICY_VERSION,
    durationMinutes: 60,
    generatedAt: now.toISOString(),
    instructions: ["Integration-only exam."],
    integrityDisclosure: {
      version: "v1",
      summary: "Integration fixture.",
      capturedEvents: ["visibility"],
      notCaptured: ["screen contents"],
    },
    items: [
      {
        id: "item-1",
        skillId: "integration-concept",
        clusterId: "integration-cluster",
        title: "Integration item",
        prompt: "Type ok.",
        kind: "short-answer",
        points: 10,
        critical: true,
        gradingEvidence: {
          kind: "exact-answer",
          acceptedAnswers: ["ok"],
          caseSensitive: false,
        },
      },
    ],
  };
  await db.insert(response).values({
    attemptId: EXAM_ATTEMPT_ID,
    itemKey: BLUEPRINT_RESPONSE_KEY,
    revision: 1,
    answer: { snapshot: form } as unknown as Record<string, unknown>,
    source: "server",
    savedAt: now,
  });
}

async function seedReviewedRetakePublication(startedAt: Date): Promise<ExamFormSnapshot> {
  const repository = createContentRepository();
  const [pythonCourse, pythonModule, banks] = await Promise.all([
    repository.getCourse("python"),
    repository.getModule("python.toolchain"),
    repository.listAssessmentBanks({ moduleId: "python.toolchain" }),
  ]);
  const sourceSkill = pythonModule?.skills[0];
  const sourceBank = banks.find((bank) => bank.skillId === sourceSkill?.id);
  const sourceItem = sourceBank?.items.find((item) => item.kind === "mcq") ?? sourceBank?.items[0];
  if (!pythonCourse || !pythonModule || !sourceSkill || !sourceBank || !sourceItem) {
    throw new Error("Reviewed retake fixture could not load its source curriculum.");
  }

  const reviewedCourse: CourseManifest = {
    ...pythonCourse,
    id: "integration-reviewed-retake",
    title: "Reviewed retake integration course",
    version: "1.0.0",
    status: "verified",
    modules: [{
      ...pythonModule,
      skills: [{
        ...sourceSkill,
        id: "integration-concept",
        prerequisites: [],
        status: "elective",
      }],
    }],
    coverage_summary: {
      required_skills: 0,
      elective_skills: 1,
      total_skills: 1,
      covered: 1,
      partial: 0,
      planned: 0,
    },
  };
  const reviewedBank: AssessmentBank = {
    ...sourceBank,
    id: "bank.integration-reviewed-retake.integration-concept",
    courseId: reviewedCourse.id,
    courseVersion: reviewedCourse.version,
    skillId: "integration-concept",
    title: "Independently reviewed retake fixture",
    publication: {
      stage: "approved",
      author: { id: "integration-author", displayName: "Integration Author", kind: "human" },
      authoredAt: startedAt.toISOString(),
      aiAssisted: false,
      reviewer: {
        id: "integration-reviewer",
        displayName: "Integration Reviewer",
        kind: "human",
        reviewedAt: startedAt.toISOString(),
        reviewVersion: sourceBank.schemaVersion,
      },
      changeSummary: "Synthetic deterministic form independently reviewed for the disposable PostgreSQL retake fixture.",
    },
    items: [{
      ...sourceItem,
      id: "integration-reviewed-retake-item",
      skillId: "integration-concept",
      examEligibility: {
        eligible: true,
        rationale: "The deterministic oracle is independently reviewed for this disposable concurrency fixture.",
      },
    }],
  };
  const manifestHash = hashCurriculumValue(reviewedCourse);
  const bankHash = hashCurriculumValue(reviewedBank);
  const artifacts = [
    { key: "course.integration-reviewed-retake", type: "course_manifest" as const, hash: manifestHash },
    { key: reviewedBank.id, type: "assessment_bank" as const, hash: bankHash },
  ];
  const contentHash = aggregateArtifactHash(artifacts.map((artifact) => ({
    artifactKey: artifact.key,
    artifactType: artifact.type,
    contentHash: artifact.hash,
  })));
  const reviewedCourseId = "28000000-0000-4000-8000-000000000001";
  const reviewedVersionId = "28000000-0000-4000-8000-000000000002";
  const artifactIds = [
    "28000000-0000-4000-8000-000000000003",
    "28000000-0000-4000-8000-000000000004",
  ];

  await db.update(user).set({ role: "admin" }).where(eq(user.id, USER_B));
  await db.insert(course).values({
    id: reviewedCourseId,
    slug: reviewedCourse.id,
    title: reviewedCourse.title,
    summary: reviewedCourse.summary,
    domain: "testing",
  });
  await db.insert(courseVersion).values({
    id: reviewedVersionId,
    courseId: reviewedCourseId,
    version: reviewedCourse.version,
    stage: "verified",
    scopeStatement: "Synthetic independently reviewed retake fixture.",
    contentHash,
    approvedBy: USER_B,
    publishedAt: startedAt,
  });
  await db.insert(curriculumArtifact).values([
    {
      id: artifactIds[0],
      courseVersionId: reviewedVersionId,
      artifactKey: artifacts[0]!.key,
      artifactType: artifacts[0]!.type,
      sourcePath: "integration/reviewed-retake-course.json",
      content: reviewedCourse as unknown as Record<string, unknown>,
      contentHash: manifestHash,
      publicationStage: "approved",
      reviewStatus: "approved",
      provenance: { fixture: "postgres-retake-parity" },
    },
    {
      id: artifactIds[1],
      courseVersionId: reviewedVersionId,
      artifactKey: artifacts[1]!.key,
      artifactType: artifacts[1]!.type,
      skillKey: reviewedBank.skillId,
      sourcePath: "integration/reviewed-retake-bank.json",
      content: reviewedBank as unknown as Record<string, unknown>,
      contentHash: bankHash,
      publicationStage: "approved",
      reviewStatus: "approved",
      provenance: { fixture: "postgres-retake-parity" },
    },
  ]);
  await db.insert(curriculumReviewEvent).values(artifactIds.map((artifactId, index) => ({
    artifactId,
    reviewerUserId: USER_B,
    reviewerKind: "human",
    decision: "approved",
    requestId: `28000000-0000-4000-8000-00000000001${index}`,
    contentHash: index === 0 ? manifestHash : bankHash,
    checklist: { independentlyReviewed: true },
    reviewedItemIds: index === 0 ? [artifacts[0]!.key] : [reviewedBank.items[0]!.id],
    reason: "Independently approve the synthetic disposable retake parity fixture.",
    resultingVersion: 2,
    occurredAt: startedAt,
  })));
  await db.insert(curriculumReleaseEvidence).values({
    courseVersionId: reviewedVersionId,
    submittedBy: USER_B,
    requestId: "28000000-0000-4000-8000-000000000020",
    evidenceVersion: 1,
    contentHash,
    evidence: { fixture: "postgres-retake-parity", independentlyReviewed: true },
    evidenceHash: "e".repeat(64),
    createdAt: startedAt,
  });
  await db.insert(curriculumPublicationEvent).values({
    courseId: reviewedCourseId,
    courseVersionId: reviewedVersionId,
    actorUserId: USER_B,
    event: "promoted_verified",
    requestId: "28000000-0000-4000-8000-000000000021",
    reason: "Publish the independently reviewed disposable retake parity fixture.",
    evidence: { contentHash },
    evidenceHash: "f".repeat(64),
    occurredAt: startedAt,
  });
  await db.insert(curriculumPublicationPointer).values({
    courseId: reviewedCourseId,
    currentCourseVersionId: reviewedVersionId,
    updatedBy: USER_B,
    reason: "Select the independently reviewed disposable retake parity fixture.",
    updatedAt: startedAt,
  });

  return buildEquivalentExamForm({
    course: reviewedCourse,
    module: reviewedCourse.modules[0]!,
    catalogVersion: `published:${reviewedVersionId}`,
    now: startedAt,
    seed: "failed-python-seed",
    formId: "failed-python-form-v1",
    assessmentBanks: [reviewedBank],
  });
}

async function seedFailedPythonExam(options: { reviewedRetake?: boolean } = {}) {
  await seedLearningGraph();
  const startedAt = new Date("2026-01-02T00:00:00.000Z");
  const finalizedAt = new Date("2026-01-02T00:10:00.000Z");
  const failedForm: ExamFormSnapshot = options.reviewedRetake
    ? await seedReviewedRetakePublication(startedAt)
    : {
    schemaVersion: 1,
    formId: "failed-python-form-v1",
    seed: "failed-python-seed",
    courseId: "python",
    courseTitle: "Python",
    moduleId: "python.toolchain",
    moduleTitle: "Interpreter, scripts and diagnostics",
    contentVersion: "catalog:python-0.1.0",
    policyVersion: EXAM_POLICY_VERSION,
    durationMinutes: 10,
    generatedAt: startedAt.toISOString(),
    instructions: [],
    integrityDisclosure: {
      version: "v1",
      summary: "Integration fixture.",
      capturedEvents: [],
      notCaptured: [],
    },
    items: [{
      id: "failed-item",
      skillId: "integration-concept",
      clusterId: "failed-cluster",
      title: "Failed integration target",
      prompt: "Demonstrate the integration target.",
      kind: "short-answer",
      points: 100,
      critical: true,
      gradingEvidence: {
        kind: "exact-answer",
        acceptedAnswers: ["ok"],
        caseSensitive: false,
      },
    }],
      };
  const remediationTarget = options.reviewedRetake ? "integration-concept" : "failed-cluster";
  const result: ExamResult = {
    schemaVersion: 1,
    gradingStatus: "graded",
    outcome: "NOT_PASSED",
    officialScorePercent: 0,
    earnedPoints: 0,
    possiblePoints: 100,
    pendingReviewItemIds: [],
    failedCriticalClusters: [remediationTarget],
    masteryBlockingCodingItems: [],
    compilationGatePassed: true,
    infrastructureFailure: false,
    finalizedAt: finalizedAt.toISOString(),
    finalizedBy: "learner-submit",
    policyVersion: EXAM_POLICY_VERSION,
    remediation: { required: true, targets: [remediationTarget] },
  };
  await db.insert(attempt).values({
    id: FAILED_EXAM_ATTEMPT_ID,
    userId: USER_A,
    kind: "exam",
    attemptNumber: 1,
    status: "graded",
    policyVersion: EXAM_POLICY_VERSION,
    contentVersion: failedForm.contentVersion,
    score: 0,
    passed: false,
    startedAt,
    submittedAt: finalizedAt,
    gradedAt: finalizedAt,
  });
  await db.insert(examSession).values({
    id: FAILED_EXAM_SESSION_ID,
    attemptId: FAILED_EXAM_ATTEMPT_ID,
    userId: USER_A,
    status: "graded",
    serverStartedAt: startedAt,
    serverDeadlineAt: finalizedAt,
    lastHeartbeatAt: finalizedAt,
    finalizedBy: "learner-submit",
  });
  await db.insert(response).values([
    {
      attemptId: FAILED_EXAM_ATTEMPT_ID,
      itemKey: BLUEPRINT_RESPONSE_KEY,
      revision: 1,
      answer: { snapshot: failedForm },
      source: "server",
      savedAt: startedAt,
      submittedAt: finalizedAt,
    },
    {
      attemptId: FAILED_EXAM_ATTEMPT_ID,
      itemKey: RESULT_RESPONSE_KEY,
      revision: 1,
      answer: { result },
      source: "server",
      savedAt: finalizedAt,
      submittedAt: finalizedAt,
    },
  ]);
}

async function insertRemediationEvidence(id: string, recordedAt: Date) {
  await db.insert(masteryEvidence).values({
    id,
    userId: USER_A,
    enrollmentId: ENROLLMENT_ID,
    conceptId: CONCEPT_ID,
    languageContext: "conceptual",
    evidenceType: JSON.stringify({
      version: 1,
      origin: "deterministic_spec",
      skillId: "integration-concept",
      itemVariantId: id,
      evidenceLevel: "E3",
      assistanceLevel: "A0",
      correct: true,
      learningOpportunity: true,
      solutionRevealed: false,
      misconceptionTags: [],
      languageContext: "conceptual",
    }),
    sourceType: "deterministic_attempt",
    sourceId: id,
    score: 1,
    weight: 1,
    criticalCriterion: "core",
    validity: "valid",
    policyVersion: "adaptive-learning-v1",
    recordedBy: "adaptive-deterministic-engine",
    recordedAt,
  });
}

beforeEach(async () => {
  await truncateApplicationTables();
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL migration contract", () => {
  it("applies every migration and remains idempotent when rerun", async () => {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const names = new Set(tables.rows.map((row) => row.table_name));
    for (const required of [
      "invitation",
      "provider_credential",
      "learning_session",
      "mastery_evidence",
      "exam_session",
      "response",
      "stored_object",
      "quota_ledger",
      "api_rate_limit_window",
      "data_lifecycle_run",
      "account_deletion_tombstone",
      "appeal_event",
    ]) {
      expect(names.has(required), `missing migrated table ${required}`).toBe(true);
    }

    const migrationRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    const migrationFiles = (await readdir(path.join(process.cwd(), "drizzle")))
      .filter((name) => /^\d+_.+\.sql$/.test(name));
    expect(Number(migrationRows.rows[0]?.count)).toBe(migrationFiles.length);

    const indexes = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `);
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const required of [
      "invitation_token_hash_unique",
      "mastery_evidence_source_unique",
      "response_revision_unique",
      "exam_event_idempotency",
      "quota_idempotency_unique",
      "api_rate_limit_expiry_idx",
      "session_one_active_user_unique",
      "data_lifecycle_run_idempotency_unique",
      "account_deletion_tombstone_user_unique",
      "stored_object_retention_idx",
      "appeal_submission_request_unique",
      "appeal_open_attempt_unique",
      "appeal_event_request_unique",
    ]) {
      expect(indexNames.has(required), `missing migrated index ${required}`).toBe(true);
    }

    const constraints = await pool.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
    `);
    const constraintNames = new Set(constraints.rows.map((row) => row.conname));
    for (const required of [
      "stored_object_retention_class_check",
      "data_lifecycle_run_operation_check",
      "data_lifecycle_run_idempotency_key_length",
      "data_lifecycle_run_json_object_check",
      "account_deletion_identity_hash_length",
      "account_deletion_backup_window_check",
      "account_deletion_report_object_check",
      "appeal_target_check",
      "appeal_status_check",
      "appeal_evidence_hash_check",
      "appeal_event_reason_length",
    ]) {
      expect(constraintNames.has(required), `missing migrated constraint ${required}`).toBe(true);
    }
  });
});

describe("one active authentication device", () => {
  it("admits exactly one concurrent login, preserves it on a blocked login, archives logout, and allows audited admin revocation", async () => {
    await seedUsers();
    const password = "integration-login-password-123!";
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, USER_A));
    await db
      .update(user)
      .set({ role: "admin", emailVerified: true })
      .where(eq(user.id, USER_B));
    await db.insert(account).values({
      id: "integration-credential-account",
      accountId: USER_A,
      providerId: "credential",
      userId: USER_A,
      password: await hashPassword(password),
    });

    const signIn = (userAgent: string) => auth.api.signInEmail({
      asResponse: true,
      headers: new Headers({ "user-agent": userAgent }),
      body: {
        email: "learner-a@integration.invalid",
        password,
        rememberMe: true,
      },
    });
    const concurrent = await Promise.allSettled([
      signIn("Integration Browser A"),
      signIn("Integration Browser B"),
    ]);
    const successful = concurrent
      .filter((result): result is PromiseFulfilledResult<Response> =>
        result.status === "fulfilled" && result.value.ok,
      )
      .map((result) => result.value);
    expect(successful).toHaveLength(1);
    const [firstActive] = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, USER_A));
    expect(firstActive?.id).toBeTruthy();

    const blocked = await signIn("Integration Browser C").catch(() => null);
    expect(blocked?.ok ?? false).toBe(false);
    const afterBlocked = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, USER_A));
    expect(afterBlocked).toEqual([{ id: firstActive?.id }]);

    const setCookie = successful[0]!.headers.get("set-cookie") ?? "";
    const authCookie = setCookie.match(/learncoding\.session_token=[^;,\s]+/)?.[0];
    expect(authCookie).toBeTruthy();
    const signedOut = await auth.api.signOut({
      asResponse: true,
      headers: new Headers({ cookie: authCookie! }),
    });
    expect(signedOut.ok).toBe(true);
    expect(await db.select().from(session).where(eq(session.userId, USER_A))).toHaveLength(0);
    const afterLogout = await db
      .select({ originalSessionId: authSessionHistory.originalSessionId, endReason: authSessionHistory.endReason })
      .from(authSessionHistory)
      .where(eq(authSessionHistory.userId, USER_A));
    expect(afterLogout).toEqual([{ originalSessionId: firstActive?.id, endReason: "learner_logout" }]);

    const replacement = await signIn("Integration Browser D");
    expect(replacement.ok).toBe(true);
    const [replacementRow] = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, USER_A));
    expect(replacementRow?.id).toBeTruthy();
    expect(replacementRow?.id).not.toBe(firstActive?.id);
    await expect(revokeOneOwnedSession({
      userId: USER_A,
      sessionId: replacementRow!.id,
      actorUserId: USER_B,
      reason: "admin_revoked",
    })).resolves.toBe(true);
    expect(await db.select().from(session).where(eq(session.userId, USER_A))).toHaveLength(0);
    const history = await db
      .select({ originalSessionId: authSessionHistory.originalSessionId, endReason: authSessionHistory.endReason })
      .from(authSessionHistory)
      .where(eq(authSessionHistory.userId, USER_A));
    expect(history).toEqual(expect.arrayContaining([
      { originalSessionId: firstActive?.id, endReason: "learner_logout" },
      { originalSessionId: replacementRow?.id, endReason: "admin_revoked" },
    ]));

    await db.insert(session).values({
      id: "expired-device-family",
      userId: USER_A,
      token: "integration-expired-session-token",
      expiresAt: new Date(Date.now() - 60_000),
      lastSeenAt: new Date(Date.now() - 120_000),
    });
    const afterExpiry = await signIn("Integration Browser E");
    expect(afterExpiry.ok).toBe(true);
    const expiredHistory = await db
      .select({ endReason: authSessionHistory.endReason })
      .from(authSessionHistory)
      .where(eq(authSessionHistory.originalSessionId, "expired-device-family"));
    expect(expiredHistory).toEqual([{ endReason: "expired" }]);
    expect(await db.select().from(session).where(eq(session.userId, USER_A))).toHaveLength(1);
  });
});

describe("distributed API rate limiting", () => {
  it("atomically admits only the configured concurrent budget and isolates keys", async () => {
    const store = new PostgresRateLimitStore(pool, Number.POSITIVE_INFINITY);
    const now = new Date("2026-07-12T10:00:10.000Z");
    const consume = (keyHash: string) => store.consume({
      scope: "code_run_minute",
      keyHash,
      limit: 7,
      windowSeconds: 60,
      now,
    });
    const sameKey = await Promise.all(
      Array.from({ length: 40 }, () => consume("a".repeat(64))),
    );
    expect(sameKey.filter((result) => result.count <= 7)).toHaveLength(7);
    expect(sameKey.filter((result) => result.count === 8)).toHaveLength(33);

    const isolated = await consume("b".repeat(64));
    expect(isolated.count).toBe(1);
    const rows = await db.select().from(apiRateLimitWindow);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.keyHash === "a".repeat(64))?.requestCount).toBe(8);
    expect(rows.find((row) => row.keyHash === "b".repeat(64))?.requestCount).toBe(1);
  });

  it("enforces database checks that exclude malformed/raw identity keys", async () => {
    await expect(pool.query(
      `INSERT INTO api_rate_limit_window
        (scope, key_hash, window_start, request_count, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["access_request_email", "raw.person@example.com", new Date(0), 1, new Date(60_000)],
    )).rejects.toMatchObject({ code: "23514" });
  });
});

describe("single-use invitations", () => {
  it("atomically allows one token consumer and rejects replay, expiry, and email mismatch", async () => {
    const rawToken = "integration-only-invitation-token-that-is-never-real";
    const invitationId = "30000000-0000-4000-8000-000000000001";
    await db.insert(invitation).values({
      id: invitationId,
      email: "invited@integration.invalid",
      tokenHash: hashInvitationToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect((await findUsableInvitationByToken(rawToken))?.id).toBe(invitationId);
    const claims = await Promise.all(
      Array.from({ length: 12 }, () =>
        consumeInvitationByToken({
          rawToken,
          expectedEmail: "INVITED@integration.invalid",
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await findUsableInvitationByToken(rawToken)).toBeNull();
    expect(
      await consumeInvitationByToken({
        rawToken,
        expectedEmail: "invited@integration.invalid",
      }),
    ).toBeNull();

    const mismatchToken = `${rawToken}-mismatch`;
    await db.insert(invitation).values({
      email: "right@integration.invalid",
      tokenHash: hashInvitationToken(mismatchToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      await consumeInvitationByToken({
        rawToken: mismatchToken,
        expectedEmail: "wrong@integration.invalid",
      }),
    ).toBeNull();
    expect(await findUsableInvitationByToken(mismatchToken)).not.toBeNull();

    const expiredToken = `${rawToken}-expired`;
    await db.insert(invitation).values({
      email: "expired@integration.invalid",
      tokenHash: hashInvitationToken(expiredToken),
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(
      await consumeInvitationByToken({
        rawToken: expiredToken,
        expectedEmail: "expired@integration.invalid",
      }),
    ).toBeNull();

    const [stored] = await db
      .select({ tokenHash: invitation.tokenHash })
      .from(invitation)
      .where(eq(invitation.id, invitationId));
    expect(stored.tokenHash).toBe(hashInvitationToken(rawToken));
    expect(stored.tokenHash).not.toContain(rawToken);
  });

  it("blocks direct Better Auth signup and activates exactly once through the token-bound endpoint", async () => {
    const rawToken = "integration-auth-activation-token-that-is-never-real";
    const email = "auth-activation@integration.invalid";
    const invitationId = "30000000-0000-4000-8000-000000000010";
    await db.insert(invitation).values({
      id: invitationId,
      email,
      tokenHash: hashInvitationToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      auth.api.signUpEmail({
        body: {
          email,
          name: "Blocked direct signup",
          password: "integration-only-password-123!",
        },
      }),
    ).rejects.toBeDefined();
    expect(
      await db.select({ id: user.id }).from(user).where(eq(user.email, email)),
    ).toHaveLength(0);

    const request = new NextRequest("http://localhost/api/invitations/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: rawToken,
        name: "Token Bound Learner",
        password: "integration-only-password-123!",
      }),
    });
    const activated = await activateInvitation(request);
    expect(activated.status).toBe(201);
    expect(await activated.json()).toEqual({ ok: true });

    const createdUsers = await db
      .select({ id: user.id, profileUserId: learnerProfile.userId })
      .from(user)
      .innerJoin(learnerProfile, eq(learnerProfile.userId, user.id))
      .where(eq(user.email, email));
    expect(createdUsers).toHaveLength(1);
    const [consumed] = await db
      .select({ consumedAt: invitation.consumedAt })
      .from(invitation)
      .where(eq(invitation.id, invitationId));
    expect(consumed.consumedAt).toBeInstanceOf(Date);

    const replay = await activateInvitation(
      new NextRequest("http://localhost/api/invitations/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: rawToken,
          name: "Replay Learner",
          password: "integration-only-password-456!",
        }),
      }),
    );
    expect(replay.status).toBe(404);
    expect(
      await db.select({ id: user.id }).from(user).where(eq(user.email, email)),
    ).toHaveLength(1);
  });
});

describe("tenant boundaries and encrypted credentials", () => {
  it("does not return another learner's session or attempt through the learning repository", async () => {
    await seedLearningGraph();
    const store = new DrizzleLearningStore();
    const sessionId = "40000000-0000-4000-8000-000000000001";
    await store.transaction((tx) =>
      tx.insertSession({
        id: sessionId,
        userId: USER_A,
        enrollmentId: ENROLLMENT_ID,
        goal: "integration boundary check",
        plannedMinutes: 15,
        reviewOnly: false,
        now: new Date(),
      }),
    );

    const result = await store.transaction(async (tx) => ({
      ownSession: await tx.getSession(USER_A, sessionId),
      crossTenantSession: await tx.getSession(USER_B, sessionId),
      ownAttempt: await tx.getAttempt(USER_A, LEARNING_ATTEMPT_ID),
      crossTenantAttempt: await tx.getAttempt(USER_B, LEARNING_ATTEMPT_ID),
    }));
    expect(result.ownSession?.id).toBe(sessionId);
    expect(result.crossTenantSession).toBeNull();
    expect(result.ownAttempt?.attempt.id).toBe(LEARNING_ATTEMPT_ID);
    expect(result.crossTenantAttempt).toBeNull();
  });

  it("persists ciphertext and metadata only, while retaining authenticated decryptability", async () => {
    await seedUsers();
    const credentialId = "50000000-0000-4000-8000-000000000001";
    const plaintext = ["nv", "api", "-integration-fake-never-valid-1234"].join("");
    const masterKey = Buffer.alloc(32, 7);
    const context = {
      credentialId,
      userId: USER_A,
      provider: "nvidia_nim",
      keyVersion: 1,
    };
    const sealed = sealCredential(plaintext, context, masterKey);
    await db.insert(providerCredential).values({
      id: credentialId,
      userId: USER_A,
      provider: "nvidia_nim",
      label: "Integration fake",
      ...sealed,
    });

    const raw = await pool.query<Record<string, unknown>>(
      `SELECT * FROM provider_credential WHERE id = $1`,
      [credentialId],
    );
    const serialized = JSON.stringify(raw.rows[0]);
    expect(serialized).not.toContain(plaintext);
    expect(raw.rows[0]?.ciphertext).not.toBe(plaintext);
    expect(raw.rows[0]?.last_four).toBe("1234");
    expect(openCredential(sealed, context, masterKey)).toBe(plaintext);
    masterKey.fill(0);

    const columns = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'provider_credential'
    `);
    const columnNames = columns.rows.map((row) => row.column_name);
    expect(columnNames).not.toContain("secret");
    expect(columnNames).not.toContain("plaintext");
    expect(columnNames).not.toContain("api_key");
  });
});

describe("serialized quota reservation", () => {
  it("cannot overbook a learner's quota during concurrent uploads", async () => {
    await seedUsers({ quota: 100 });
    const reservation = (objectId: string, storageKey: string, sizeBytes: number) =>
      reserveStoredObject({
        objectId,
        userId: USER_A,
        storageKey,
        originalName: `${storageKey}.txt`,
        mediaType: "text/plain",
        sizeBytes,
        sha256: "a".repeat(64),
        scanStatus: "clean",
      });

    const competing = await Promise.allSettled([
      reservation("60000000-0000-4000-8000-000000000001", "quota/a", 60),
      reservation("60000000-0000-4000-8000-000000000002", "quota/b", 60),
    ]);
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = competing.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(StorageQuotaExceededError);

    const [usage] = await db
      .select({ bytes: sql<number>`coalesce(sum(${storedObject.sizeBytes}), 0)` })
      .from(storedObject)
      .where(eq(storedObject.ownerUserId, USER_A));
    expect(Number(usage.bytes)).toBe(60);
    expect(await db.select().from(quotaLedger)).toHaveLength(1);

    await reservation("60000000-0000-4000-8000-000000000003", "quota/c", 40);
    await expect(
      reservation("60000000-0000-4000-8000-000000000004", "quota/d", 1),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);
    const [finalUsage] = await db
      .select({ bytes: sql<number>`coalesce(sum(${storedObject.sizeBytes}), 0)` })
      .from(storedObject)
      .where(eq(storedObject.ownerUserId, USER_A));
    expect(Number(finalUsage.bytes)).toBe(100);
    expect(await db.select().from(quotaLedger)).toHaveLength(2);
  });
});

describe("atomic administrator fallback budget", () => {
  it("never overspends under concurrent reservations and refunds only unused tokens", async () => {
    await seedUsers();
    const credentialId = "31000000-0000-4000-8000-000000000001";
    const grantId = "31000000-0000-4000-8000-000000000002";
    await db.update(user).set({ role: "admin" }).where(eq(user.id, USER_B));
    await db.insert(providerCredential).values({
      id: credentialId,
      userId: USER_B,
      provider: "nvidia_nim",
      label: "Concurrent fallback fixture",
      ciphertext: "fixture-ciphertext",
      wrappedDataKey: "fixture-wrapped-key",
      wrapIv: "fixture-wrap-iv",
      dataIv: "fixture-data-iv",
      authTag: "fixture-auth-tag",
      lastFour: "N1M4",
      status: "active",
    });
    await db.insert(consentRecord).values([
      consentInsert({
        userId: USER_A,
        purpose: "admin_fallback_ai",
        decision: "accepted",
        source: "settings",
        requestId: "fallback-budget-admin-consent",
      }),
      consentInsert({
        userId: USER_A,
        purpose: "provider:nvidia_nim",
        decision: "accepted",
        source: "settings",
        requestId: "fallback-budget-provider-consent",
      }),
    ]);
    await db.insert(adminFallbackGrant).values({
      id: grantId,
      learnerId: USER_A,
      credentialId,
      provider: "nvidia_nim",
      model: "offline/fallback-model",
      tokenBudget: 1_000,
      rupeeBudgetPaise: 500,
      inputPaisePerMillionTokens: 100_000,
      outputPaisePerMillionTokens: 200_000,
      startsAt: new Date("2026-07-11T00:00:00.000Z"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      grantedBy: USER_B,
    });

    const reservations = await Promise.all(
      Array.from({ length: 10 }, (_, index) => reserveFallbackBudget({
        reservationId: `32000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        grantId,
        learnerId: USER_A,
        credentialId,
        provider: "nvidia_nim",
        model: "offline/fallback-model",
        tokens: 200,
        costPaise: 100,
        now: new Date("2026-07-12T00:00:00.000Z"),
      })),
    );
    expect(reservations.filter(Boolean)).toHaveLength(5);
    const successfulIndex = reservations.findIndex(Boolean);
    const reconciledReservationId = `32000000-0000-4000-8000-${String(successfulIndex).padStart(12, "0")}`;
    let [grant] = await db
      .select({
        tokensUsed: adminFallbackGrant.tokensUsed,
        rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
      })
      .from(adminFallbackGrant)
      .where(eq(adminFallbackGrant.id, grantId));
    expect(grant.tokensUsed).toBe(1_000);
    expect(grant.rupeesUsedPaise).toBe(500);

    await reconcileFallbackBudget({
      reservationId: reconciledReservationId,
      grantId,
      learnerId: USER_A,
      reservedTokens: 200,
      reservedCostPaise: 100,
      actualTokens: 50,
      actualCostPaise: 25,
    });
    // Exact reconciliation replays are no-ops rather than double refunds.
    await reconcileFallbackBudget({
      reservationId: reconciledReservationId,
      grantId,
      learnerId: USER_A,
      reservedTokens: 200,
      reservedCostPaise: 100,
      actualTokens: 50,
      actualCostPaise: 25,
    });
    await expect(reserveFallbackBudget({
      reservationId: "33000000-0000-4000-8000-000000000001",
      grantId,
      learnerId: USER_A,
      credentialId,
      provider: "nvidia_nim",
      model: "offline/fallback-model",
      tokens: 151,
      costPaise: 75,
    })).resolves.toBe(false);
    await expect(reserveFallbackBudget({
      reservationId: "33000000-0000-4000-8000-000000000002",
      grantId,
      learnerId: USER_A,
      credentialId,
      provider: "nvidia_nim",
      model: "offline/fallback-model",
      tokens: 150,
      costPaise: 75,
    })).resolves.toBe(true);

    [grant] = await db
      .select({
        tokensUsed: adminFallbackGrant.tokensUsed,
        rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
      })
      .from(adminFallbackGrant)
      .where(eq(adminFallbackGrant.id, grantId));
    expect(grant.tokensUsed).toBe(1_000);
    expect(grant.rupeesUsedPaise).toBe(500);
    expect(await db.select().from(adminFallbackReservation)).toHaveLength(6);
    await expect(reserveFallbackBudget({
      reservationId: "33000000-0000-4000-8000-000000000003",
      grantId,
      learnerId: USER_B,
      credentialId,
      provider: "nvidia_nim",
      model: "offline/fallback-model",
      tokens: 1,
      costPaise: 1,
    })).resolves.toBe(false);
  });
});

describe("exam persistence", () => {
  it("serializes autosaves, detects stale revisions, enforces ownership, and deduplicates events", async () => {
    await seedExam();
    const autosave = (clientMutationId: string) =>
      autosaveExamAnswer({
        userId: USER_A,
        sessionId: EXAM_SESSION_ID,
        clientMutationId,
        itemId: "item-1",
        baseRevision: 0,
        answer: { text: "first" },
      });
    const competing = await Promise.allSettled([
      autosave("21000000-0000-4000-8000-000000000001"),
      autosave("21000000-0000-4000-8000-000000000002"),
    ]);
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const conflict = competing.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(conflict?.reason).toBeInstanceOf(ExamServiceError);
    expect((conflict?.reason as ExamServiceError).code).toBe("AUTOSAVE_REVISION_CONFLICT");

    const second = await autosaveExamAnswer({
      userId: USER_A,
      sessionId: EXAM_SESSION_ID,
      clientMutationId: "21000000-0000-4000-8000-000000000003",
      itemId: "item-1",
      baseRevision: 1,
      answer: { text: "second" },
    });
    expect(second.revision).toBe(2);
    await expect(
      autosaveExamAnswer({
        userId: USER_A,
        sessionId: EXAM_SESSION_ID,
        clientMutationId: "21000000-0000-4000-8000-000000000004",
        itemId: "item-1",
        baseRevision: 1,
        answer: { text: "stale" },
      }),
    ).rejects.toMatchObject({ code: "AUTOSAVE_REVISION_CONFLICT", status: 409 });
    await expect(
      autosaveExamAnswer({
        userId: USER_B,
        sessionId: EXAM_SESSION_ID,
        clientMutationId: "21000000-0000-4000-8000-000000000005",
        itemId: "item-1",
        baseRevision: 2,
        answer: { text: "cross-tenant" },
      }),
    ).rejects.toMatchObject({ code: "EXAM_NOT_FOUND", status: 404 });

    const eventInput = {
      userId: USER_A,
      sessionId: EXAM_SESSION_ID,
      clientEventId: "client-event-1",
      type: "visibility_hidden" as const,
      metadata: { route: "/exams/fixture", secret: "must-be-removed" },
    };
    const eventResults = await Promise.all([
      recordExamEvent(eventInput),
      recordExamEvent(eventInput),
      recordExamEvent(eventInput),
    ]);
    expect(eventResults.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(eventResults.filter((result) => result.duplicate)).toHaveLength(2);
    expect(
      await db
        .select()
        .from(examEvent)
        .where(eq(examEvent.examSessionId, EXAM_SESSION_ID)),
    ).toHaveLength(1);

    const answerRows = await db
      .select({ revision: response.revision, answer: response.answer })
      .from(response)
      .where(
        and(
          eq(response.attemptId, EXAM_ATTEMPT_ID),
          eq(response.itemKey, "item-1"),
        ),
      );
    expect(answerRows.map((row) => row.revision).sort()).toEqual([1, 2]);
    expect(answerRows.some((row) => row.answer.text === "cross-tenant")).toBe(false);
  });

  it("serializes concurrent exam starts so exactly one active form is created", async () => {
    await seedUsers();
    const now = new Date("2026-01-03T00:00:00.000Z");
    const starts = await Promise.allSettled([
      startExam(USER_A, startInput, now),
      startExam(USER_A, startInput, now),
    ]);
    expect(starts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const denied = starts.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    expect(denied?.reason).toMatchObject({ code: "EXAM_ALREADY_ACTIVE", status: 409 });
    const activeRows = await db
      .select({ id: examSession.id })
      .from(examSession)
      .where(and(eq(examSession.userId, USER_A), eq(examSession.status, "active")));
    expect(activeRows).toHaveLength(1);
  });

  it("keeps transaction history reads pg9-safe while enforcing persisted remediation and cooldown", async () => {
    const concurrentQueryWarnings: Error[] = [];
    const onWarning = (warning: Error) => {
      if (
        warning.name === "DeprecationWarning" &&
        warning.message.includes("client.query() when the client is already executing a query")
      ) {
        concurrentQueryWarnings.push(warning);
      }
    };
    process.on("warning", onWarning);
    try {
      await seedFailedPythonExam({ reviewedRetake: true });
      const forged = { ...startInput, remediationComplete: true };
      await expect(
        startExam(USER_A, forged, new Date("2026-01-02T02:00:00.000Z")),
      ).rejects.toMatchObject({
        code: "RETAKE_NOT_ELIGIBLE",
        details: { retake: { reason: "remediation-required" } },
      });

      await insertRemediationEvidence(
        "30000000-0000-4000-8000-000000000001",
        new Date("2026-01-02T00:09:59.000Z"),
      );
      await expect(
        startExam(USER_A, startInput, new Date("2026-01-02T02:00:00.000Z")),
      ).rejects.toMatchObject({
        code: "RETAKE_NOT_ELIGIBLE",
        details: { retake: { reason: "remediation-required" } },
      });

      await insertRemediationEvidence(
        "30000000-0000-4000-8000-000000000002",
        new Date("2026-01-02T00:11:00.000Z"),
      );
      await expect(
        startExam(USER_A, startInput, new Date("2026-01-02T01:09:59.999Z")),
      ).rejects.toMatchObject({
        code: "RETAKE_NOT_ELIGIBLE",
        details: { retake: { reason: "cooldown" } },
      });

      const admitted = await startExam(
        USER_A,
        startInput,
        new Date("2026-01-02T01:10:00.000Z"),
      );
      expect(admitted.attemptNumber).toBe(2);
      expect(admitted.status).toBe("active");
      // Deprecation warnings are dispatched on a later turn of the event loop.
      // Give Node that turn so this assertion catches the pg 8 warning that
      // becomes a hard failure in pg 9.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(concurrentQueryWarnings).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });
});

describe("assessment appeal adjudication", () => {
  it("preserves immutable evidence and provides versioned, idempotent human decisions with learner notices", async () => {
    await seedFailedPythonExam();
    await db.update(user).set({ role: "admin" }).where(eq(user.id, USER_B));
    const submissionRequestId = "61000000-0000-4000-8000-000000000001";
    const submittedAt = new Date("2026-01-02T00:11:00.000Z");
    const reason = "The recorded score does not match the answer I submitted.";
    const submitted = await submitExamAppeal({
      userId: USER_A,
      sessionId: FAILED_EXAM_SESSION_ID,
      clientRequestId: submissionRequestId,
      category: "scoring",
      reason,
      now: submittedAt,
    });
    expect(submitted).toMatchObject({ accepted: true, duplicate: false });

    const replay = await submitExamAppeal({
      userId: USER_A,
      sessionId: FAILED_EXAM_SESSION_ID,
      clientRequestId: submissionRequestId,
      category: "scoring",
      reason,
      now: submittedAt,
    });
    expect(replay).toEqual({ ...submitted, duplicate: true });
    await expect(submitExamAppeal({
      userId: USER_A,
      sessionId: FAILED_EXAM_SESSION_ID,
      clientRequestId: submissionRequestId,
      category: "scoring",
      reason: "The same id must never be accepted with a changed learner claim.",
      now: submittedAt,
    })).rejects.toMatchObject({ code: "APPEAL_IDEMPOTENCY_MISMATCH", status: 409 });
    await expect(submitExamAppeal({
      userId: USER_A,
      sessionId: FAILED_EXAM_SESSION_ID,
      clientRequestId: "61000000-0000-4000-8000-000000000002",
      category: "technical",
      reason: "A second active appeal must not shadow the original evidence.",
      now: submittedAt,
    })).rejects.toMatchObject({ code: "APPEAL_ALREADY_OPEN", status: 409 });

    const [storedBefore] = await db
      .select({
        evidence: appeal.evidence,
        evidenceHash: appeal.evidenceHash,
        rowVersion: appeal.rowVersion,
        status: appeal.status,
      })
      .from(appeal)
      .where(eq(appeal.id, submitted.appealId));
    expect(storedBefore).toMatchObject({ rowVersion: 1, status: "open" });
    expect(storedBefore?.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    const serializedEvidence = JSON.stringify(storedBefore?.evidence);
    expect(serializedEvidence).not.toContain("failed-python-seed");
    expect(serializedEvidence).not.toContain('"acceptedAnswers"');
    await expect(pool.query(
      `update appeal set evidence = jsonb_build_object('tampered', true) where id = $1`,
      [submitted.appealId],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `update appeal_event set reason = 'tampered event content' where appeal_id = $1`,
      [submitted.appealId],
    )).rejects.toMatchObject({ code: "23514" });

    const detail = await getAdminAppealDetail(submitted.appealId);
    expect(detail.appeal.evidenceHashValid).toBe(true);
    expect(detail.publicForm).not.toHaveProperty("seed");
    expect(detail.publicForm?.items[0]).not.toHaveProperty("gradingEvidence");
    expect(detail.timeline).toHaveLength(1);
    expect(detail.timeline[0]).toMatchObject({ actorRole: "learner", event: "submitted", reason });

    await expect(decideAppeal({
      actorUserId: USER_B,
      appealId: submitted.appealId,
      requestId: "62000000-0000-4000-8000-000000000001",
      expectedVersion: 2,
      decision: "upheld",
      reason: "This intentionally stale version must be rejected without mutation.",
      now: new Date("2026-01-02T00:12:00.000Z"),
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const decisionInput = {
      actorUserId: USER_B,
      appealId: submitted.appealId,
      requestId: "62000000-0000-4000-8000-000000000002",
      expectedVersion: 1,
      decision: "overturned" as const,
      reason: "The immutable response evidence confirms that the original grade is incorrect.",
      correctiveAction: "Regrade the pinned form and append a superseding result through controlled review.",
      now: new Date("2026-01-02T00:13:00.000Z"),
    };
    const decision = await decideAppeal(decisionInput);
    expect(decision).toMatchObject({
      appealId: submitted.appealId,
      userId: USER_A,
      decision: "overturned",
      rowVersion: 2,
      correctionPending: true,
      replayed: false,
    });
    expect(await decideAppeal(decisionInput)).toMatchObject({
      appealId: submitted.appealId,
      decision: "overturned",
      rowVersion: 2,
      replayed: true,
    });
    await expect(decideAppeal({
      ...decisionInput,
      reason: "A reused decision id cannot carry a different administrator rationale.",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    const [storedAfter] = await db
      .select({
        evidence: appeal.evidence,
        evidenceHash: appeal.evidenceHash,
        rowVersion: appeal.rowVersion,
        status: appeal.status,
        decision: appeal.decision,
        decisionReason: appeal.decisionReason,
      })
      .from(appeal)
      .where(eq(appeal.id, submitted.appealId));
    expect(storedAfter).toMatchObject({
      evidence: storedBefore?.evidence,
      evidenceHash: storedBefore?.evidenceHash,
      rowVersion: 2,
      status: "overturned",
      decision: "overturned",
      decisionReason: decisionInput.reason,
    });
    const timeline = await db
      .select({ event: appealEvent.event, actorRole: appealEvent.actorRole, evidence: appealEvent.evidence })
      .from(appealEvent)
      .where(eq(appealEvent.appealId, submitted.appealId));
    expect(timeline).toHaveLength(2);
    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "submitted", actorRole: "learner" }),
      expect.objectContaining({
        event: "overturned",
        actorRole: "admin",
        evidence: expect.objectContaining({ correctiveAction: decisionInput.correctiveAction }),
      }),
    ]));

    const [examState] = await db
      .select({ status: examSession.status, integrity: examSession.integrityReviewState })
      .from(examSession)
      .where(eq(examSession.id, FAILED_EXAM_SESSION_ID));
    expect(examState).toEqual({ status: "under_review", integrity: "appeal_overturned_correction_pending" });
    const [originalResult] = await db
      .select({ answer: response.answer })
      .from(response)
      .where(and(
        eq(response.attemptId, FAILED_EXAM_ATTEMPT_ID),
        eq(response.itemKey, RESULT_RESPONSE_KEY),
      ));
    expect((originalResult?.answer.result as { officialScorePercent: number }).officialScorePercent).toBe(0);

    const notices = await db
      .select({ type: notification.type, title: notification.title, body: notification.body })
      .from(notification)
      .where(eq(notification.userId, USER_A));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "appeal-updated", title: "Your appeal was granted" });
    expect(notices[0]?.body).toContain(decisionInput.reason);
    const mail = await db
      .select({ template: emailOutbox.template, variables: emailOutbox.variables, status: emailOutbox.status })
      .from(emailOutbox)
      .where(eq(emailOutbox.userId, USER_A));
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      template: "appeal-updated",
      status: "pending",
      variables: expect.objectContaining({ decision: "overturned" }),
    });
    expect(JSON.stringify(mail[0]?.variables)).not.toContain(decisionInput.reason);
  });

  it("supports an idempotent learner clarification without overwriting the reviewer request", async () => {
    await seedFailedPythonExam();
    await db.update(user).set({ role: "admin" }).where(eq(user.id, USER_B));
    const submitted = await submitExamAppeal({
      userId: USER_A,
      sessionId: FAILED_EXAM_SESSION_ID,
      clientRequestId: "63000000-0000-4000-8000-000000000001",
      category: "technical",
      reason: "The reviewer should inspect the saved answer revision and timing.",
      now: new Date("2026-01-02T00:11:00.000Z"),
    });
    const clarificationReason = "Please identify the exact saved answer revision that should be reviewed.";
    await decideAppeal({
      actorUserId: USER_B,
      appealId: submitted.appealId,
      requestId: "63000000-0000-4000-8000-000000000002",
      expectedVersion: 1,
      decision: "needs_learner_input",
      reason: clarificationReason,
      now: new Date("2026-01-02T00:12:00.000Z"),
    });
    const replyInput = {
      userId: USER_A,
      sessionId: FAILED_EXAM_SESSION_ID,
      clientRequestId: "63000000-0000-4000-8000-000000000003",
      message: "Please inspect failed-item revision one, saved before final submission.",
      now: new Date("2026-01-02T00:13:00.000Z"),
    };
    expect(await submitExamAppealReply(replyInput)).toEqual({
      accepted: true,
      duplicate: false,
      appealId: submitted.appealId,
      rowVersion: 3,
    });
    expect(await submitExamAppealReply(replyInput)).toEqual({
      accepted: true,
      duplicate: true,
      appealId: submitted.appealId,
      rowVersion: 3,
    });
    await expect(submitExamAppealReply({
      ...replyInput,
      message: "A reused reply id must not accept different learner evidence.",
    })).rejects.toMatchObject({ code: "APPEAL_REPLY_IDEMPOTENCY_MISMATCH", status: 409 });
    await expect(submitExamAppealReply({
      ...replyInput,
      clientRequestId: "63000000-0000-4000-8000-000000000004",
    })).rejects.toMatchObject({ code: "APPEAL_REPLY_NOT_REQUESTED", status: 409 });
    await expect(submitExamAppealReply({
      ...replyInput,
      userId: USER_B,
      clientRequestId: "63000000-0000-4000-8000-000000000005",
    })).rejects.toMatchObject({ code: "EXAM_NOT_FOUND", status: 404 });

    const [projection] = await db
      .select({
        status: appeal.status,
        decision: appeal.decision,
        decisionReason: appeal.decisionReason,
        rowVersion: appeal.rowVersion,
      })
      .from(appeal)
      .where(eq(appeal.id, submitted.appealId));
    expect(projection).toEqual({
      status: "under_review",
      decision: "needs_learner_input",
      decisionReason: clarificationReason,
      rowVersion: 3,
    });
    const events = await db
      .select({ event: appealEvent.event, actorRole: appealEvent.actorRole, reason: appealEvent.reason })
      .from(appealEvent)
      .where(eq(appealEvent.appealId, submitted.appealId));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "submitted", actorRole: "learner" }),
      expect.objectContaining({ event: "needs_learner_input", actorRole: "admin", reason: clarificationReason }),
      expect.objectContaining({ event: "learner_response", actorRole: "learner", reason: replyInput.message }),
    ]));
    const [examState] = await db
      .select({ status: examSession.status, integrity: examSession.integrityReviewState })
      .from(examSession)
      .where(eq(examSession.id, FAILED_EXAM_SESSION_ID));
    expect(examState).toEqual({
      status: "under_review",
      integrity: "appeal_pending_after_learner_response",
    });
    const adminNotices = await db
      .select({ title: notification.title, actionUrl: notification.actionUrl })
      .from(notification)
      .where(eq(notification.userId, USER_B));
    expect(adminNotices).toEqual([{
      title: "A learner replied to an appeal",
      actionUrl: `/admin/appeals?appeal=${submitted.appealId}`,
    }]);
  });
});

describe("append-only learning evidence", () => {
  it("deduplicates the same official source while preserving distinct evidence rows", async () => {
    await seedLearningGraph();
    const store = new DrizzleLearningStore();
    const now = new Date("2026-01-02T00:00:00.000Z");
    const result = await store.transaction(async (tx) => {
      const context = await tx.getAttempt(USER_A, LEARNING_ATTEMPT_ID);
      if (!context) throw new Error("Integration fixture attempt was not resolved.");
      const base: Omit<MasteryWriteInput, "evidenceSourceId"> = {
        userId: USER_A,
        attempt: context,
        transition: {
          observation: {
            id: "observation-1",
            skillId: "integration-concept",
            itemVariantId: "variant-1",
            evidenceLevel: "E3",
            assistanceLevel: "A0",
            correct: true,
            occurredAtMs: now.getTime(),
            learningOpportunity: true,
          },
          progress: {
            skillId: "integration-concept",
            stage: "INDEPENDENT_PRACTICE",
            masteryProbability: 0.85,
            activeMisconceptions: [],
            evidence: [],
          },
          databaseStatus: "proficient",
          confidence: 0.8,
          criticalRequirementsMet: true,
          unmetCriticalGates: [],
          activeMisconceptionTags: [],
          confirmingProbeTags: [],
          masteryAwarded: false,
          evidenceType: "independent_practice",
          reviewOutcome: null,
          createInitialReview: false,
        },
        evidenceType: "independent_practice",
        evidenceSourceType: "deterministic_attempt",
        evidenceWeight: 1,
        now,
        expectedRowVersion: null,
      };
      return {
        first: await tx.appendOfficialEvidence({ ...base, evidenceSourceId: "official-source-1" }),
        duplicate: await tx.appendOfficialEvidence({ ...base, evidenceSourceId: "official-source-1" }),
        second: await tx.appendOfficialEvidence({
          ...base,
          evidenceSourceId: "official-source-2",
          now: new Date(now.getTime() + 1_000),
        }),
      };
    });
    expect(result).toEqual({ first: true, duplicate: false, second: true });

    const rows = await db
      .select()
      .from(masteryEvidence)
      .where(
        and(
          eq(masteryEvidence.userId, USER_A),
          eq(masteryEvidence.conceptId, CONCEPT_ID),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceId).sort()).toEqual([
      "official-source-1",
      "official-source-2",
    ]);
    expect(rows.every((row) => row.validity === "valid" && row.score === 1)).toBe(true);

    const crossTenantRows = await db
      .select({ id: masteryEvidence.id })
      .from(masteryEvidence)
      .where(eq(masteryEvidence.userId, USER_B));
    expect(crossTenantRows).toHaveLength(0);
  });
});

describe("versioned category retention", () => {
  it("dry-runs idempotently, purges bounded expired raw data/files, and preserves official evidence plus audit", async () => {
    await seedLearningGraph();
    const now = new Date("2026-07-12T00:00:00.000Z");
    const old = new Date("2025-01-01T00:00:00.000Z");
    const recent = new Date("2026-06-01T00:00:00.000Z");
    const oldThreadId = "71000000-0000-4000-8000-000000000001";
    const recentThreadId = "71000000-0000-4000-8000-000000000002";
    await db.insert(chatThread).values([
      { id: oldThreadId, userId: USER_A, title: "Old raw chat", createdAt: old, updatedAt: old },
      { id: recentThreadId, userId: USER_A, title: "Recent chat", createdAt: recent, updatedAt: recent },
    ]);
    await db.insert(chatMessage).values([
      { id: "71000000-0000-4000-8000-000000000011", threadId: oldThreadId, role: "user", content: "old raw message", createdAt: old },
      { id: "71000000-0000-4000-8000-000000000012", threadId: recentThreadId, role: "user", content: "recent raw message", createdAt: recent },
    ]);
    await db.insert(codeSubmission).values([
      {
        id: "72000000-0000-4000-8000-000000000001", userId: USER_A,
        language: "python", sourceCode: "print('old')", sourceHash: "old-hash",
        submissionType: "practice", runtimeImageDigest: "sha256:old", status: "succeeded", createdAt: old,
      },
      {
        id: "72000000-0000-4000-8000-000000000002", userId: USER_A,
        language: "python", sourceCode: "print('recent')", sourceHash: "recent-hash",
        submissionType: "practice", runtimeImageDigest: "sha256:recent", status: "succeeded", createdAt: recent,
      },
    ]);
    await db.insert(modelCall).values([
      {
        id: "73000000-0000-4000-8000-000000000001", userId: USER_A,
        provider: "nvidia_nim", model: "integration", operation: "tutor",
        promptVersion: "v1", status: "succeeded", requestHash: "old-request", createdAt: old,
      },
      {
        id: "73000000-0000-4000-8000-000000000002", userId: USER_A,
        provider: "nvidia_nim", model: "integration", operation: "tutor",
        promptVersion: "v1", status: "succeeded", requestHash: "recent-request", createdAt: recent,
      },
    ]);
    await db.insert(authSessionHistory).values([
      {
        originalSessionId: "retention-old-session", userId: USER_A,
        startedAt: old, lastSeenAt: old, expiresAt: old, endedAt: old,
        endReason: "learner_logout", createdAt: old, updatedAt: old,
      },
      {
        originalSessionId: "retention-recent-session", userId: USER_A,
        startedAt: recent, lastSeenAt: recent, expiresAt: recent, endedAt: recent,
        endReason: "learner_logout", createdAt: recent, updatedAt: recent,
      },
    ]);
    await db.insert(auditEvent).values({
      actorUserId: USER_A,
      subjectUserId: USER_A,
      action: "integration.old_audit",
      resourceType: "integration",
      outcome: "success",
      correlationId: "retention-old-audit",
      eventHash: "a".repeat(64),
      occurredAt: new Date("2023-01-01T00:00:00.000Z"),
    });
    await insertRemediationEvidence(
      "74000000-0000-4000-8000-000000000001",
      old,
    );
    await db.insert(emailOutbox).values({
      userId: USER_A,
      deliveryScopeKey: `a:${USER_A}`,
      toEmail: "learner-a@integration.invalid",
      template: "weekly-summary",
      templateVersion: "1",
      variables: { name: "Learner" },
      idempotencyKey: "retention-old-email",
      status: "sent",
      sentAt: old,
      createdAt: old,
      updatedAt: old,
    });
    await db.insert(emailOutbox).values({
      userId: USER_A,
      deliveryScopeKey: `a:${USER_A}`,
      toEmail: "learner-a@integration.invalid",
      template: "weekly-summary",
      templateVersion: "1",
      variables: { name: "Learner" },
      idempotencyKey: "retention-old-failed-email",
      status: "failed",
      createdAt: old,
      updatedAt: old,
    });
    const objectRoot = await mkdtemp(path.join(tmpdir(), "learncoding-retention-"));
    const ownerSegment = ownerStorageSegment(USER_A);
    const storageKey = `${ownerSegment}/75000000-0000-4000-8000-000000000001`;
    const objectPath = path.join(objectRoot, ownerSegment, "75000000-0000-4000-8000-000000000001");
    const softDeletedPath = path.join(objectRoot, ownerSegment, "75000000-0000-4000-8000-000000000002");
    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, "temporary fixture", "utf8");
    await writeFile(softDeletedPath, "soft-deleted fixture", "utf8");
    await db.insert(storedObject).values({
      id: "75000000-0000-4000-8000-000000000001",
      ownerUserId: USER_A,
      storageKey,
      originalName: "expired.tmp",
      mediaType: "text/plain",
      sizeBytes: 17,
      sha256: "b".repeat(64),
      retentionClass: "temporary",
      scanStatus: "safe",
      createdAt: old,
      updatedAt: old,
    });
    await db.insert(storedObject).values({
      id: "75000000-0000-4000-8000-000000000002",
      ownerUserId: USER_A,
      storageKey: `${ownerSegment}/75000000-0000-4000-8000-000000000002`,
      originalName: "soft-deleted.txt",
      mediaType: "text/plain",
      sizeBytes: 20,
      sha256: "e".repeat(64),
      retentionClass: "user_upload",
      scanStatus: "safe",
      deletedAt: old,
      createdAt: old,
      updatedAt: old,
    });
    try {
      const dryRun = await runRetention({
        idempotencyKey: "retention:integration:dry-run",
        dryRun: true,
        now,
        objectStorageRoot: objectRoot,
      });
      expect(dryRun.categories.rawChat.eligible).toBe(1);
      expect(dryRun.categories.rawChat.deleted).toBe(0);
      const replay = await runRetention({
        idempotencyKey: "retention:integration:dry-run",
        dryRun: true,
        now,
        objectStorageRoot: objectRoot,
      });
      expect(replay.replayed).toBe(true);
      await expect(runRetention({
        idempotencyKey: "retention:integration:dry-run",
        dryRun: true,
        now: new Date("2026-07-13T00:00:00.000Z"),
        objectStorageRoot: objectRoot,
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
      expect(await db.select().from(chatMessage)).toHaveLength(2);

      const applied = await runRetention({
        idempotencyKey: "retention:integration:apply",
        dryRun: false,
        now,
        objectStorageRoot: objectRoot,
      }, integrationFileErasureDependencies);
      expect(applied.categories.rawChat.deleted).toBe(1);
      expect(applied.categories.rawCode.deleted).toBe(1);
      expect(applied.categories.aiRequestMetadata.deleted).toBe(1);
      expect(applied.categories.securitySessionHistory.deleted).toBe(1);
      expect(applied.categories.adminAudit.deleted).toBe(0);
      expect(applied.categories.masteryAndOfficialEvidence.deleted).toBe(0);
      expect(applied.objectFiles.removed).toBe(2);
      await expect(access(objectPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(softDeletedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await db.select().from(chatMessage)).map((row) => row.content)).toEqual(["recent raw message"]);
      expect((await db.select().from(codeSubmission)).map((row) => row.sourceHash)).toEqual(["recent-hash"]);
      expect((await db.select().from(modelCall)).map((row) => row.requestHash)).toEqual(["recent-request"]);
      expect(await db.select().from(masteryEvidence)).toHaveLength(1);
      expect(await db.select().from(auditEvent)).toHaveLength(1);
      expect(await db.select().from(storedObject)).toHaveLength(0);
      expect(await db.select().from(emailOutbox)).toHaveLength(0);
    } finally {
      await rm(objectRoot, { recursive: true, force: true });
    }
  });
});

describe("bounded export and administrator-only account deletion", () => {
  it("exports allowlisted learner data, rejects learner deletion, and tombstones an admin deletion without claiming backup erasure", async () => {
    await seedLearningGraph();
    await db.update(user).set({ role: "admin", emailVerified: true }).where(eq(user.id, USER_B));
    await db.insert(account).values({
      id: "lifecycle-secret-account",
      accountId: USER_A,
      providerId: "credential",
      userId: USER_A,
      password: "PASSWORD_HASH_CANARY_NEVER_EXPORT",
    });
    await db.insert(twoFactor).values({
      id: "lifecycle-two-factor",
      userId: USER_A,
      secret: "MFA_SECRET_CANARY_NEVER_EXPORT",
      backupCodes: "BACKUP_CODES_CANARY_NEVER_EXPORT",
    });
    const credentialId = "76000000-0000-4000-8000-000000000001";
    await db.insert(providerCredential).values({
      id: credentialId,
      userId: USER_A,
      provider: "nvidia_nim",
      label: "Deletion fixture",
      ciphertext: "CIPHERTEXT_CANARY_NEVER_EXPORT",
      wrappedDataKey: "WRAPPED_KEY_CANARY_NEVER_EXPORT",
      wrapIv: "iv",
      dataIv: "iv",
      authTag: "tag",
      keyVersion: 1,
      lastFour: "1234",
      status: "active",
    });
    const adminCredentialId = "76000000-0000-4000-8000-000000000014";
    const fallbackGrantId = "76000000-0000-4000-8000-000000000015";
    const fallbackReservationId = "76000000-0000-4000-8000-000000000016";
    const unusedFallbackGrantId = "76000000-0000-4000-8000-000000000018";
    await db.insert(providerCredential).values({
      id: adminCredentialId,
      userId: USER_B,
      provider: "nvidia_nim",
      label: "Deletion fallback authority",
      ciphertext: "admin-fixture-ciphertext",
      wrappedDataKey: "admin-fixture-wrapped-key",
      wrapIv: "admin-fixture-wrap-iv",
      dataIv: "admin-fixture-data-iv",
      authTag: "admin-fixture-auth-tag",
      lastFour: "A1M4",
      status: "active",
    });
    await db.insert(adminFallbackGrant).values({
      id: fallbackGrantId,
      learnerId: USER_A,
      credentialId: adminCredentialId,
      provider: "nvidia_nim",
      model: "deletion/fallback-model",
      tokenBudget: 1_000,
      tokensUsed: 10,
      rupeeBudgetPaise: 500,
      rupeesUsedPaise: 5,
      inputPaisePerMillionTokens: 100_000,
      outputPaisePerMillionTokens: 200_000,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      grantedBy: USER_B,
    });
    await db.insert(adminFallbackGrant).values({
      id: unusedFallbackGrantId,
      learnerId: USER_A,
      credentialId: adminCredentialId,
      provider: "nvidia_nim",
      model: "deletion/unused-fallback-model",
      tokenBudget: 100,
      rupeeBudgetPaise: 100,
      inputPaisePerMillionTokens: 100_000,
      outputPaisePerMillionTokens: 200_000,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      grantedBy: USER_B,
      createRequestId: "76000000-0000-4000-8000-000000000019",
    });
    await db.insert(adminFallbackReservation).values({
      id: fallbackReservationId,
      grantId: fallbackGrantId,
      learnerId: USER_A,
      reservedTokens: 10,
      reservedPaise: 5,
    });
    await db.insert(providerOperationReceipt).values({
      ownerUserId: USER_A,
      action: "tutor.post",
      requestId: "76000000-0000-4000-8000-000000000017",
      inputHash: "e".repeat(64),
      status: "completed",
      responseStatus: 503,
      responseBody: { code: "PROVIDER_OPERATION_INDETERMINATE" },
      completedAt: new Date("2026-07-12T00:00:00.000Z"),
    });
    await db.insert(modelCall).values({
      id: "76000000-0000-4000-8000-000000000002",
      userId: USER_A,
      credentialId,
      provider: "nvidia_nim",
      model: "integration",
      operation: "tutor",
      promptVersion: "v1",
      status: "succeeded",
      requestHash: "safe-request-hash",
    });
    const threadId = "76000000-0000-4000-8000-000000000003";
    await db.insert(chatThread).values({ id: threadId, userId: USER_A, title: "Export fixture" });
    await db.insert(chatMessage).values({
      id: "76000000-0000-4000-8000-000000000004",
      threadId,
      role: "user",
      content: "EXPORT_CHAT_CANARY",
    });
    await db.insert(codeSubmission).values({
      id: "76000000-0000-4000-8000-000000000005",
      userId: USER_A,
      language: "python",
      sourceCode: "EXPORT_CODE_CANARY = True",
      sourceHash: "export-code-hash",
      submissionType: "practice",
      requestId: "export-admission-request",
      requestHash: "f".repeat(64),
      runtimeImageDigest: "sha256:export",
      status: "succeeded",
    });
    await db.insert(response).values([
      {
        attemptId: LEARNING_ATTEMPT_ID,
        itemKey: "learner-answer",
        revision: 1,
        answer: { value: "LEARNER_ANSWER_CANARY" },
      },
      {
        attemptId: LEARNING_ATTEMPT_ID,
        itemKey: BLUEPRINT_RESPONSE_KEY,
        revision: 1,
        answer: { hidden: "HIDDEN_BLUEPRINT_CANARY_NEVER_EXPORT" },
        source: "server",
      },
    ]);
    await db.insert(auditEvent).values({
      actorUserId: USER_B,
      subjectUserId: USER_A,
      action: "integration.lifecycle",
      resourceType: "user",
      resourceId: USER_A,
      outcome: "success",
      correlationId: "lifecycle-audit",
      eventHash: "c".repeat(64),
    });
    await insertRemediationEvidence(
      "76000000-0000-4000-8000-000000000006",
      new Date(),
    );
    await db.insert(notification).values({
      userId: USER_A,
      type: "security",
      title: "Security action",
      body: "BODY_TOKEN_CANARY_NEVER_EXPORT",
      actionUrl: "/one-time-action?token=NOTIFICATION_TOKEN_CANARY_NEVER_EXPORT",
    });
    const learnerCorrectionId = "76000000-0000-4000-8000-000000000020";
    const unrelatedCorrectionId = "76000000-0000-4000-8000-000000000021";
    const correctionValues = (input: { id: string; requestId: string; itemId: string; affectedCount: number }) => ({
      id: input.id,
      createdBy: USER_B,
      createRequestId: input.requestId,
      status: "reviewed",
      defectKind: "faulty_test",
      reason: "An independently reviewed fixture proves account deletion remains owner scoped.",
      courseId: "integration-course",
      moduleId: "integration-module",
      itemId: input.itemId,
      skillId: "integration.skill",
      contentVersion: "integration-v1",
      faultyBundleVersion: "faulty-v1",
      faultyEvidenceHash: "1".repeat(64),
      replacementBundleVersion: "replacement-v2",
      replacementEvidence: { fixture: true },
      replacementEvidenceHash: "2".repeat(64),
      reviewChecklist: { reviewer: "integration" },
      reviewHash: "3".repeat(64),
      affectedCount: input.affectedCount,
    } as const);
    await db.insert(assessmentCorrection).values([
      correctionValues({
        id: learnerCorrectionId,
        requestId: "76000000-0000-4000-8000-000000000022",
        itemId: "learner-owned-impact",
        affectedCount: 1,
      }),
      correctionValues({
        id: unrelatedCorrectionId,
        requestId: "76000000-0000-4000-8000-000000000023",
        itemId: "unrelated-empty-correction",
        affectedCount: 0,
      }),
    ]);
    await db.insert(assessmentCorrectionImpact).values({
      id: "76000000-0000-4000-8000-000000000024",
      correctionId: learnerCorrectionId,
      attemptId: LEARNING_ATTEMPT_ID,
      userId: USER_A,
      formId: "integration-owner-scope-form",
      formHash: "4".repeat(64),
      answerSetHash: "5".repeat(64),
      originalResultHash: "6".repeat(64),
      snapshot: { fixture: true },
      snapshotHash: "7".repeat(64),
    });

    await expect(createLearnerExport({
      learnerId: USER_A,
      actorUserId: USER_A,
      requestId: "76000000-0000-4000-8000-000000000011",
    })).rejects.toThrow(/not authorized/i);

    const exported = await createLearnerExport({
      learnerId: USER_A,
      actorUserId: USER_B,
      requestId: "76000000-0000-4000-8000-000000000007",
      maxRecords: 1_000,
      maxBytes: 2 * 1_024 * 1_024,
    });
    const exportText = await new Response(exported.stream).text();
    const exportMetrics = await exported.completion;
    expect(exportMetrics.completed).toBe(true);
    expect(exportMetrics.truncated).toBe(false);
    expect(exportText).toContain("EXPORT_CHAT_CANARY");
    expect(exportText).toContain("EXPORT_CODE_CANARY");
    expect(exportText).toContain("LEARNER_ANSWER_CANARY");
    const exportedRecords = exportText.trim().split("\n").map((line) => JSON.parse(line));
    const exportedSubmission = exportedRecords.find((line) =>
      line.category === "codeSubmissions"
      && line.data?.id === "76000000-0000-4000-8000-000000000005");
    expect(exportedSubmission?.data).toMatchObject({ requestId: "export-admission-request" });
    expect(exportedSubmission?.data).not.toHaveProperty("requestHash");
    for (const forbidden of [
      "PASSWORD_HASH_CANARY_NEVER_EXPORT",
      "MFA_SECRET_CANARY_NEVER_EXPORT",
      "BACKUP_CODES_CANARY_NEVER_EXPORT",
      "CIPHERTEXT_CANARY_NEVER_EXPORT",
      "WRAPPED_KEY_CANARY_NEVER_EXPORT",
      "NOTIFICATION_TOKEN_CANARY_NEVER_EXPORT",
      "BODY_TOKEN_CANARY_NEVER_EXPORT",
      "HIDDEN_BLUEPRINT_CANARY_NEVER_EXPORT",
    ]) expect(exportText).not.toContain(forbidden);
    expect(exportText).toContain("hidden tests");

    const tinyExport = await createLearnerExport({
      learnerId: USER_A,
      actorUserId: USER_B,
      requestId: "76000000-0000-4000-8000-000000000012",
      maxRecords: 1_000,
      maxBytes: 1_024,
    });
    const tinyText = await new Response(tinyExport.stream).text();
    const tinyMetrics = await tinyExport.completion;
    const tinyLines = tinyText.trim().split("\n").map((line) => JSON.parse(line));
    expect(Buffer.byteLength(tinyText)).toBeLessThanOrEqual(1_024);
    expect(tinyLines[0]?.type).toBe("manifest");
    expect(tinyLines.at(-1)?.type).toBe("footer");
    expect(tinyMetrics.truncated).toBe(true);

    await db.update(user).set({ status: "deletion_pending" }).where(eq(user.id, USER_A));
    await expect(createLearnerExport({
      learnerId: USER_A,
      actorUserId: USER_B,
      requestId: "76000000-0000-4000-8000-000000000013",
    })).rejects.toThrow(/learner is unavailable/i);
    await db.update(user).set({ status: "active" }).where(eq(user.id, USER_A));

    const rehearsalLearnerId = "integration-rehearsal-learner";
    await db.insert(user).values({
      id: rehearsalLearnerId,
      name: "Rehearsal learner",
      email: "rehearsal-learner@integration.invalid",
      emailVerified: true,
      role: "learner",
      status: "active",
    });
    await db.insert(runnerPowerRehearsalEvent).values({
      id: "76000000-0000-4000-8000-000000000030",
      state: "aborted",
      actorUserId: USER_B,
      learnerOneId: USER_A,
      learnerTwoId: rehearsalLearnerId,
      reason: "Completed disposable account-deletion rehearsal fixture.",
      createdAt: new Date("2026-07-12T00:00:00.000Z"),
      updatedAt: new Date("2026-07-12T00:01:00.000Z"),
      expiresAt: new Date("2026-07-12T01:00:00.000Z"),
      abortedAt: new Date("2026-07-12T00:01:00.000Z"),
      terminalCommandId: "76000000-0000-4000-8000-000000000031",
      terminalCommandHash: "a".repeat(64),
    });

    await expect(deleteLearnerAccount({
      actorUserId: USER_A,
      learnerId: USER_A,
      requestId: "76000000-0000-4000-8000-000000000008",
      reason: "Learners cannot delete accounts",
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });

    const objectRoot = await mkdtemp(path.join(tmpdir(), "learncoding-deletion-"));
    const ownerSegment = ownerStorageSegment(USER_A);
    const storageKey = `${ownerSegment}/76000000-0000-4000-8000-000000000009`;
    const objectPath = path.join(objectRoot, ownerSegment, "76000000-0000-4000-8000-000000000009");
    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, "delete me", "utf8");
    await db.insert(storedObject).values({
      id: "76000000-0000-4000-8000-000000000009",
      ownerUserId: USER_A,
      storageKey,
      originalName: "private.txt",
      mediaType: "text/plain",
      sizeBytes: 9,
      sha256: "d".repeat(64),
      scanStatus: "safe",
    });
    const previousKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.DELETION_TOMBSTONE_KEY = "integration-tombstone-key-that-is-long-enough";
    try {
      const deletionInput = {
        actorUserId: USER_B,
        learnerId: USER_A,
        requestId: "76000000-0000-4000-8000-000000000010",
        reason: "Learner requested permanent account deletion",
        now: new Date("2026-07-12T00:00:00.000Z"),
        objectStorageRoot: objectRoot,
      } as const;
      await expect(deleteLearnerAccount(deletionInput)).rejects.toMatchObject({
        code: "PROVIDER_OPERATION_IN_PROGRESS",
      });
      await expect(access(objectPath)).resolves.toBeUndefined();
      expect((await db.select({ status: user.status }).from(user).where(eq(user.id, USER_A)))[0]?.status)
        .toBe("active");
      await reconcileFallbackBudget({
        reservationId: fallbackReservationId,
        grantId: fallbackGrantId,
        learnerId: USER_A,
        reservedTokens: 10,
        reservedCostPaise: 5,
        actualTokens: 10,
        actualCostPaise: 5,
      });
      const postgresFailure = async (operation: PromiseLike<unknown>) => {
        let failure: unknown;
        try {
          await operation;
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        return (failure as { cause?: { code?: string; message?: string } }).cause;
      };
      await expect(postgresFailure(db.update(adminFallbackGrant).set({ tokenBudget: 2_000 }).where(
        eq(adminFallbackGrant.id, fallbackGrantId),
      ))).resolves.toMatchObject({
        code: "P0001",
        message: expect.stringMatching(/authority fields are immutable/i),
      });
      await expect(postgresFailure(db.update(adminFallbackReservation).set({ actualTokens: 9 }).where(
        eq(adminFallbackReservation.id, fallbackReservationId),
      ))).resolves.toMatchObject({
        code: "P0001",
        message: expect.stringMatching(/completed fallback reservations are immutable/i),
      });
      await expect(postgresFailure(db.delete(adminFallbackReservation).where(
        eq(adminFallbackReservation.id, fallbackReservationId),
      ))).resolves.toMatchObject({
        code: "P0001",
        message: expect.stringMatching(/fallback reservations cannot be deleted/i),
      });
      await expect(postgresFailure(db.delete(adminFallbackGrant).where(
        eq(adminFallbackGrant.id, unusedFallbackGrantId),
      ))).resolves.toMatchObject({
        code: "P0001",
        message: expect.stringMatching(/fallback grants cannot be deleted/i),
      });
      await expect(postgresFailure(db.delete(providerCredential).where(
        eq(providerCredential.id, adminCredentialId),
      ))).resolves.toMatchObject({ code: "23503" });
      const report = await deleteLearnerAccount(deletionInput, integrationFileErasureDependencies);
      expect(report.primaryStoreDeletionComplete).toBe(true);
      expect(report.backupStatus).toBe("awaiting_retention_expiry");
      expect(report.backupRetentionUntil).toBe("2027-07-12T00:00:00.000Z");
      expect(report.backupNotice).toContain("not claimed erased");
      await expect(access(objectPath)).rejects.toMatchObject({ code: "ENOENT" });
      const [deletedUser] = await db.select().from(user).where(eq(user.id, USER_A));
      expect(deletedUser.status).toBe("deleted");
      expect(deletedUser.name).toBe("Deleted learner");
      expect(deletedUser.email).toMatch(/^deleted\+.+@invalid\.local$/);
      expect(deletedUser.email).not.toContain("learner-a@integration.invalid");
      expect(await db.select().from(learnerProfile).where(eq(learnerProfile.userId, USER_A))).toHaveLength(0);
      expect(await db.select().from(masteryEvidence).where(eq(masteryEvidence.userId, USER_A))).toHaveLength(0);
      expect(await db.select().from(providerCredential).where(eq(providerCredential.userId, USER_A))).toHaveLength(0);
      expect(await db.select().from(adminFallbackReservation).where(eq(adminFallbackReservation.learnerId, USER_A))).toHaveLength(0);
      expect(await db.select().from(adminFallbackGrant).where(eq(adminFallbackGrant.learnerId, USER_A))).toHaveLength(0);
      expect(await db.select().from(providerOperationReceipt).where(eq(providerOperationReceipt.ownerUserId, USER_A))).toHaveLength(0);
      expect(report.deletedRows).toMatchObject({
        runnerPowerRehearsalEvents: 1,
        assessmentCorrectionImpacts: 1,
        emptyAssessmentCorrections: 1,
        providerOperationReceipts: 1,
        fallbackReservations: 1,
        fallbackGrants: 2,
      });
      expect(await db.select().from(runnerPowerRehearsalEvent)).toHaveLength(0);
      expect(await db.select().from(assessmentCorrection).where(eq(assessmentCorrection.id, learnerCorrectionId)))
        .toHaveLength(0);
      expect(await db.select().from(assessmentCorrection).where(eq(assessmentCorrection.id, unrelatedCorrectionId)))
        .toHaveLength(1);
      expect(await db.select().from(account).where(eq(account.userId, USER_A))).toHaveLength(0);
      expect(await db.select().from(twoFactor).where(eq(twoFactor.userId, USER_A))).toHaveLength(0);
      expect(await db.select().from(auditEvent)).toHaveLength(1);
      const tombstones = await db.select().from(accountDeletionTombstone);
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0]?.identityHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(tombstones[0])).not.toContain("learner-a@integration.invalid");
      expect(JSON.stringify(tombstones[0])).not.toContain("private.txt");
      const notices = await db.select().from(emailOutbox);
      expect(notices.some((row) => row.template === "account-deleted")).toBe(true);
      const deletionNotice = notices.find((row) => row.template === "account-deleted");
      expect(deletionNotice?.variables).toEqual({
        backupRetentionUntil: "2027-07-12T00:00:00.000Z",
      });

      const replay = await deleteLearnerAccount(deletionInput);
      expect(replay.replayed).toBe(true);
      expect(replay.tombstoneId).toBe(report.tombstoneId);
      const backupReport = await backupExpiryReport(new Date("2027-07-12T00:00:00.001Z"));
      expect(backupReport.records[0]).toMatchObject({
        retentionWindowElapsed: true,
        operatorVerificationRequired: true,
        backupStatus: "awaiting_retention_expiry",
      });
      expect(backupReport.records[0]?.statement).toContain("verify every configured");
      const expiryRun = await runRetention({
        idempotencyKey: "retention:integration:backup-expiry",
        dryRun: false,
        now: new Date("2027-07-12T00:00:00.001Z"),
        objectStorageRoot: objectRoot,
      });
      expect(expiryRun.categories.backupExpiryEligibility).toMatchObject({
        deleted: 0,
        transitioned: 1,
      });
      const [eligibleTombstone] = await db.select().from(accountDeletionTombstone);
      expect(eligibleTombstone.backupStatus).toBe("eligible_for_operator_verification");
      expect(eligibleTombstone.backupStatus).not.toBe("verified_expired");
      const expiryReplay = await deleteLearnerAccount(deletionInput);
      expect(expiryReplay.backupStatus).toBe("eligible_for_operator_verification");
      expect(expiryReplay.replayed).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousKey;
      await rm(objectRoot, { recursive: true, force: true });
    }
  });
});
