import { createHash } from "node:crypto";

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { createContentRepository, type CourseModule } from "@/lib/content";
import { db, type Database } from "@/lib/db/client";
import { hasPostgresErrorCode } from "@/lib/db/postgres-errors";
import {
  appeal,
  appealEvent,
  assessmentAttemptEffectiveResult,
  attempt,
  codeSubmission,
  concept,
  conceptMastery,
  enrollment,
  examAutosaveMutation,
  examEvent,
  examFinalizationJob,
  examMasteryRecheck,
  examReexamGrant,
  examSession,
  masteryEvidence,
  notification,
  response as examResponse,
  user,
} from "@/lib/db/schema";
import { buildExamAppealEvidence } from "@/lib/appeals/evidence";
import {
  awardExamModuleMastery,
  ExamMasteryAwardError,
} from "@/lib/achievements/exam-mastery";
import {
  listPublishedExamCourses,
} from "@/lib/curriculum-publication/runtime";
import type { StoredEvidence } from "@/lib/learning-service/types";
import {
  admitRunnerJob,
  beginRunnerDispatch,
  hashRunnerAdmissionRequest,
  recordRunnerDispatch,
  refreshRunnerAdmission,
  requireFreshRunnerMutation,
  RunnerAdmissionError,
  settleRunnerJob,
  type RunnerAdmission,
} from "@/lib/runner/admission";
import {
  configuredRunnerClient,
  RunnerClientError,
  RunnerIndeterminateError,
  runtimeByLanguage,
  type RunnerJobResponse,
  type RunnerLanguage,
  type RunnerRequest,
} from "@/lib/runner/client";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

import {
  examFinalizationRunnerSeed,
  hasExactRunnerTestManifest,
  isIndeterminateRunnerIdentityConflict,
  isUnresolvedActiveRunnerReplay,
  persistRunnerMutationAfterRemote,
  RunnerPersistenceAmbiguityError,
  runnerFailureRequiresReconciliation,
} from "./runner-replay-policy";

import {
  buildEquivalentExamForm,
  buildTargetedMasteryRecheckForm,
  verifyEquivalentFormParity,
} from "./blueprint";
import {
  BLUEPRINT_RESPONSE_KEY,
  EXAM_POLICY_VERSION,
  RESULT_RESPONSE_KEY,
  toPublicExamForm,
  type ClientExamEventType,
  type ExamAnswer,
  type ExamCatalogEntry,
  type ExamFinalizationReason,
  type ExamFormSnapshot,
  type ExamResult,
  type ExamRunnerResult,
  type ExamSessionStatus,
  type ExamSessionView,
  type SavedExamAnswer,
  type SavedExamAutosaveResult,
} from "./contracts";
import {
  canConsumeEquivalentReexamGrant,
  computeRetakeEligibility,
  disconnectedDeltaSeconds,
  evaluateStartDevice,
  gradeExamSubmission,
  hasPersistedRemediationEvidence,
  hasDeadlinePassed,
  latestRevisionByItem,
  MASTERY_RECHECK_DELAY_MS,
  MATERIAL_DISCONNECT_SECONDS,
  sanitizeEventMetadata,
  type StartDeviceClaim,
} from "./policy";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXECUTION_LIMITS = Object.freeze({
  wallTimeMs: 5_000,
  memoryMb: 128,
  cpuCount: 0.5,
  pids: 32,
  outputBytes: 65_536,
  fileBytes: 16_777_216,
});

type AttemptRow = typeof attempt.$inferSelect;
type SessionRow = typeof examSession.$inferSelect;
type DrizzleTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | DrizzleTransaction;

interface HistoryRecord {
  readonly attempt: AttemptRow;
  readonly session: SessionRow | null;
  readonly form: ExamFormSnapshot | null;
  readonly result: ExamResult | null;
}

async function remediationEvidenceRows(
  userId: string,
  executor: Executor = db,
): Promise<readonly StoredEvidence[]> {
  const rows = await executor
    .select({ evidence: masteryEvidence, skillId: concept.slug })
    .from(masteryEvidence)
    .innerJoin(concept, eq(concept.id, masteryEvidence.conceptId))
    .where(eq(masteryEvidence.userId, userId));
  return rows.map((row) => ({ ...row.evidence, skillId: row.skillId }));
}

export class ExamServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ExamServiceError";
  }
}

async function lockActiveOfficialExamUser(tx: DrizzleTransaction, userId: string) {
  await lockUserAuthority(tx, userId);
  const [account] = await tx
    .select({ status: user.status })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .for("update");
  if (account?.status !== "active") {
    throw new ExamServiceError(
      "This learner account is no longer active, so official exam evidence cannot be changed.",
      409,
      "LEARNER_NOT_ACTIVE",
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storedForm(answer: unknown): ExamFormSnapshot | null {
  const wrapper = record(answer);
  const snapshot = record(wrapper?.snapshot);
  if (
    snapshot?.schemaVersion !== 1 ||
    typeof snapshot.formId !== "string" ||
    typeof snapshot.moduleId !== "string" ||
    typeof snapshot.courseId !== "string" ||
    !Array.isArray(snapshot.items)
  ) return null;
  return snapshot as unknown as ExamFormSnapshot;
}

function storedResult(answer: unknown): ExamResult | null {
  const wrapper = record(answer);
  const result = record(wrapper?.result) ?? wrapper;
  if (
    result?.schemaVersion !== 1 ||
    (result.gradingStatus !== "graded" && result.gradingStatus !== "pending-review") ||
    typeof result.finalizedAt !== "string"
  ) return null;
  return result as unknown as ExamResult;
}

function answerRecord(value: unknown): ExamAnswer {
  const parsed = record(value);
  if (parsed === null) return {};
  return {
    ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
    ...(typeof parsed.sourceCode === "string" ? { sourceCode: parsed.sourceCode } : {}),
    ...(typeof parsed.language === "string" ? { language: parsed.language as ExamAnswer["language"] } : {}),
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

async function examHistory(
  userId: string,
  executor: Executor = db,
): Promise<readonly HistoryRecord[]> {
  const attempts = await executor
    .select()
    .from(attempt)
    .where(and(eq(attempt.userId, userId), inArray(attempt.kind, ["exam", "retake"])))
    .orderBy(desc(attempt.createdAt), desc(attempt.id));
  if (attempts.length === 0) return [];
  const attemptIds = attempts.map((row) => row.id);
  // `executor` is also a transaction-scoped Drizzle client during exam
  // admission. node-postgres clients may execute only one query at a time;
  // parallelizing these reads queues multiple queries on that single client
  // (deprecated in pg 8 and an error in pg 9). Keep the history snapshot on
  // the caller's executor and issue its reads sequentially. Pool-backed calls
  // remain correct with the same ordering, while transaction-backed calls are
  // now pg 9 safe without escaping the admission transaction.
  const sessions = await executor
    .select()
    .from(examSession)
    .where(inArray(examSession.attemptId, attemptIds));
  const reservedResponses = await executor
    .select()
    .from(examResponse)
    .where(and(
      inArray(examResponse.attemptId, attemptIds),
      inArray(examResponse.itemKey, [BLUEPRINT_RESPONSE_KEY, RESULT_RESPONSE_KEY]),
    ));
  const effectiveResults = await executor
    .select({ attemptId: assessmentAttemptEffectiveResult.attemptId, result: assessmentAttemptEffectiveResult.result })
    .from(assessmentAttemptEffectiveResult)
    .where(inArray(assessmentAttemptEffectiveResult.attemptId, attemptIds));
  const sessionByAttempt = new Map(sessions.map((row) => [row.attemptId, row]));
  const formByAttempt = new Map<string, ExamFormSnapshot>();
  const resultByAttempt = new Map<string, ExamResult>();
  for (const row of reservedResponses) {
    if (row.itemKey === BLUEPRINT_RESPONSE_KEY) {
      const form = storedForm(row.answer);
      if (form !== null) formByAttempt.set(row.attemptId, form);
    } else {
      const result = storedResult(row.answer);
      if (result !== null) resultByAttempt.set(row.attemptId, result);
    }
  }
  for (const row of effectiveResults) {
    const result = storedResult(row.result);
    if (result !== null) resultByAttempt.set(row.attemptId, result);
  }
  return attempts.map((attemptRow) => ({
    attempt: attemptRow,
    session: sessionByAttempt.get(attemptRow.id) ?? null,
    form: formByAttempt.get(attemptRow.id) ?? null,
    result: resultByAttempt.get(attemptRow.id) ?? null,
  }));
}

async function ownedSession(userId: string, sessionId: string) {
  const [owned] = await db
    .select({ session: examSession, attempt })
    .from(examSession)
    .innerJoin(attempt, eq(examSession.attemptId, attempt.id))
    .where(and(eq(examSession.id, sessionId), eq(examSession.userId, userId)))
    .limit(1);
  if (!owned) {
    throw new ExamServiceError("Exam session was not found.", 404, "EXAM_NOT_FOUND");
  }
  return owned;
}

async function formForAttempt(attemptId: string): Promise<ExamFormSnapshot> {
  const [row] = await db
    .select({ answer: examResponse.answer })
    .from(examResponse)
    .where(and(
      eq(examResponse.attemptId, attemptId),
      eq(examResponse.itemKey, BLUEPRINT_RESPONSE_KEY),
    ))
    .limit(1);
  const form = storedForm(row?.answer);
  if (form === null) {
    throw new ExamServiceError(
      "The immutable exam form is unavailable.",
      500,
      "EXAM_FORM_MISSING",
    );
  }
  return form;
}

async function resultForAttempt(attemptId: string): Promise<ExamResult | null> {
  const [effective] = await db
    .select({ result: assessmentAttemptEffectiveResult.result })
    .from(assessmentAttemptEffectiveResult)
    .where(eq(assessmentAttemptEffectiveResult.attemptId, attemptId))
    .limit(1);
  const corrected = storedResult(effective?.result);
  if (corrected !== null) return corrected;
  const [row] = await db
    .select({ answer: examResponse.answer })
    .from(examResponse)
    .where(and(
      eq(examResponse.attemptId, attemptId),
      eq(examResponse.itemKey, RESULT_RESPONSE_KEY),
    ))
    .limit(1);
  return storedResult(row?.answer);
}

async function answersForAttempt(attemptId: string): Promise<{
  readonly saved: Readonly<Record<string, SavedExamAnswer>>;
  readonly values: Readonly<Record<string, ExamAnswer>>;
}> {
  const rows = await db
    .select({
      itemKey: examResponse.itemKey,
      revision: examResponse.revision,
      answer: examResponse.answer,
      savedAt: examResponse.savedAt,
    })
    .from(examResponse)
    .where(eq(examResponse.attemptId, attemptId));
  const latest = latestRevisionByItem(rows
    .filter((row) => row.itemKey !== BLUEPRINT_RESPONSE_KEY && row.itemKey !== RESULT_RESPONSE_KEY)
    .map((row) => ({ ...row, value: answerRecord(row.answer) })));
  const saved: Record<string, SavedExamAnswer> = {};
  const values: Record<string, ExamAnswer> = {};
  for (const [itemKey, row] of latest) {
    saved[itemKey] = {
      revision: row.revision,
      answer: row.value,
      savedAt: row.savedAt.toISOString(),
    };
    values[itemKey] = row.value;
  }
  return { saved, values };
}

function latestForModule(history: readonly HistoryRecord[], moduleId: string): HistoryRecord | null {
  return history.find((entry) => entry.form?.moduleId === moduleId) ?? null;
}

function latestResultForModule(history: readonly HistoryRecord[], moduleId: string): HistoryRecord | null {
  return history.find((entry) => entry.form?.moduleId === moduleId && entry.result !== null) ?? null;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export async function listExamCatalog(
  userId: string,
  now = new Date(),
): Promise<readonly ExamCatalogEntry[]> {
  const content = createContentRepository();
  const [filesystemCourses, publishedCourses] = await Promise.all([
    content.listCourses({ status: ["beta", "verified"] }),
    listPublishedExamCourses(),
  ]);
  const publishedCourseIds = new Set(publishedCourses.map((item) => item.course.id));
  const courses = [
    ...publishedCourses.map((item) => item.course),
    ...filesystemCourses.filter((course) => !publishedCourseIds.has(course.id)),
  ];
  let history = await examHistory(userId);
  const expiredActive = history.filter((entry) =>
    entry.session?.status === "active" && hasDeadlinePassed(entry.session.serverDeadlineAt, now),
  );
  for (const entry of expiredActive) {
    try {
      await finalizeExam(userId, entry.session!.id, "deadline", now);
    } catch {
      // A concurrent request may already own finalization; catalog remains read-only.
    }
  }
  if (expiredActive.length > 0) history = await examHistory(userId);

  const evidenceRows = history.some((entry) => entry.result?.remediation.required)
    ? await remediationEvidenceRows(userId)
    : [];
  await db
    .update(examMasteryRecheck)
    .set({ status: "available", updatedAt: now })
    .where(and(
      eq(examMasteryRecheck.userId, userId),
      eq(examMasteryRecheck.status, "scheduled"),
      lte(examMasteryRecheck.dueAt, now),
    ));
  const [rechecks, grants] = await Promise.all([
    db
      .select({ recheck: examMasteryRecheck, activeSessionId: examSession.id })
      .from(examMasteryRecheck)
      .leftJoin(examSession, eq(examSession.attemptId, examMasteryRecheck.recheckAttemptId))
      .where(eq(examMasteryRecheck.userId, userId))
      .orderBy(desc(examMasteryRecheck.createdAt)),
    db
      .select({ moduleId: examReexamGrant.moduleId })
      .from(examReexamGrant)
      .where(and(eq(examReexamGrant.userId, userId), eq(examReexamGrant.status, "available"))),
  ]);
  const grantedModules = new Set(grants.map((grant) => grant.moduleId));

  return courses.flatMap((course) => course.modules.map((courseModule) => {
    const latest = latestForModule(history, courseModule.id);
    const latestWithResult = latestResultForModule(history, courseModule.id);
    const active = history.find((entry) =>
      entry.form?.moduleId === courseModule.id && entry.session?.status === "active",
    );
    const recheck = rechecks.find((entry) => entry.recheck.moduleId === courseModule.id) ?? null;
    const activeRecheckSessionId = recheck?.recheck.status === "active"
      ? recheck.activeSessionId
      : null;
    const recheckSource = recheck
      ? history.find((entry) => entry.attempt.id === recheck.recheck.sourceAttemptId)
      : null;
    const recheckItemCount = recheckSource?.form?.items.filter((item) =>
      recheck!.recheck.targetClusterIds.includes(item.clusterId) ||
      recheck!.recheck.targetCodingItemIds.includes(item.id)
    ).length ?? (recheck ? new Set([
      ...recheck.recheck.targetClusterIds,
      ...recheck.recheck.targetCodingItemIds,
    ]).size : 0);
    const result = latestWithResult?.result ?? null;
    const durationMinutes = latest?.form?.durationMinutes ?? Math.min(45, Math.max(10, courseModule.skills.length * 6));
    const remediationComplete = hasPersistedRemediationEvidence({
      result: latestWithResult?.result ?? null,
      form: latestWithResult?.form ?? null,
      evidenceRows,
    });
    const policyRetake = computeRetakeEligibility({
      result,
      durationMinutes,
      nowMs: now.getTime(),
      remediationComplete,
    });
    const retake = grantedModules.has(courseModule.id)
      ? {
          eligible: true,
          reason: "admin-reexam-grant" as const,
          nextEligibleAt: now.toISOString(),
          requiresRemediation: false,
        }
      : policyRetake;
    const readiness: ExamCatalogEntry["readiness"] = active || activeRecheckSessionId
      ? "resume"
      : result?.outcome === "PENDING_REVIEW"
        ? "pending-review"
        : result?.outcome === "MASTERED"
          ? "mastered"
          : result?.outcome === "PASSED"
            ? "passed"
          : result?.remediation.required && !remediationComplete
              ? "remediation"
              : "available";
    return {
      courseId: course.id,
      courseTitle: course.title,
      moduleId: courseModule.id,
      moduleTitle: courseModule.title,
      summary: courseModule.description,
      skillCount: courseModule.skills.length,
      durationMinutes,
      readiness,
      activeSessionId: active?.session?.id ?? activeRecheckSessionId ?? null,
      latestResult: result,
      retake,
      masteryRecheck: recheck
        ? {
            id: recheck.recheck.id,
            status: recheck.recheck.status as "scheduled" | "available" | "active" | "completed",
            dueAt: recheck.recheck.dueAt.toISOString(),
            targetCount: recheckItemCount,
            durationMinutes: Math.min(45, Math.max(10, recheckItemCount * 6)),
            activeSessionId: activeRecheckSessionId ?? null,
            priorPassProtected: true,
          }
        : null,
    };
  }));
}

export interface StartExamInput {
  readonly moduleId: string;
  readonly integrityDisclosureAccepted: boolean;
  readonly readinessAcknowledged: boolean;
  readonly device: StartDeviceClaim;
}

async function publishedModuleReadiness(input: {
  readonly userId: string;
  readonly courseVersionId: string;
  readonly module: CourseModule;
  readonly executor?: Executor;
}): Promise<{ readonly ready: boolean; readonly missingSkillIds: readonly string[] }> {
  const executor = input.executor ?? db;
  const requiredSkillIds = input.module.skills
    .filter((skill) => skill.status === "required")
    .map((skill) => skill.id);
  if (!requiredSkillIds.length) return { ready: true, missingSkillIds: [] };
  const rows = await executor
    .select({
      skillId: concept.slug,
      criticalRequirementsMet: conceptMastery.criticalRequirementsMet,
      status: conceptMastery.status,
    })
    .from(enrollment)
    .innerJoin(
      conceptMastery,
      and(
        eq(conceptMastery.enrollmentId, enrollment.id),
        eq(conceptMastery.userId, enrollment.userId),
      ),
    )
    .innerJoin(concept, eq(concept.id, conceptMastery.conceptId))
    .where(and(
      eq(enrollment.userId, input.userId),
      eq(enrollment.courseVersionId, input.courseVersionId),
      inArray(enrollment.status, ["active", "completed"]),
      inArray(concept.slug, requiredSkillIds),
    ));
  const ready = new Set(rows
    .filter((row) =>
      row.criticalRequirementsMet &&
      ["proficient", "mastered", "needs_review"].includes(row.status)
    )
    .map((row) => row.skillId));
  const missingSkillIds = requiredSkillIds.filter((skillId) => !ready.has(skillId));
  return { ready: missingSkillIds.length === 0, missingSkillIds };
}

export async function startExam(
  userId: string,
  input: StartExamInput,
  now = new Date(),
): Promise<ExamSessionView> {
  const device = evaluateStartDevice(input.device);
  if (!device.allowed) {
    throw new ExamServiceError(
      "Formal exams can only be started on a desktop or tablet-sized device.",
      422,
      "UNSUPPORTED_EXAM_DEVICE",
      { reason: device.reason },
    );
  }
  if (!input.integrityDisclosureAccepted || !input.readinessAcknowledged) {
    throw new ExamServiceError(
      "Accept the integrity disclosure and readiness statement before starting.",
      400,
      "EXAM_ACKNOWLEDGEMENT_REQUIRED",
    );
  }

  const publishedCourses = await listPublishedExamCourses();
  const published = publishedCourses
    .map((publication) => ({
      ...publication,
      module: publication.course.modules.find((candidate) => candidate.id === input.moduleId),
    }))
    .find((publication) => publication.module !== undefined);
  const content = published ? null : createContentRepository();
  const [snapshot, index] = content
    ? await Promise.all([content.getSnapshot(), content.getIndex()])
    : [null, null] as const;
  const courseModule = published?.module ?? index?.moduleById.get(input.moduleId);
  const course = published?.course ?? index?.moduleCourseById.get(input.moduleId);
  if (!courseModule || !course || (course.status !== "beta" && course.status !== "verified")) {
    throw new ExamServiceError("This module is not available for an exam.", 404, "MODULE_NOT_EXAM_READY");
  }
  if (!published && publishedCourses.some((publication) => publication.course.id === course.id)) {
    throw new ExamServiceError(
      "This module is not part of the current reviewed curriculum publication.",
      404,
      "MODULE_NOT_EXAM_READY",
    );
  }
  const assessmentBanks = published?.assessmentBanks.filter((bank) => bank.moduleId === input.moduleId)
    ?? await content!.listAssessmentBanks({ moduleId: input.moduleId });
  if (published) {
    const readiness = await publishedModuleReadiness({
      userId,
      courseVersionId: published.courseVersionId,
      module: courseModule,
    });
    if (!readiness.ready) {
      throw new ExamServiceError(
        "Complete the required independent and delayed evidence before starting this formal exam.",
        409,
        "EXAM_NOT_READY",
        { missingSkillIds: readiness.missingSkillIds },
      );
    }
  }

  let history = await examHistory(userId);
  const expired = history.filter((entry) =>
    entry.form?.moduleId === input.moduleId &&
    entry.session?.status === "active" &&
    hasDeadlinePassed(entry.session.serverDeadlineAt, now),
  );
  for (const entry of expired) {
    await finalizeExam(userId, entry.session!.id, "deadline", now).catch(() => undefined);
  }
  if (expired.length > 0) history = await examHistory(userId);
  const active = history.find((entry) =>
    entry.form?.moduleId === input.moduleId && entry.session?.status === "active",
  );
  if (active?.session) {
    throw new ExamServiceError(
      "An active equivalent form already exists. Resume it instead.",
      409,
      "EXAM_ALREADY_ACTIVE",
      { sessionId: active.session.id },
    );
  }
  const form = buildEquivalentExamForm({
    course,
    module: courseModule,
    catalogVersion: snapshot?.catalog.version ?? `published:${published!.courseVersionId}`,
    now,
    assessmentBanks,
  });
  const deadline = new Date(now.getTime() + form.durationMinutes * 60_000);
  let createdSessionId = "";
  const admit = () => db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level serializable`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`exam:${userId}:${input.moduleId}`}))`);
    const existing = await tx
      .select({ sessionId: examSession.id, answer: examResponse.answer })
      .from(examSession)
      .innerJoin(attempt, eq(examSession.attemptId, attempt.id))
      .innerJoin(
        examResponse,
        and(
          eq(examResponse.attemptId, attempt.id),
          eq(examResponse.itemKey, BLUEPRINT_RESPONSE_KEY),
        ),
      )
      .where(and(eq(examSession.userId, userId), eq(examSession.status, "active")));
    const sameModule = existing.find((row) => storedForm(row.answer)?.moduleId === input.moduleId);
    if (sameModule) {
      throw new ExamServiceError(
        "An active equivalent form already exists. Resume it instead.",
        409,
        "EXAM_ALREADY_ACTIVE",
        { sessionId: sameModule.sessionId },
      );
    }

    // The lock and all admission reads share this transaction. A concurrent
    // start cannot reuse a stale pre-lock eligibility decision, and a session
    // whose final result is still being persisted cannot be skipped.
    const lockedHistory = await examHistory(userId, tx);
    if (published) {
      const readiness = await publishedModuleReadiness({
        userId,
        courseVersionId: published.courseVersionId,
        module: courseModule,
        executor: tx,
      });
      if (!readiness.ready) {
        throw new ExamServiceError(
          "Formal-exam readiness changed before admission completed.",
          409,
          "EXAM_NOT_READY",
          { missingSkillIds: readiness.missingSkillIds },
        );
      }
    }
    const lockedLatest = latestForModule(lockedHistory, input.moduleId);
    if (
      lockedLatest?.session &&
      lockedLatest.result === null &&
      lockedLatest.session.status !== "invalidated"
    ) {
      throw new ExamServiceError(
        "The previous exam is still being finalized.",
        409,
        "EXAM_FINALIZATION_PENDING",
      );
    }
    const lockedLatestResult = latestResultForModule(lockedHistory, input.moduleId);
    let result = lockedLatestResult?.result ?? null;
    if (lockedLatestResult) {
      await tx
        .select({ id: attempt.id })
        .from(attempt)
        .where(and(eq(attempt.id, lockedLatestResult.attempt.id), eq(attempt.userId, userId)))
        .limit(1)
        .for("update");
      const [effective] = await tx
        .select({ result: assessmentAttemptEffectiveResult.result })
        .from(assessmentAttemptEffectiveResult)
        .where(eq(assessmentAttemptEffectiveResult.attemptId, lockedLatestResult.attempt.id))
        .limit(1)
        .for("update");
      const [base] = await tx
        .select({ answer: examResponse.answer })
        .from(examResponse)
        .where(and(
          eq(examResponse.attemptId, lockedLatestResult.attempt.id),
          eq(examResponse.itemKey, RESULT_RESPONSE_KEY),
        ))
        .limit(1)
        .for("update");
      result = storedResult(effective?.result) ?? storedResult(base?.answer);
      if (!result) {
        throw new ExamServiceError(
          "The current authoritative result is still being finalized.",
          409,
          "EXAM_FINALIZATION_PENDING",
        );
      }
    }
    const [availableGrant] = lockedLatestResult?.session
      ? await tx
          .select()
          .from(examReexamGrant)
          .where(and(
            eq(examReexamGrant.userId, userId),
            eq(examReexamGrant.moduleId, input.moduleId),
            eq(examReexamGrant.sourceExamSessionId, lockedLatestResult.session.id),
            eq(examReexamGrant.status, "available"),
          ))
          .limit(1)
          .for("update")
      : [];
    const lockedEvidenceRows = result?.remediation.required
      ? await remediationEvidenceRows(userId, tx)
      : [];
    const remediationComplete = hasPersistedRemediationEvidence({
      result,
      form: lockedLatestResult?.form ?? null,
      evidenceRows: lockedEvidenceRows,
    });
    const durationMinutes = lockedLatest?.form?.durationMinutes
      ?? Math.min(45, Math.max(10, courseModule.skills.length * 6));
    const retake = computeRetakeEligibility({
      result,
      durationMinutes,
      nowMs: now.getTime(),
      remediationComplete,
    });
    const grantUsed = availableGrant && canConsumeEquivalentReexamGrant({
      result,
      grantSourceExamSessionId: availableGrant.sourceExamSessionId,
      authoritativeExamSessionId: lockedLatestResult?.session?.id ?? null,
    }) ? availableGrant : undefined;
    if (result !== null && !retake.eligible && !grantUsed) {
      throw new ExamServiceError(
        "This module is not yet eligible for a retake.",
        409,
        "RETAKE_NOT_ELIGIBLE",
        { retake },
      );
    }
    const parity = result !== null && lockedLatestResult?.form
      ? verifyEquivalentFormParity(lockedLatestResult.form, form)
      : null;
    if (result !== null && (!parity || !parity.equivalent)) {
      throw new ExamServiceError(
        "The new form has not passed equivalent-version parity against the prior reviewed form.",
        409,
        "RETAKE_FORM_PARITY_FAILED",
        { issues: parity?.issues ?? ["SOURCE_FORM_MISSING"] },
      );
    }

    const priorForms = await tx
      .select({ answer: examResponse.answer })
      .from(examResponse)
      .innerJoin(attempt, eq(examResponse.attemptId, attempt.id))
      .where(and(
        eq(attempt.userId, userId),
        eq(examResponse.itemKey, BLUEPRINT_RESPONSE_KEY),
      ));
    const attemptNumber = priorForms.filter(
      (row) => storedForm(row.answer)?.moduleId === input.moduleId,
    ).length + 1;
    const [createdAttempt] = await tx
      .insert(attempt)
      .values({
        userId,
        kind: attemptNumber === 1 ? "exam" : "retake",
        attemptNumber,
        status: "in_progress",
        policyVersion: EXAM_POLICY_VERSION,
        contentVersion: form.contentVersion,
        startedAt: now,
      })
      .returning({ id: attempt.id });
    const [createdSession] = await tx
      .insert(examSession)
      .values({
        attemptId: createdAttempt.id,
        userId,
        status: "active",
        serverStartedAt: now,
        serverDeadlineAt: deadline,
        lastHeartbeatAt: now,
        integrityReviewState: "not_required",
      })
      .returning({ id: examSession.id });
    createdSessionId = createdSession.id;
    await tx.insert(examFinalizationJob).values({
      examSessionId: createdSession.id,
      status: "scheduled",
      dueAt: deadline,
    });
    await tx.insert(examResponse).values({
      attemptId: createdAttempt.id,
      itemKey: BLUEPRINT_RESPONSE_KEY,
      revision: 1,
      answer: jsonRecord({ snapshot: form }),
      source: "server",
      savedAt: now,
    });
    await tx.insert(examEvent).values([
      {
        examSessionId: createdSession.id,
        clientEventId: `disclosure:${form.formId}`,
        type: "integrity_disclosure_accepted",
        metadata: {
          disclosureVersion: form.integrityDisclosure.version,
          readinessAcknowledged: true,
        },
        occurredAt: now,
      },
      ...(attemptNumber > 1 && remediationComplete
        ? [{
            examSessionId: createdSession.id,
            clientEventId: `remediation:${form.formId}`,
            type: "remediation_evidence_verified",
            metadata: {
              priorAttemptId: lockedLatestResult?.attempt.id ?? null,
              evidenceSource: "persisted_deterministic_evidence_after_failure",
            },
            occurredAt: now,
          }]
        : []),
      ...(parity
        ? [{
            examSessionId: createdSession.id,
            clientEventId: `form-parity:${form.formId}`,
            type: "equivalent_form_parity_verified",
            metadata: {
              sourceBlueprintHash: parity.sourceBlueprintHash,
              candidateBlueprintHash: parity.candidateBlueprintHash,
              contentVersion: form.contentVersion,
              policyVersion: form.policyVersion,
            },
            occurredAt: now,
          }]
        : []),
      ...(grantUsed
        ? [{
            examSessionId: createdSession.id,
            clientEventId: `reexam-grant:${grantUsed.id}`,
            type: "admin_reexam_grant_consumed",
            metadata: { grantId: grantUsed.id, sourceExamSessionId: grantUsed.sourceExamSessionId },
            occurredAt: now,
          }]
        : []),
    ]);
    if (grantUsed) {
      await tx
        .update(examReexamGrant)
        .set({ status: "consumed", consumedByAttemptId: createdAttempt.id, consumedAt: now, updatedAt: now })
        .where(and(eq(examReexamGrant.id, grantUsed.id), eq(examReexamGrant.status, "available")));
    }
  });
  for (let serializableAttempt = 0; ; serializableAttempt += 1) {
    try {
      await admit();
      break;
    } catch (error) {
      if (!hasPostgresErrorCode(error, "40001") || serializableAttempt >= 2) throw error;
    }
  }
  return getExamSession(userId, createdSessionId, now);
}

export async function startMasteryRecheck(
  userId: string,
  recheckId: string,
  input: StartExamInput,
  now = new Date(),
): Promise<ExamSessionView> {
  const device = evaluateStartDevice(input.device);
  if (!device.allowed) {
    throw new ExamServiceError(
      "Mastery rechecks can only be started on a desktop or tablet-sized device.",
      422,
      "UNSUPPORTED_EXAM_DEVICE",
      { reason: device.reason },
    );
  }
  if (!input.integrityDisclosureAccepted || !input.readinessAcknowledged) {
    throw new ExamServiceError(
      "Accept the integrity disclosure and readiness statement before starting.",
      400,
      "EXAM_ACKNOWLEDGEMENT_REQUIRED",
    );
  }
  const [scheduled] = await db
    .select()
    .from(examMasteryRecheck)
    .where(and(eq(examMasteryRecheck.id, recheckId), eq(examMasteryRecheck.userId, userId)))
    .limit(1);
  if (!scheduled || scheduled.moduleId !== input.moduleId) {
    throw new ExamServiceError("Mastery recheck was not found.", 404, "MASTERY_RECHECK_NOT_FOUND");
  }
  if (scheduled.dueAt.getTime() > now.getTime()) {
    throw new ExamServiceError(
      "The targeted mastery recheck is not due yet.",
      409,
      "MASTERY_RECHECK_NOT_DUE",
      { dueAt: scheduled.dueAt.toISOString() },
    );
  }
  const publishedCourses = await listPublishedExamCourses();
  const published = publishedCourses
    .map((publication) => ({
      ...publication,
      module: publication.course.modules.find((candidate) => candidate.id === scheduled.moduleId),
    }))
    .find((publication) => publication.module !== undefined);
  if (!published?.module) {
    throw new ExamServiceError(
      "The current independently reviewed publication no longer contains this module.",
      409,
      "MASTERY_RECHECK_PUBLICATION_MISSING",
    );
  }
  const candidate = buildEquivalentExamForm({
    course: published.course,
    module: published.module,
    catalogVersion: `published:${published.courseVersionId}`,
    now,
    assessmentBanks: published.assessmentBanks.filter((bank) => bank.moduleId === scheduled.moduleId),
  });
  let createdSessionId = "";
  await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level serializable`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`exam-recheck:${userId}:${recheckId}`}))`);
    const [locked] = await tx
      .select()
      .from(examMasteryRecheck)
      .where(and(eq(examMasteryRecheck.id, recheckId), eq(examMasteryRecheck.userId, userId)))
      .limit(1)
      .for("update");
    if (!locked) throw new ExamServiceError("Mastery recheck was not found.", 404, "MASTERY_RECHECK_NOT_FOUND");
    if (locked.recheckAttemptId) {
      const [existing] = await tx
        .select({ sessionId: examSession.id })
        .from(examSession)
        .where(eq(examSession.attemptId, locked.recheckAttemptId))
        .limit(1);
      throw new ExamServiceError(
        "This mastery recheck already has an exam session.",
        409,
        "MASTERY_RECHECK_ALREADY_STARTED",
        { sessionId: existing?.sessionId ?? null },
      );
    }
    if (locked.dueAt.getTime() > now.getTime() || !["scheduled", "available"].includes(locked.status)) {
      throw new ExamServiceError("This mastery recheck is not available.", 409, "MASTERY_RECHECK_NOT_AVAILABLE");
    }
    const [sourceAttempt] = await tx
      .select({
        id: attempt.id,
        kind: attempt.kind,
        passed: attempt.passed,
        policyVersion: attempt.policyVersion,
        contentVersion: attempt.contentVersion,
      })
      .from(attempt)
      .where(and(eq(attempt.id, locked.sourceAttemptId), eq(attempt.userId, userId)))
      .limit(1)
      .for("update");
    const [blueprintRow] = await tx
      .select({ answer: examResponse.answer })
      .from(examResponse)
      .where(and(
        eq(examResponse.attemptId, locked.sourceAttemptId),
        eq(examResponse.itemKey, BLUEPRINT_RESPONSE_KEY),
      ))
      .limit(1)
      .for("update");
    const [effective] = await tx
      .select({ result: assessmentAttemptEffectiveResult.result })
      .from(assessmentAttemptEffectiveResult)
      .where(eq(assessmentAttemptEffectiveResult.attemptId, locked.sourceAttemptId))
      .limit(1)
      .for("update");
    const [baseResult] = await tx
      .select({ answer: examResponse.answer })
      .from(examResponse)
      .where(and(
        eq(examResponse.attemptId, locked.sourceAttemptId),
        eq(examResponse.itemKey, RESULT_RESPONSE_KEY),
      ))
      .limit(1)
      .for("update");
    const sourceForm = storedForm(blueprintRow?.answer);
    const sourceResult = storedResult(effective?.result) ?? storedResult(baseResult?.answer);
    if (
      !sourceAttempt || !["exam", "retake"].includes(sourceAttempt.kind) || sourceAttempt.passed !== true ||
      !sourceForm || sourceForm.moduleId !== locked.moduleId ||
      sourceForm.contentVersion !== locked.contentVersion || sourceForm.policyVersion !== locked.policyVersion ||
      sourceAttempt.contentVersion !== locked.contentVersion || sourceAttempt.policyVersion !== locked.policyVersion ||
      !sourceResult || sourceResult.outcome !== "PASSED" || !sourceResult.masteryRecheck?.required ||
      !sameStringSet(sourceResult.masteryRecheck.clusterIds, locked.targetClusterIds) ||
      !sameStringSet(sourceResult.masteryRecheck.codingItemIds, locked.targetCodingItemIds)
    ) {
      throw new ExamServiceError(
        "The locked authoritative source pass no longer matches this recheck schedule.",
        409,
        "MASTERY_RECHECK_SOURCE_INVALID",
      );
    }
    let form: ExamFormSnapshot;
    try {
      form = buildTargetedMasteryRecheckForm({ sourceForm, sourceResult, candidateForm: candidate, now });
    } catch (error) {
      throw new ExamServiceError(
        "The current reviewed publication could not prove a shorter equivalent recheck form.",
        409,
        "MASTERY_RECHECK_PARITY_FAILED",
        { reason: error instanceof Error ? error.message.slice(0, 300) : "UNKNOWN" },
      );
    }
    const parity = verifyEquivalentFormParity(sourceForm, candidate);
    const deadline = new Date(now.getTime() + form.durationMinutes * 60_000);
    const [otherActive] = await tx
      .select({ id: examSession.id })
      .from(examSession)
      .where(and(eq(examSession.userId, userId), eq(examSession.status, "active")))
      .limit(1);
    if (otherActive) {
      throw new ExamServiceError(
        "Resume the active closed-book session before starting another.",
        409,
        "EXAM_ALREADY_ACTIVE",
        { sessionId: otherActive.id },
      );
    }
    const [createdAttempt] = await tx
      .insert(attempt)
      .values({
        userId,
        kind: "mastery_check",
        attemptNumber: 1,
        status: "in_progress",
        policyVersion: form.policyVersion,
        contentVersion: form.contentVersion,
        startedAt: now,
      })
      .returning({ id: attempt.id });
    const [createdSession] = await tx
      .insert(examSession)
      .values({
        attemptId: createdAttempt.id,
        userId,
        status: "active",
        serverStartedAt: now,
        serverDeadlineAt: deadline,
        lastHeartbeatAt: now,
        integrityReviewState: "not_required",
      })
      .returning({ id: examSession.id });
    createdSessionId = createdSession.id;
    await tx.insert(examFinalizationJob).values({ examSessionId: createdSession.id, dueAt: deadline });
    await tx.insert(examResponse).values({
      attemptId: createdAttempt.id,
      itemKey: BLUEPRINT_RESPONSE_KEY,
      revision: 1,
      answer: jsonRecord({ snapshot: form }),
      source: "server",
      savedAt: now,
    });
    await tx.insert(examEvent).values({
      examSessionId: createdSession.id,
      clientEventId: `mastery-recheck:${recheckId}`,
      type: "mastery_recheck_started",
      metadata: {
        sourceAttemptId: locked.sourceAttemptId,
        sourceBlueprintHash: parity.sourceBlueprintHash,
        candidateBlueprintHash: parity.candidateBlueprintHash,
        priorPassProtected: true,
        targetCount: form.items.length,
      },
      occurredAt: now,
    });
    await tx
      .update(examMasteryRecheck)
      .set({ status: "active", recheckAttemptId: createdAttempt.id, updatedAt: now })
      .where(eq(examMasteryRecheck.id, recheckId));
  });
  return getExamSession(userId, createdSessionId, now);
}

export async function getExamSession(
  userId: string,
  sessionId: string,
  now = new Date(),
): Promise<ExamSessionView> {
  let owned = await ownedSession(userId, sessionId);
  if (owned.session.status === "active" && hasDeadlinePassed(owned.session.serverDeadlineAt, now)) {
    await finalizeExam(userId, sessionId, "deadline", now).catch((error: unknown) => {
      if (!(error instanceof ExamServiceError && error.code === "FINALIZATION_IN_PROGRESS")) throw error;
    });
    owned = await ownedSession(userId, sessionId);
  }
  const [form, answers, result, appealRows] = await Promise.all([
    formForAttempt(owned.attempt.id),
    answersForAttempt(owned.attempt.id),
    resultForAttempt(owned.attempt.id),
    db
      .select({
        id: appeal.id,
        status: appeal.status,
        decision: appeal.decision,
        decisionReason: appeal.decisionReason,
        updatedAt: appeal.updatedAt,
      })
      .from(appeal)
      .where(and(eq(appeal.userId, userId), eq(appeal.attemptId, owned.attempt.id)))
      .orderBy(desc(appeal.createdAt))
      .limit(1),
  ]);
  if (!owned.session.serverStartedAt || !owned.session.serverDeadlineAt) {
    throw new ExamServiceError("Exam timer was not initialized.", 500, "EXAM_TIMER_MISSING");
  }
  return {
    sessionId,
    attemptId: owned.attempt.id,
    attemptNumber: owned.attempt.attemptNumber,
    status: owned.session.status as ExamSessionStatus,
    serverNow: now.toISOString(),
    serverStartedAt: owned.session.serverStartedAt.toISOString(),
    serverDeadlineAt: owned.session.serverDeadlineAt.toISOString(),
    disconnectedSeconds: owned.session.disconnectedSeconds,
    integrityReviewState: owned.session.integrityReviewState,
    form: toPublicExamForm(form),
    answers: answers.saved,
    result,
    retake: result === null || owned.attempt.kind === "mastery_check" ? null : computeRetakeEligibility({
      result,
      durationMinutes: form.durationMinutes,
      nowMs: now.getTime(),
      remediationComplete: false,
    }),
    appealSubmitted: appealRows.length > 0,
    appeal: appealRows[0]
      ? {
          id: appealRows[0].id,
          status: appealRows[0].status,
          decision: appealRows[0].decision,
          decisionReason: appealRows[0].decisionReason,
          updatedAt: appealRows[0].updatedAt.toISOString(),
        }
      : null,
  };
}

export async function autosaveExamAnswer(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly clientMutationId: string;
  readonly itemId: string;
  readonly baseRevision: number;
  readonly answer: ExamAnswer;
  readonly now?: Date;
}): Promise<SavedExamAutosaveResult> {
  const now = input.now ?? new Date();
  const normalizedAnswer: ExamAnswer = {
    ...(input.answer.text === undefined ? {} : { text: input.answer.text }),
    ...(input.answer.sourceCode === undefined ? {} : { sourceCode: input.answer.sourceCode }),
    ...(input.answer.language === undefined ? {} : { language: input.answer.language }),
  };
  const inputHash = createHash("sha256")
    .update("codestead-exam-autosave-mutation-v1\0")
    .update(JSON.stringify([
      input.userId,
      input.sessionId,
      input.itemId,
      input.baseRevision,
      normalizedAnswer.text ?? null,
      normalizedAnswer.sourceCode ?? null,
      normalizedAnswer.language ?? null,
    ]))
    .digest("hex");
  try {
    return await db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ session: examSession, attempt })
        .from(examSession)
        .innerJoin(attempt, eq(examSession.attemptId, attempt.id))
        .where(and(
          eq(examSession.id, input.sessionId),
          eq(examSession.userId, input.userId),
        ))
        .limit(1)
        .for("update");
      if (!owned) {
        throw new ExamServiceError("Exam session was not found.", 404, "EXAM_NOT_FOUND");
      }
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`exam-autosave:${input.sessionId}:${input.clientMutationId}`}, 0)
        )
      `);
      const [receipt] = await tx
        .select({
          itemKey: examAutosaveMutation.itemKey,
          inputHash: examAutosaveMutation.inputHash,
          expectedRevision: examAutosaveMutation.expectedRevision,
          resultingRevision: examAutosaveMutation.resultingRevision,
          resultingSavedAt: examAutosaveMutation.resultingSavedAt,
        })
        .from(examAutosaveMutation)
        .where(and(
          eq(examAutosaveMutation.examSessionId, input.sessionId),
          eq(examAutosaveMutation.clientMutationId, input.clientMutationId),
        ))
        .limit(1);
      if (receipt) {
        if (
          receipt.itemKey !== input.itemId ||
          receipt.expectedRevision !== input.baseRevision ||
          receipt.inputHash !== inputHash
        ) {
          throw new ExamServiceError(
            "This autosave mutation identifier was already used for different input.",
            409,
            "AUTOSAVE_IDEMPOTENCY_MISMATCH",
          );
        }
        return {
          revision: receipt.resultingRevision,
          answer: normalizedAnswer,
          savedAt: receipt.resultingSavedAt.toISOString(),
          clientMutationId: input.clientMutationId,
          replayed: true,
        };
      }
      if (owned.session.status !== "active") {
        throw new ExamServiceError("This exam no longer accepts answers.", 409, "EXAM_NOT_ACTIVE");
      }
      if (hasDeadlinePassed(owned.session.serverDeadlineAt, now)) {
        throw new ExamServiceError("The server deadline has passed.", 409, "EXAM_EXPIRED");
      }
      const [blueprintRow] = await tx
        .select({ answer: examResponse.answer })
        .from(examResponse)
        .where(and(
          eq(examResponse.attemptId, owned.attempt.id),
          eq(examResponse.itemKey, BLUEPRINT_RESPONSE_KEY),
        ))
        .limit(1);
      const form = storedForm(blueprintRow?.answer);
      if (!form?.items.some((item) => item.id === input.itemId)) {
        throw new ExamServiceError("Question does not belong to this form.", 400, "UNKNOWN_EXAM_ITEM");
      }
      const [current] = await tx
        .select({
          revision: examResponse.revision,
          answer: examResponse.answer,
          savedAt: examResponse.savedAt,
        })
        .from(examResponse)
        .where(and(
          eq(examResponse.attemptId, owned.attempt.id),
          eq(examResponse.itemKey, input.itemId),
        ))
        .orderBy(desc(examResponse.revision))
        .limit(1);
      const currentRevision = current?.revision ?? 0;
      if (input.baseRevision !== currentRevision) {
        throw new ExamServiceError(
          "A newer autosave already exists.",
          409,
          "AUTOSAVE_REVISION_CONFLICT",
          {
            currentRevision,
            currentAnswer: current ? answerRecord(current.answer) : {},
            currentSavedAt: current?.savedAt.toISOString() ?? null,
          },
        );
      }
      const revision = currentRevision + 1;
      const [saved] = await tx
        .insert(examResponse)
        .values({
          attemptId: owned.attempt.id,
          itemKey: input.itemId,
          revision,
          answer: jsonRecord(normalizedAnswer),
          source: "browser",
          savedAt: now,
        })
        .returning({ savedAt: examResponse.savedAt });
      await tx.insert(examAutosaveMutation).values({
        examSessionId: input.sessionId,
        clientMutationId: input.clientMutationId,
        itemKey: input.itemId,
        inputHash,
        expectedRevision: input.baseRevision,
        resultingRevision: revision,
        resultingSavedAt: saved.savedAt,
      });
      return {
        revision,
        answer: normalizedAnswer,
        savedAt: saved.savedAt.toISOString(),
        clientMutationId: input.clientMutationId,
        replayed: false,
      };
    });
  } catch (error) {
    if (error instanceof ExamServiceError && error.code === "EXAM_EXPIRED") {
      await finalizeExam(input.userId, input.sessionId, "deadline", now).catch(() => undefined);
    }
    throw error;
  }
}

export async function heartbeatExam(
  userId: string,
  sessionId: string,
  now = new Date(),
): Promise<{
  readonly status: ExamSessionStatus;
  readonly serverNow: string;
  readonly serverDeadlineAt: string;
  readonly disconnectedSeconds: number;
}> {
  const initial = await ownedSession(userId, sessionId);
  if (!initial.session.serverDeadlineAt) {
    throw new ExamServiceError("Exam timer was not initialized.", 500, "EXAM_TIMER_MISSING");
  }
  if (initial.session.status === "active" && hasDeadlinePassed(initial.session.serverDeadlineAt, now)) {
    await finalizeExam(userId, sessionId, "deadline", now).catch(() => undefined);
    const finalized = await ownedSession(userId, sessionId);
    return {
      status: finalized.session.status as ExamSessionStatus,
      serverNow: now.toISOString(),
      serverDeadlineAt: initial.session.serverDeadlineAt.toISOString(),
      disconnectedSeconds: finalized.session.disconnectedSeconds,
    };
  }
  if (initial.session.status !== "active") {
    return {
      status: initial.session.status as ExamSessionStatus,
      serverNow: now.toISOString(),
      serverDeadlineAt: initial.session.serverDeadlineAt.toISOString(),
      disconnectedSeconds: initial.session.disconnectedSeconds,
    };
  }
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ session: examSession })
      .from(examSession)
      .where(and(eq(examSession.id, sessionId), eq(examSession.userId, userId)))
      .limit(1)
      .for("update");
    if (!owned?.session.serverDeadlineAt) {
      throw new ExamServiceError("Exam timer was not initialized.", 500, "EXAM_TIMER_MISSING");
    }
    if (owned.session.status !== "active") {
      return {
        status: owned.session.status as ExamSessionStatus,
        serverNow: now.toISOString(),
        serverDeadlineAt: owned.session.serverDeadlineAt.toISOString(),
        disconnectedSeconds: owned.session.disconnectedSeconds,
      };
    }
    const priorHeartbeat = owned.session.lastHeartbeatAt;
    const delta = disconnectedDeltaSeconds(priorHeartbeat, now);
    const disconnectedSeconds = owned.session.disconnectedSeconds + delta;
    await tx
      .update(examSession)
      .set({ lastHeartbeatAt: now, disconnectedSeconds })
      .where(eq(examSession.id, sessionId));
    if (delta >= MATERIAL_DISCONNECT_SECONDS && priorHeartbeat) {
      await tx
        .insert(examEvent)
        .values({
          examSessionId: sessionId,
          clientEventId: `server-disconnect:${priorHeartbeat.getTime()}:${now.getTime()}`,
          type: "server_material_disconnect",
          metadata: {
            disconnectedSeconds: delta,
            lastHeartbeatAt: priorHeartbeat.toISOString(),
            restoredAt: now.toISOString(),
          },
          occurredAt: now,
        })
        .onConflictDoNothing({ target: [examEvent.examSessionId, examEvent.clientEventId] });
    }
    return {
      status: "active" as const,
      serverNow: now.toISOString(),
      serverDeadlineAt: owned.session.serverDeadlineAt.toISOString(),
      disconnectedSeconds,
    };
  });
}

export async function recordExamEvent(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly clientEventId: string;
  readonly type: ClientExamEventType;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly now?: Date;
}): Promise<{ readonly accepted: boolean; readonly duplicate: boolean }> {
  await ownedSession(input.userId, input.sessionId);
  const inserted = await db
    .insert(examEvent)
    .values({
      examSessionId: input.sessionId,
      clientEventId: input.clientEventId,
      type: input.type,
      metadata: sanitizeEventMetadata(input.metadata),
      occurredAt: input.now ?? new Date(),
    })
    .onConflictDoNothing({ target: [examEvent.examSessionId, examEvent.clientEventId] })
    .returning({ id: examEvent.id });
  return { accepted: true, duplicate: inserted.length === 0 };
}

function stableRunnerId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
}

function normalizedRunnerResult(
  job: RunnerJobResponse,
  sourceHash: string,
  fallbackRuntimeVersion: string,
  startedAt: Date,
  finishedAt: Date,
): ExamRunnerResult | null {
  const raw = job.result;
  if (!raw) return null;
  const statuses = new Set<ExamRunnerResult["status"]>([
    "COMPILE_ONLY", "ACCEPTED", "WRONG_ANSWER", "COMPILE_ERROR", "RUNTIME_ERROR",
    "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT", "INFRASTRUCTURE_ERROR",
  ]);
  const compileStatuses = new Set<ExamRunnerResult["compile"]["status"]>([
    "OK", "COMPILE_ERROR", "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT", "INFRASTRUCTURE_ERROR",
  ]);
  const testStatuses = new Set<ExamRunnerResult["tests"][number]["status"]>([
    "PASSED", "FAILED", "RUNTIME_ERROR", "TIMEOUT", "MEMORY_LIMIT", "OUTPUT_LIMIT",
    "INFRASTRUCTURE_ERROR",
  ]);
  const status = statuses.has(raw.status as ExamRunnerResult["status"])
    ? raw.status as ExamRunnerResult["status"]
    : "INFRASTRUCTURE_ERROR";
  const compileStatus = compileStatuses.has(raw.compile.status as ExamRunnerResult["compile"]["status"])
    ? raw.compile.status as ExamRunnerResult["compile"]["status"]
    : "INFRASTRUCTURE_ERROR";
  return {
    status,
    requestHash: job.requestHash,
    sourceHash,
    runtimeVersion: raw.runtimeVersion ?? fallbackRuntimeVersion,
    imageDigest: raw.imageDigest,
    compile: {
      status: compileStatus,
      exitCode: raw.compile.exitCode,
      stdout: raw.compile.stdout,
      stderr: raw.compile.stderr,
      wallTimeMs: 0,
    },
    ...(raw.run ? { run: { ...raw.run } } : {}),
    tests: raw.tests.map((test) => ({
      id: test.id,
      visibility: test.visibility === "HIDDEN" ? "HIDDEN" : "VISIBLE",
      category: test.category,
      status: testStatuses.has(test.status as ExamRunnerResult["tests"][number]["status"])
        ? test.status as ExamRunnerResult["tests"][number]["status"]
        : "INFRASTRUCTURE_ERROR",
      feedbackCode: test.feedbackCode,
      exitCode: null,
      wallTimeMs: 0,
    })),
    totals: raw.totals,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

function storedExamRunnerResult(admission: RunnerAdmission): ExamRunnerResult | null {
  const stored = record(admission.result);
  if (
    admission.status !== "succeeded"
    && admission.status !== "timed_out"
  ) return null;
  if (
    typeof stored?.status !== "string"
    || typeof stored.requestHash !== "string"
    || typeof stored.sourceHash !== "string"
    || typeof stored.runtimeVersion !== "string"
    || typeof stored.imageDigest !== "string"
    || record(stored.compile) === null
    || !Array.isArray(stored.tests)
    || record(stored.totals) === null
  ) return null;
  return stored as unknown as ExamRunnerResult;
}

function examRunnerBindingError(
  input: {
    readonly mode: "COMPILE" | "RUN" | "TEST";
    readonly tests?: RunnerRequest["tests"];
    readonly expectedRuntimeVersion?: string;
    readonly expectedRuntimeImageDigest?: string;
  },
  result: ExamRunnerResult,
): "RUNNER_RUNTIME_MISMATCH" | "RUNNER_TEST_MANIFEST_MISMATCH" | null {
  if (
    (input.expectedRuntimeVersion !== undefined
      && result.runtimeVersion !== input.expectedRuntimeVersion)
    || (input.expectedRuntimeImageDigest !== undefined
      && result.imageDigest !== input.expectedRuntimeImageDigest)
  ) return "RUNNER_RUNTIME_MISMATCH";
  if (
    input.mode === "TEST"
    && input.tests !== undefined
    && !hasExactRunnerTestManifest(input.tests, result)
  ) return "RUNNER_TEST_MANIFEST_MISMATCH";
  return null;
}

function throwExamRunnerBindingError(code: NonNullable<ReturnType<typeof examRunnerBindingError>>): never {
  throw new ExamServiceError(
    "The isolated runner result did not match the authored official evidence binding.",
    502,
    code,
  );
}

async function reconcileExamRunnerResult(
  admission: RunnerAdmission,
  binding: Parameters<typeof examRunnerBindingError>[0],
) {
  let refreshed: RunnerAdmission;
  try {
    refreshed = await refreshRunnerAdmission(admission);
  } catch {
    throw new ExamServiceError(
      "The terminal runner admission could not be reconciled yet.",
      503,
      "RUNNER_INDETERMINATE",
      { retryable: true, indeterminate: true, remoteJobId: admission.remoteJobId },
    );
  }
  const result = storedExamRunnerResult(refreshed);
  if (result) {
    const bindingError = examRunnerBindingError(binding, result);
    if (bindingError) throwExamRunnerBindingError(bindingError);
    return result;
  }
  if (["queued", "leased", "running"].includes(refreshed.status)) {
    throw new ExamServiceError(
      "The runner admission is still active. Finalization will reconcile the same request safely.",
      503,
      "RUNNER_INDETERMINATE",
      { retryable: true, indeterminate: true, remoteJobId: refreshed.remoteJobId },
    );
  }
  throw new ExamServiceError(
    "The prior runner admission ended without executable evidence. Finalization will retry safely.",
    503,
    "RUNNER_CAPACITY_BUSY",
    { retryable: true, replayed: true },
  );
}

async function executeExamCode(input: {
  readonly userId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly itemId: string;
  readonly language: RunnerLanguage;
  readonly sourceCode: string;
  readonly stdin?: string;
  readonly mode: "COMPILE" | "RUN" | "TEST";
  readonly tests?: RunnerRequest["tests"];
  readonly testBundleVersion?: string;
  readonly expectedRuntimeVersion?: string;
  readonly expectedRuntimeImageDigest?: string;
  readonly idempotencySeed: string;
  readonly submissionType: string;
}): Promise<ExamRunnerResult> {
  const runtime = runtimeByLanguage[input.language];
  if (
    input.submissionType === "exam_final_test"
    && (!input.expectedRuntimeVersion || !input.expectedRuntimeImageDigest)
  ) {
    throw new ExamServiceError(
      "The official exam item has no pinned runtime identity.",
      500,
      "RUNNER_RUNTIME_PIN_MISSING",
    );
  }
  const requestedRuntimeVersion = input.expectedRuntimeVersion ?? runtime.version;
  const sourceHash = createHash("sha256").update(input.sourceCode).digest("hex");
  const runnerSubmissionId = stableRunnerId("exam-submission", input.idempotencySeed);
  const correlationId = stableRunnerId("exam-correlation", `${input.sessionId}:${input.itemId}`);
  const idempotencyKey = stableRunnerId("exam-run", input.idempotencySeed);
  const admissionRequestId = stableRunnerId("exam-admission", input.idempotencySeed);
  const startedAt = new Date();
  const request: RunnerRequest = {
    submissionId: runnerSubmissionId,
    correlationId,
    language: input.language,
    runtimeVersion: requestedRuntimeVersion,
    mode: input.mode,
    sourceFiles: [{ path: runtime.entrypoint, content: input.sourceCode }],
    entrypoint: runtime.entrypoint,
    ...(input.stdin !== undefined && input.mode === "RUN" ? { stdin: input.stdin } : {}),
    ...(input.tests !== undefined && input.mode === "TEST" ? { tests: input.tests } : {}),
    ...(input.testBundleVersion !== undefined && input.mode === "TEST"
      ? { testBundleVersion: input.testBundleVersion }
      : {}),
    limits: { ...EXECUTION_LIMITS },
  };
  const admissionHash = hashRunnerAdmissionRequest({
    schemaVersion: 1,
    userId: input.userId,
    attemptId: input.attemptId,
    itemId: input.itemId,
    submissionType: input.submissionType,
    sourceHash,
    expectedRuntimeImageDigest: input.expectedRuntimeImageDigest ?? null,
    request,
  });
  let admission: RunnerAdmission;
  try {
    admission = await admitRunnerJob({
      userId: input.userId,
      attemptId: input.attemptId,
      language: input.language,
      sourceCode: input.sourceCode,
      sourceHash,
      submissionType: input.submissionType,
      requestId: admissionRequestId,
      requestHash: admissionHash,
      limits: EXECUTION_LIMITS,
      now: startedAt,
    });
  } catch (error) {
    if (error instanceof RunnerAdmissionError && error.code === "OFFICIAL_CAPACITY_BUSY") {
      throw new ExamServiceError(
        "Another official runner job for this learner is active. Finalization will retry safely.",
        503,
        "RUNNER_OFFICIAL_CAPACITY_BUSY",
        { retryable: true },
      );
    }
    if (error instanceof RunnerAdmissionError && error.code === "IDEMPOTENCY_MISMATCH") {
      throw new ExamServiceError(
        "This code-run request id was already used for different input.",
        409,
        "RUNNER_IDEMPOTENCY_MISMATCH",
      );
    }
    if (error instanceof RunnerAdmissionError && error.code === "USER_NOT_ACTIVE") {
      throw new ExamServiceError(
        "This learner account is no longer active, so official exam evidence cannot be changed.",
        409,
        "LEARNER_NOT_ACTIVE",
      );
    }
    throw error;
  }
  if (admission.duplicate && !["queued", "leased", "running"].includes(admission.status)) {
    const replay = storedExamRunnerResult(admission);
    if (replay) {
      const bindingError = examRunnerBindingError(input, replay);
      if (bindingError) throwExamRunnerBindingError(bindingError);
      return replay;
    }
    throw new ExamServiceError(
      "The prior runner admission ended without executable evidence. Finalization will retry safely.",
      503,
      "RUNNER_CAPACITY_BUSY",
      { retryable: true, replayed: true },
    );
  }
  let trustedRemoteResponseReceived = false;
  let immutableRemoteJobId = admission.remoteJobId;
  let remoteJobId = admission.remoteJobId;
  try {
    const dispatchBoundary = await beginRunnerDispatch({ admission, now: startedAt });
    requireFreshRunnerMutation(dispatchBoundary);
    immutableRemoteJobId = dispatchBoundary.remoteJobId ?? admission.remoteJobId;
    remoteJobId = immutableRemoteJobId;
    const client = configuredRunnerClient();
    let completed: RunnerJobResponse;
    if (immutableRemoteJobId !== null) {
      completed = await client.waitForJob(immutableRemoteJobId, request);
      trustedRemoteResponseReceived = true;
    } else {
      const submitted = await client.submit(request, idempotencyKey);
      trustedRemoteResponseReceived = true;
      remoteJobId = submitted.jobId;
      if (submitted.state === "QUEUED" || submitted.state === "RUNNING") {
        const dispatch = await persistRunnerMutationAfterRemote({
          remoteJobId: submitted.jobId,
          preserveError: (error) => error instanceof RunnerAdmissionError,
          mutation: () => recordRunnerDispatch({
            admission,
            remoteJobId: submitted.jobId,
            status: submitted.state === "QUEUED" ? "queued" : "running",
          }),
        });
        requireFreshRunnerMutation(dispatch);
      }
      completed = submitted.state === "QUEUED" || submitted.state === "RUNNING"
        ? await client.waitFrom(submitted, request)
        : submitted;
    }
    const finishedAt = new Date();
    const result = normalizedRunnerResult(
      completed,
      sourceHash,
      requestedRuntimeVersion,
      startedAt,
      finishedAt,
    );
    const bindingError = result === null ? null : examRunnerBindingError(input, result);
    if (bindingError && result) {
      const bindingSettlement = await persistRunnerMutationAfterRemote({
        remoteJobId: completed.jobId,
        preserveError: (error) => error instanceof RunnerAdmissionError,
        mutation: () => settleRunnerJob({
          admission,
          status: "failed",
          remoteJobId: completed.jobId,
          result: {
            error: bindingError,
            expectedRuntimeVersion: input.expectedRuntimeVersion,
            observedRuntimeVersion: result.runtimeVersion,
            expectedRuntimeImageDigest: input.expectedRuntimeImageDigest,
            observedRuntimeImageDigest: result.imageDigest,
          },
          runtimeImageDigest: "runner-runtime-mismatch",
          startedAt,
          completedAt: finishedAt,
        }),
      });
      requireFreshRunnerMutation(bindingSettlement);
      throwExamRunnerBindingError(bindingError);
    }
    const infrastructureFailure = result === null || result.status === "INFRASTRUCTURE_ERROR";
    const timedOut = result?.status === "TIMEOUT";
    const persistedStatus = timedOut ? "timed_out" : infrastructureFailure ? "failed" : "succeeded";
    const settlement = await persistRunnerMutationAfterRemote({
      remoteJobId: completed.jobId,
      preserveError: (error) => error instanceof RunnerAdmissionError,
      mutation: () => settleRunnerJob({
        admission,
        status: persistedStatus,
        remoteJobId: completed.jobId,
        result: jsonRecord(result ?? { error: completed.error?.code ?? "RUNNER_RESULT_MISSING" }),
        runtimeImageDigest: result?.imageDigest ?? "runner-infrastructure-error",
        startedAt,
        completedAt: finishedAt,
      }),
    });
    requireFreshRunnerMutation(settlement);
    if (result === null) {
      throw new ExamServiceError(
        "The isolated runner did not return a trusted result.",
        502,
        "RUNNER_RESULT_MISSING",
      );
    }
    return result;
  } catch (error) {
    const terminalReplay = error instanceof RunnerAdmissionError && error.code === "TERMINAL_REPLAY";
    if (terminalReplay) return reconcileExamRunnerResult(admission, input);
    if (error instanceof RunnerAdmissionError && error.code === "USER_NOT_ACTIVE") {
      throw new ExamServiceError(
        "This learner account is no longer active, so official exam evidence cannot be changed.",
        409,
        "LEARNER_NOT_ACTIVE",
      );
    }
    const unresolvedReplay = isUnresolvedActiveRunnerReplay({
      duplicate: admission.duplicate,
      status: admission.status,
      remoteJobId: immutableRemoteJobId,
      trustedRemoteResponseReceived,
    });
    const remoteIdentityConflict = error instanceof RunnerAdmissionError
      && isIndeterminateRunnerIdentityConflict(error.code);
    if (error instanceof ExamServiceError) throw error;
    const postRemoteAmbiguity = error instanceof RunnerPersistenceAmbiguityError
      || runnerFailureRequiresReconciliation({
        trustedRemoteResponseReceived,
        remoteJobId,
      });
    if (
      error instanceof RunnerIndeterminateError
      || unresolvedReplay
      || remoteIdentityConflict
      || postRemoteAmbiguity
    ) {
      throw new ExamServiceError(
        "The runner dispatch outcome is indeterminate. Finalization will reconcile the same request safely.",
        503,
        "RUNNER_INDETERMINATE",
        {
          retryable: true,
          indeterminate: true,
          remoteJobId: error instanceof RunnerIndeterminateError
            ? error.remoteJobId
            : error instanceof RunnerPersistenceAmbiguityError
              ? error.remoteJobId
              : remoteJobId ?? immutableRemoteJobId,
        },
      );
    }
    const capacityBusy = error instanceof RunnerClientError
      && (error.code === "QUEUE_FULL" || error.status === 429 || (error.retryable && error.status === 503));
    await settleRunnerJob({
      admission,
      status: "failed",
      remoteJobId,
      result: { error: capacityBusy ? "RUNNER_CAPACITY_BUSY" : error instanceof Error ? error.name : "RUNNER_FAILURE" },
      runtimeImageDigest: "runner-infrastructure-error",
      startedAt,
      completedAt: new Date(),
    }).catch(() => undefined);
    if (capacityBusy) {
      throw new ExamServiceError(
        "The runner dispatch slot is unavailable. This official operation will retry safely.",
        503,
        "RUNNER_CAPACITY_BUSY",
        { retryable: true },
      );
    }
    throw new ExamServiceError(
      "The isolated runner is unavailable. The source was saved but not executed.",
      502,
      "RUNNER_UNAVAILABLE",
    );
  }
}

export async function runExamCode(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly itemId: string;
  readonly sourceCode: string;
  readonly stdin?: string;
  readonly mode: "COMPILE" | "RUN";
  readonly clientRequestId: string;
  readonly now?: Date;
}): Promise<ExamRunnerResult> {
  const now = input.now ?? new Date();
  const owned = await ownedSession(input.userId, input.sessionId);
  if (
    owned.session.status !== "active" ||
    hasDeadlinePassed(owned.session.serverDeadlineAt, now)
  ) {
    if (hasDeadlinePassed(owned.session.serverDeadlineAt, now)) {
      await finalizeExam(input.userId, input.sessionId, "deadline", now).catch(() => undefined);
    }
    throw new ExamServiceError("This exam no longer accepts code runs.", 409, "EXAM_NOT_ACTIVE");
  }
  const form = await formForAttempt(owned.attempt.id);
  const item = form.items.find((candidate) => candidate.id === input.itemId);
  if (!item || item.kind !== "code" || !item.language) {
    throw new ExamServiceError("This question is not executable.", 400, "ITEM_NOT_EXECUTABLE");
  }
  const result = await executeExamCode({
    userId: input.userId,
    attemptId: owned.attempt.id,
    sessionId: input.sessionId,
    itemId: item.id,
    language: item.language,
    sourceCode: input.sourceCode,
    stdin: input.stdin,
    mode: input.mode,
    expectedRuntimeVersion: item.runtime?.version,
    expectedRuntimeImageDigest: item.runtime?.imageDigest,
    idempotencySeed: `${input.sessionId}:${item.id}:${input.clientRequestId}`,
    submissionType: input.mode === "COMPILE" ? "exam_compile" : "exam_run",
  });
  await db
    .insert(examEvent)
    .values({
      examSessionId: input.sessionId,
      clientEventId: `execution:${input.clientRequestId}`,
      type: input.mode === "COMPILE" ? "compile_requested" : "run_requested",
      metadata: { itemId: item.id, resultStatus: result.status },
      occurredAt: now,
    })
    .onConflictDoNothing({ target: [examEvent.examSessionId, examEvent.clientEventId] });
  return result;
}

interface FinalizationClaim {
  readonly attemptId: string;
  readonly attemptKind: AttemptRow["kind"];
  readonly form: ExamFormSnapshot;
  readonly answers: Readonly<Record<string, ExamAnswer>>;
  readonly revisions: Readonly<Record<string, number>>;
  readonly finalizedBy: ExamFinalizationReason;
  readonly runnerRequestGeneration: number;
}

export interface ExamFinalizationLeaseFence {
  readonly jobId: string;
  readonly owner: string;
  readonly attemptCount: number;
  readonly clock: () => Date;
}

interface FinalizeExamOptions {
  readonly leaseFence?: ExamFinalizationLeaseFence;
  readonly beforePersist?: () => Promise<void>;
  readonly beforeMasteryAward?: () => Promise<void>;
}

async function lockFinalizationAuthority(
  tx: DrizzleTransaction,
  sessionId: string,
  at: Date,
  fence?: ExamFinalizationLeaseFence,
) {
  const [job] = await tx
    .select({
      id: examFinalizationJob.id,
      status: examFinalizationJob.status,
      leaseOwner: examFinalizationJob.leaseOwner,
      leaseExpiresAt: examFinalizationJob.leaseExpiresAt,
      attemptCount: examFinalizationJob.attemptCount,
      runnerRequestGeneration: examFinalizationJob.runnerRequestGeneration,
    })
    .from(examFinalizationJob)
    .where(eq(examFinalizationJob.examSessionId, sessionId))
    .limit(1)
    .for("update");
  const checkedAt = fence?.clock() ?? at;
  if (fence) {
    if (
      !Number.isFinite(checkedAt.getTime()) ||
      !job || job.id !== fence.jobId || job.status !== "leased" ||
      job.leaseOwner !== fence.owner || job.attemptCount !== fence.attemptCount ||
      !job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= checkedAt.getTime()
    ) {
      throw new ExamServiceError(
        "The finalization worker no longer owns this lease.",
        409,
        "FINALIZATION_LEASE_LOST",
      );
    }
  } else if (
    job?.status === "leased" && job.leaseExpiresAt &&
    job.leaseExpiresAt.getTime() > checkedAt.getTime()
  ) {
    throw new ExamServiceError(
      "Exam finalization is already in progress.",
      409,
      "FINALIZATION_IN_PROGRESS",
    );
  }
  return job;
}

async function claimFinalization(
  userId: string,
  sessionId: string,
  requestedReason: ExamFinalizationReason,
  now: Date,
  fence?: ExamFinalizationLeaseFence,
): Promise<FinalizationClaim | ExamResult> {
  return db.transaction(async (tx) => {
    await lockActiveOfficialExamUser(tx, userId);
    const job = await lockFinalizationAuthority(tx, sessionId, now, fence);
    const [owned] = await tx
      .select({ session: examSession, attempt })
      .from(examSession)
      .innerJoin(attempt, eq(examSession.attemptId, attempt.id))
      .where(and(eq(examSession.id, sessionId), eq(examSession.userId, userId)))
      .limit(1)
      .for("update");
    if (!owned) {
      throw new ExamServiceError("Exam session was not found.", 404, "EXAM_NOT_FOUND");
    }
    const [existingResultRow] = await tx
      .select({ answer: examResponse.answer })
      .from(examResponse)
      .where(and(
        eq(examResponse.attemptId, owned.attempt.id),
        eq(examResponse.itemKey, RESULT_RESPONSE_KEY),
      ))
      .limit(1);
    const existing = storedResult(existingResultRow?.answer);
    if (existing !== null) return existing;
    const recoverable =
      (owned.session.status === "submitted" || owned.session.status === "expired") &&
      now.getTime() - owned.session.updatedAt.getTime() >= 120_000;
    if (owned.session.status !== "active" && !recoverable) {
      throw new ExamServiceError(
        "Exam finalization is already in progress.",
        409,
        "FINALIZATION_IN_PROGRESS",
      );
    }
    const finalizedBy: ExamFinalizationReason = recoverable
      ? owned.session.status === "expired" || owned.session.finalizedBy === "deadline"
        ? "deadline"
        : "learner-submit"
      : hasDeadlinePassed(owned.session.serverDeadlineAt, now)
        ? "deadline"
        : requestedReason;
    const rows = await tx
      .select({
        itemKey: examResponse.itemKey,
        revision: examResponse.revision,
        answer: examResponse.answer,
        savedAt: examResponse.savedAt,
      })
      .from(examResponse)
      .where(eq(examResponse.attemptId, owned.attempt.id));
    const blueprintRow = rows.find((row) => row.itemKey === BLUEPRINT_RESPONSE_KEY);
    const form = storedForm(blueprintRow?.answer);
    if (form === null) {
      throw new ExamServiceError(
        "The immutable exam form is unavailable.",
        500,
        "EXAM_FORM_MISSING",
      );
    }
    const latest = latestRevisionByItem(rows
      .filter((row) => row.itemKey !== BLUEPRINT_RESPONSE_KEY && row.itemKey !== RESULT_RESPONSE_KEY)
      .map((row) => ({ ...row, value: answerRecord(row.answer) })));
    const answers: Record<string, ExamAnswer> = {};
    const revisions: Record<string, number> = {};
    for (const [itemId, row] of latest) {
      answers[itemId] = row.value;
      revisions[itemId] = row.revision;
    }
    if (owned.session.status === "active" && owned.session.serverDeadlineAt) {
      const cutoff = new Date(Math.min(now.getTime(), owned.session.serverDeadlineAt.getTime()));
      const delta = disconnectedDeltaSeconds(owned.session.lastHeartbeatAt, cutoff);
      if (delta > 0) {
        await tx
          .update(examSession)
          .set({ disconnectedSeconds: owned.session.disconnectedSeconds + delta })
          .where(eq(examSession.id, sessionId));
      }
      if (delta >= MATERIAL_DISCONNECT_SECONDS && owned.session.lastHeartbeatAt) {
        const disconnectType = finalizedBy === "deadline"
          ? "server_deadline_disconnect"
          : "server_material_disconnect";
        await tx
          .insert(examEvent)
          .values({
            examSessionId: sessionId,
            clientEventId: `${disconnectType}:${owned.session.lastHeartbeatAt.getTime()}:${cutoff.getTime()}`,
            type: disconnectType,
            metadata: {
              disconnectedSeconds: delta,
              lastHeartbeatAt: owned.session.lastHeartbeatAt.toISOString(),
              measuredUntil: cutoff.toISOString(),
            },
            occurredAt: now,
          })
          .onConflictDoNothing({ target: [examEvent.examSessionId, examEvent.clientEventId] });
      }
    }
    await tx
      .update(examSession)
      .set({
        status: finalizedBy === "deadline" ? "expired" : "submitted",
        finalizedBy,
      })
      .where(eq(examSession.id, sessionId));
    await tx
      .update(attempt)
      .set({ status: "submitted", submittedAt: now })
      .where(eq(attempt.id, owned.attempt.id));
    await tx
      .update(examResponse)
      .set({ submittedAt: now })
      .where(eq(examResponse.attemptId, owned.attempt.id));
    const recoveryDueAt = new Date(now.getTime() + 120_000);
    await tx
      .insert(examFinalizationJob)
      .values({ examSessionId: sessionId, status: "scheduled", dueAt: recoveryDueAt })
      .onConflictDoUpdate({
        target: examFinalizationJob.examSessionId,
        set: { dueAt: recoveryDueAt, updatedAt: now },
      });
    return {
      attemptId: owned.attempt.id,
      attemptKind: owned.attempt.kind,
      form,
      answers,
      revisions,
      finalizedBy,
      runnerRequestGeneration: job?.runnerRequestGeneration ?? 1,
    };
  });
}

function isExamResult(value: FinalizationClaim | ExamResult): value is ExamResult {
  return "gradingStatus" in value;
}

async function ensureMasteryRecheckProjection(input: {
  readonly userId: string;
  readonly attemptId: string;
  readonly form: ExamFormSnapshot;
  readonly result: ExamResult;
  readonly now: Date;
}) {
  await db.transaction(async (tx) => {
    await lockActiveOfficialExamUser(tx, input.userId);
    const [attemptRow] = await tx
      .select({ kind: attempt.kind })
      .from(attempt)
      .where(eq(attempt.id, input.attemptId))
      .limit(1)
      .for("update");
    if (attemptRow?.kind === "mastery_check") {
      await tx
        .update(examMasteryRecheck)
        .set({
          status: "completed",
          completedAt: input.now,
          resultOutcome: input.result.outcome,
          updatedAt: input.now,
        })
        .where(and(
          eq(examMasteryRecheck.recheckAttemptId, input.attemptId),
          eq(examMasteryRecheck.status, "active"),
        ));
      return;
    }
    const targets = input.result.masteryRecheck;
    if (input.result.outcome !== "PASSED" || !targets?.required) return;
    const dueAt = new Date(Date.parse(input.result.finalizedAt) + MASTERY_RECHECK_DELAY_MS);
    await tx
      .insert(examMasteryRecheck)
      .values({
        userId: input.userId,
        sourceAttemptId: input.attemptId,
        moduleId: input.form.moduleId,
        contentVersion: input.form.contentVersion,
        policyVersion: input.form.policyVersion,
        status: dueAt.getTime() <= input.now.getTime() ? "available" : "scheduled",
        dueAt,
        targetClusterIds: [...targets.clusterIds],
        targetCodingItemIds: [...targets.codingItemIds],
      })
      .onConflictDoNothing({ target: examMasteryRecheck.sourceAttemptId });
  });
}

async function ensureExamMasteryBadge(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly form: ExamFormSnapshot;
  readonly result: ExamResult;
}) {
  if (input.result.outcome !== "MASTERED" || input.result.officialScorePercent === null) return;
  try {
    await awardExamModuleMastery({
      userId: input.userId,
      attemptId: input.attemptId,
      courseId: input.form.courseId,
      courseTitle: input.form.courseTitle,
      moduleId: input.form.moduleId,
      moduleTitle: input.form.moduleTitle,
      scorePercent: input.result.officialScorePercent,
      criticalRequirementsMet:
        input.result.failedCriticalClusters.length === 0 &&
        input.result.masteryBlockingCodingItems.length === 0 &&
        input.result.compilationGatePassed !== false,
    });
  } catch (error) {
    if (error instanceof ExamMasteryAwardError && error.code === "LEARNER_NOT_ACTIVE") return;
    // Exam truth is already durable and must not be rolled back by a badge
    // projection failure. Record a deterministic repair marker for operators;
    // a later idempotent finalize/read can safely retry the award.
    await db
      .transaction(async (tx) => {
        await lockActiveOfficialExamUser(tx, input.userId);
        await tx
          .insert(examEvent)
          .values({
            examSessionId: input.sessionId,
            clientEventId: `mastery-award-pending:${input.attemptId}`,
            type: "mastery_award_pending",
            metadata: { errorCode: "MASTERY_AWARD_FAILED" },
          })
          .onConflictDoNothing({
            target: [examEvent.examSessionId, examEvent.clientEventId],
          });
      })
      .catch(() => undefined);
  }
}

export async function finalizeExam(
  userId: string,
  sessionId: string,
  requestedReason: ExamFinalizationReason,
  now = new Date(),
  options: FinalizeExamOptions = {},
): Promise<ExamResult> {
  const claim = await claimFinalization(
    userId,
    sessionId,
    requestedReason,
    now,
    options.leaseFence,
  );
  if (isExamResult(claim)) {
    await db.transaction(async (tx) => {
      await lockActiveOfficialExamUser(tx, userId);
      await lockFinalizationAuthority(tx, sessionId, now, options.leaseFence);
      await tx
        .update(examFinalizationJob)
        .set({
          status: "succeeded", leaseOwner: null, leaseExpiresAt: null,
          completedAt: now, lastErrorCode: null, updatedAt: now,
        })
        .where(eq(examFinalizationJob.examSessionId, sessionId));
    });
    const owned = await ownedSession(userId, sessionId);
    const form = await formForAttempt(owned.attempt.id);
    await ensureMasteryRecheckProjection({
      userId, attemptId: owned.attempt.id, form, result: claim, now,
    });
    if (claim.outcome === "MASTERED") {
      await options.beforeMasteryAward?.();
      await ensureExamMasteryBadge({
        userId,
        sessionId,
        attemptId: owned.attempt.id,
        form,
        result: claim,
      });
    }
    return claim;
  }

  const runnerResults: Record<string, ExamRunnerResult> = {};
  for (const item of claim.form.items) {
    if (item.gradingEvidence.kind !== "runner-tests") continue;
    const answer = claim.answers[item.id];
    if (!item.language || !(answer?.sourceCode ?? "").trim()) continue;
    try {
      runnerResults[item.id] = await executeExamCode({
        userId,
        attemptId: claim.attemptId,
        sessionId,
        itemId: item.id,
        language: item.language,
        sourceCode: answer!.sourceCode!,
        mode: "TEST",
        tests: item.gradingEvidence.tests.map((test) => ({
          id: test.id,
          visibility: test.visibility,
          category: test.category,
          stdin: test.stdin,
          expectedStdout: test.expectedStdout,
          comparison: test.comparison,
        })),
        testBundleVersion: item.gradingEvidence.bundleVersion,
        expectedRuntimeVersion: item.runtime?.version,
        expectedRuntimeImageDigest: item.runtime?.imageDigest,
        idempotencySeed: examFinalizationRunnerSeed({
          sessionId,
          itemId: item.id,
          revision: claim.revisions[item.id] ?? 0,
          runnerRequestGeneration: claim.runnerRequestGeneration,
        }),
        submissionType: "exam_final_test",
      });
    } catch (error) {
      const capacityDeferred = error instanceof ExamServiceError
        && (
          error.code === "RUNNER_OFFICIAL_CAPACITY_BUSY" ||
          error.code === "RUNNER_CAPACITY_BUSY" ||
          error.code === "RUNNER_INDETERMINATE"
        );
      const learnerInactive = error instanceof ExamServiceError && error.code === "LEARNER_NOT_ACTIVE";
      await db.transaction(async (tx) => {
        await lockActiveOfficialExamUser(tx, userId);
        await lockFinalizationAuthority(tx, sessionId, now, options.leaseFence);
        await tx
          .insert(examEvent)
          .values({
            examSessionId: sessionId,
            clientEventId: `${capacityDeferred ? "runner-capacity" : "runner-failure"}:${item.id}:${claim.revisions[item.id] ?? 0}`,
            type: capacityDeferred ? "runner_capacity_deferred" : "runner_infrastructure_failure",
            metadata: {
              itemId: item.id,
              errorCode: error instanceof ExamServiceError ? error.code : "RUNNER_FAILURE",
              retryable: capacityDeferred,
            },
            occurredAt: now,
          })
          .onConflictDoNothing({ target: [examEvent.examSessionId, examEvent.clientEventId] });
      });
      if (capacityDeferred || learnerInactive) throw error;
    }
  }

  const result = gradeExamSubmission({
    form: claim.form,
    answers: claim.answers,
    runnerResults,
    finalizedAt: now.toISOString(),
    finalizedBy: claim.finalizedBy,
  });
  await options.beforePersist?.();
  const persistedResult = await db.transaction(async (tx) => {
    await lockActiveOfficialExamUser(tx, userId);
    await lockFinalizationAuthority(tx, sessionId, now, options.leaseFence);
    await tx
      .insert(examResponse)
      .values({
        attemptId: claim.attemptId,
        itemKey: RESULT_RESPONSE_KEY,
        revision: 1,
        answer: jsonRecord({ result }),
        source: "server",
        savedAt: now,
        submittedAt: now,
      })
      .onConflictDoNothing({
        target: [examResponse.attemptId, examResponse.itemKey, examResponse.revision],
      });
    const [persistedRow] = await tx
      .select({ answer: examResponse.answer })
      .from(examResponse)
      .where(and(
        eq(examResponse.attemptId, claim.attemptId),
        eq(examResponse.itemKey, RESULT_RESPONSE_KEY),
      ))
      .limit(1)
      .for("update");
    const winningResult = storedResult(persistedRow?.answer);
    if (!winningResult) {
      throw new ExamServiceError(
        "The official exam result could not be persisted.",
        500,
        "FINALIZATION_RESULT_MISSING",
      );
    }
    await tx
      .update(attempt)
      .set({
        status: winningResult.gradingStatus === "graded" ? "graded" : "grading",
        score: winningResult.officialScorePercent,
        passed: winningResult.gradingStatus === "graded"
          ? winningResult.outcome === "PASSED" || winningResult.outcome === "MASTERED"
          : null,
        masteryAwarded: winningResult.outcome === "MASTERED",
        infrastructureFailure: winningResult.infrastructureFailure,
        gradedAt: winningResult.gradingStatus === "graded" ? now : null,
      })
      .where(eq(attempt.id, claim.attemptId));
    await tx
      .update(examSession)
      .set({
        status: winningResult.gradingStatus === "graded" ? "graded" : "under_review",
        integrityReviewState: winningResult.infrastructureFailure
          ? "technical_incident"
          : winningResult.gradingStatus === "pending-review"
            ? "manual_grading_required"
            : "not_required",
      })
      .where(eq(examSession.id, sessionId));
    await tx
      .update(examFinalizationJob)
      .set({
        status: "succeeded", leaseOwner: null, leaseExpiresAt: null,
        completedAt: now, lastErrorCode: null, updatedAt: now,
      })
      .where(eq(examFinalizationJob.examSessionId, sessionId));
    if (claim.attemptKind === "mastery_check") {
      await tx
        .update(examMasteryRecheck)
        .set({
          status: "completed",
          completedAt: now,
          resultOutcome: winningResult.outcome,
          updatedAt: now,
        })
        .where(and(
          eq(examMasteryRecheck.recheckAttemptId, claim.attemptId),
          eq(examMasteryRecheck.status, "active"),
        ));
    } else if (winningResult.outcome === "PASSED" && winningResult.masteryRecheck?.required) {
      const dueAt = new Date(Date.parse(winningResult.finalizedAt) + MASTERY_RECHECK_DELAY_MS);
      await tx
        .insert(examMasteryRecheck)
        .values({
          userId,
          sourceAttemptId: claim.attemptId,
          moduleId: claim.form.moduleId,
          contentVersion: claim.form.contentVersion,
          policyVersion: claim.form.policyVersion,
          status: dueAt.getTime() <= now.getTime() ? "available" : "scheduled",
          dueAt,
          targetClusterIds: [...winningResult.masteryRecheck.clusterIds],
          targetCodingItemIds: [...winningResult.masteryRecheck.codingItemIds],
        })
        .onConflictDoNothing({ target: examMasteryRecheck.sourceAttemptId });
    }
    return winningResult;
  });
  if (persistedResult.outcome === "MASTERED") await options.beforeMasteryAward?.();
  await ensureExamMasteryBadge({
    userId,
    sessionId,
    attemptId: claim.attemptId,
    form: claim.form,
    result: persistedResult,
  });
  return persistedResult;
}

export async function submitExam(
  userId: string,
  sessionId: string,
  now = new Date(),
): Promise<ExamSessionView> {
  await finalizeExam(userId, sessionId, "learner-submit", now);
  return getExamSession(userId, sessionId, now);
}

export async function submitExamAppeal(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly clientRequestId: string;
  readonly category: "scoring" | "technical" | "integrity" | "accessibility";
  readonly reason: string;
  readonly now?: Date;
}): Promise<{
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly appealId: string;
}> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!Number.isFinite(now.getTime())) {
    throw new ExamServiceError("Appeal timestamp is invalid.", 400, "INVALID_APPEAL_TIME");
  }
  if (reason.length < 20 || reason.length > 1_000) {
    throw new ExamServiceError(
      "Give a concise appeal reason from 20 to 1000 characters.",
      400,
      "INVALID_APPEAL",
    );
  }
  if (!UUID_PATTERN.test(input.clientRequestId)) {
    throw new ExamServiceError("Appeal request id must be a UUID.", 400, "INVALID_APPEAL_REQUEST_ID");
  }
  const owned = await ownedSession(input.userId, input.sessionId);
  if (owned.session.status === "active" || owned.session.status === "scheduled") {
    throw new ExamServiceError(
      "An appeal can be submitted after the exam is finalized.",
      409,
      "APPEAL_TOO_EARLY",
    );
  }
  const [form, answers, result, submissions] = await Promise.all([
    formForAttempt(owned.attempt.id),
    answersForAttempt(owned.attempt.id),
    resultForAttempt(owned.attempt.id),
    db
      .select({
        id: codeSubmission.id,
        sourceHash: codeSubmission.sourceHash,
        runtimeImageDigest: codeSubmission.runtimeImageDigest,
        status: codeSubmission.status,
        createdAt: codeSubmission.createdAt,
      })
      .from(codeSubmission)
      .where(eq(codeSubmission.attemptId, owned.attempt.id))
      .orderBy(codeSubmission.createdAt, codeSubmission.id),
  ]);
  const snapshot = buildExamAppealEvidence({
    examSessionId: input.sessionId,
    attemptId: owned.attempt.id,
    category: input.category,
    form,
    answers: answers.saved,
    result,
    submissions,
    capturedAt: now,
  });

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ session: examSession, attempt })
      .from(examSession)
      .innerJoin(attempt, eq(examSession.attemptId, attempt.id))
      .where(and(
        eq(examSession.id, input.sessionId),
        eq(examSession.userId, input.userId),
      ))
      .limit(1)
      .for("update");
    if (!locked) {
      throw new ExamServiceError("Exam session was not found.", 404, "EXAM_NOT_FOUND");
    }
    if (locked.session.status === "active" || locked.session.status === "scheduled") {
      throw new ExamServiceError(
        "An appeal can be submitted after the exam is finalized.",
        409,
        "APPEAL_TOO_EARLY",
      );
    }
    const [sameRequest] = await tx
      .select({
        id: appeal.id,
        attemptId: appeal.attemptId,
        category: appeal.category,
        reason: appeal.reason,
      })
      .from(appeal)
      .where(and(
        eq(appeal.userId, input.userId),
        eq(appeal.submissionRequestId, input.clientRequestId),
      ))
      .limit(1);
    if (sameRequest) {
      if (
        sameRequest.attemptId !== locked.attempt.id
        || sameRequest.category !== input.category
        || sameRequest.reason !== reason
      ) {
        throw new ExamServiceError(
          "This appeal request id was already used with different input.",
          409,
          "APPEAL_IDEMPOTENCY_MISMATCH",
        );
      }
      return { accepted: true, duplicate: true, appealId: sameRequest.id } as const;
    }
    const [alreadyOpen] = await tx
      .select({ id: appeal.id })
      .from(appeal)
      .where(and(
        eq(appeal.userId, input.userId),
        eq(appeal.attemptId, locked.attempt.id),
        inArray(appeal.status, ["open", "under_review", "needs_learner_input"]),
      ))
      .limit(1);
    if (alreadyOpen) {
      throw new ExamServiceError(
        "An appeal is already open for this exam attempt.",
        409,
        "APPEAL_ALREADY_OPEN",
      );
    }
    const [created] = await tx
      .insert(appeal)
      .values({
        userId: input.userId,
        attemptId: locked.attempt.id,
        category: input.category,
        submissionRequestId: input.clientRequestId,
        reason,
        evidence: snapshot.evidence,
        evidenceHash: snapshot.evidenceHash,
        status: "open",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: appeal.id });
    if (!created) {
      const [raced] = await tx
        .select({
          id: appeal.id,
          attemptId: appeal.attemptId,
          category: appeal.category,
          reason: appeal.reason,
        })
        .from(appeal)
        .where(and(
          eq(appeal.userId, input.userId),
          eq(appeal.submissionRequestId, input.clientRequestId),
        ))
        .limit(1);
      if (
        raced
        && raced.attemptId === locked.attempt.id
        && raced.category === input.category
        && raced.reason === reason
      ) {
        return { accepted: true, duplicate: true, appealId: raced.id } as const;
      }
      throw new ExamServiceError("Appeal could not be recorded.", 409, "APPEAL_WRITE_CONFLICT");
    }
    await tx.insert(appealEvent).values({
      appealId: created.id,
      actorUserId: input.userId,
      actorRole: "learner",
      event: "submitted",
      clientRequestId: input.clientRequestId,
      reason,
      evidence: {
        category: input.category,
        evidenceHash: snapshot.evidenceHash,
        infrastructureClaim: input.category === "technical",
      },
      occurredAt: now,
    });
    await tx
      .insert(examEvent)
      .values({
        examSessionId: input.sessionId,
        clientEventId: `appeal:${input.clientRequestId}`,
        type: "appeal_submitted",
        metadata: {
          appealId: created.id,
          category: input.category,
          infrastructureClaim: input.category === "technical",
        },
        occurredAt: now,
      })
      .onConflictDoNothing({ target: [examEvent.examSessionId, examEvent.clientEventId] });
    await tx
      .update(examSession)
      .set({
        integrityReviewState: "appeal_pending",
        status: "under_review",
      })
      .where(eq(examSession.id, input.sessionId));
    return { accepted: true, duplicate: false, appealId: created.id } as const;
  });
}

export async function submitExamAppealReply(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly clientRequestId: string;
  readonly message: string;
  readonly now?: Date;
}): Promise<{
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly appealId: string;
  readonly rowVersion: number;
}> {
  const now = input.now ?? new Date();
  const message = input.message.trim();
  if (!Number.isFinite(now.getTime())) {
    throw new ExamServiceError("Appeal reply timestamp is invalid.", 400, "INVALID_APPEAL_REPLY_TIME");
  }
  if (!UUID_PATTERN.test(input.clientRequestId)) {
    throw new ExamServiceError("Appeal reply request id must be a UUID.", 400, "INVALID_APPEAL_REPLY_REQUEST_ID");
  }
  if (message.length < 20 || message.length > 2_000) {
    throw new ExamServiceError(
      "Give a reply from 20 to 2000 characters.",
      400,
      "INVALID_APPEAL_REPLY",
    );
  }

  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ session: examSession, attempt })
      .from(examSession)
      .innerJoin(attempt, eq(examSession.attemptId, attempt.id))
      .where(and(
        eq(examSession.id, input.sessionId),
        eq(examSession.userId, input.userId),
      ))
      .limit(1)
      .for("update");
    if (!locked) {
      throw new ExamServiceError("Exam session was not found.", 404, "EXAM_NOT_FOUND");
    }
    const [current] = await tx
      .select({
        id: appeal.id,
        status: appeal.status,
        rowVersion: appeal.rowVersion,
      })
      .from(appeal)
      .where(and(
        eq(appeal.userId, input.userId),
        eq(appeal.attemptId, locked.attempt.id),
      ))
      .orderBy(desc(appeal.createdAt), desc(appeal.id))
      .limit(1)
      .for("update");
    if (!current) {
      throw new ExamServiceError("Appeal was not found.", 404, "APPEAL_NOT_FOUND");
    }
    const [prior] = await tx
      .select({
        actorUserId: appealEvent.actorUserId,
        event: appealEvent.event,
        reason: appealEvent.reason,
        evidence: appealEvent.evidence,
      })
      .from(appealEvent)
      .where(and(
        eq(appealEvent.appealId, current.id),
        eq(appealEvent.clientRequestId, input.clientRequestId),
      ))
      .limit(1);
    if (prior) {
      if (
        prior.actorUserId !== input.userId
        || prior.event !== "learner_response"
        || prior.reason !== message
      ) {
        throw new ExamServiceError(
          "This reply request id was already used with different input.",
          409,
          "APPEAL_REPLY_IDEMPOTENCY_MISMATCH",
        );
      }
      return {
        accepted: true,
        duplicate: true,
        appealId: current.id,
        rowVersion: Number(prior.evidence.resultingVersion ?? current.rowVersion),
      } as const;
    }
    if (current.status !== "needs_learner_input") {
      throw new ExamServiceError(
        "The reviewer has not requested more information for this appeal.",
        409,
        "APPEAL_REPLY_NOT_REQUESTED",
      );
    }
    const resultingVersion = current.rowVersion + 1;
    await tx.insert(appealEvent).values({
      appealId: current.id,
      actorUserId: input.userId,
      actorRole: "learner",
      event: "learner_response",
      clientRequestId: input.clientRequestId,
      reason: message,
      evidence: {
        priorStatus: current.status,
        priorVersion: current.rowVersion,
        resultingStatus: "under_review",
        resultingVersion,
      },
      occurredAt: now,
    });
    const [updated] = await tx
      .update(appeal)
      .set({
        status: "under_review",
        rowVersion: resultingVersion,
        updatedAt: now,
      })
      .where(and(
        eq(appeal.id, current.id),
        eq(appeal.status, "needs_learner_input"),
        eq(appeal.rowVersion, current.rowVersion),
      ))
      .returning({ id: appeal.id });
    if (!updated) {
      throw new ExamServiceError("Appeal reply conflicted with another update.", 409, "APPEAL_REPLY_CONFLICT");
    }
    await tx
      .insert(examEvent)
      .values({
        examSessionId: input.sessionId,
        clientEventId: `appeal-reply:${input.clientRequestId}`,
        type: "appeal_learner_response",
        metadata: { appealId: current.id, resultingVersion },
        occurredAt: now,
      })
      .onConflictDoNothing({ target: [examEvent.examSessionId, examEvent.clientEventId] });
    await tx
      .update(examSession)
      .set({
        status: "under_review",
        integrityReviewState: "appeal_pending_after_learner_response",
        updatedAt: now,
      })
      .where(eq(examSession.id, input.sessionId));
    const administrators = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.role, "admin"), eq(user.status, "active")))
      .limit(10);
    if (administrators.length > 0) {
      await tx.insert(notification).values(administrators.map((administrator) => ({
        userId: administrator.id,
        type: "appeal-updated",
        title: "A learner replied to an appeal",
        body: "New clarification evidence is ready for human review.",
        actionUrl: `/admin/appeals?appeal=${current.id}`,
        createdAt: now,
      })));
    }
    return {
      accepted: true,
      duplicate: false,
      appealId: current.id,
      rowVersion: resultingVersion,
    } as const;
  });
}
