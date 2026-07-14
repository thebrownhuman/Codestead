import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";

import { percentage, safeLastFour, safeOperationalCode } from "@/components/admin/admin-utils";
import type {
  AdminDashboardData,
  LearnerDetailData,
  SafeCredentialSummary,
  StatusCount,
} from "@/components/admin/types";
import { ContentRepository } from "@/lib/content";
import { db } from "@/lib/db/client";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "@/lib/storage/policy";
import {
  accessRequest,
  activity,
  appeal,
  assessmentAttemptEffectiveResult,
  attempt,
  auditEvent,
  backgroundJob,
  chatMessage,
  chatThread,
  concept,
  conceptMastery,
  course,
  courseModule,
  courseVersion,
  emailOutbox,
  enrollment,
  learnerProfile,
  learningSession,
  lesson,
  lessonBlock,
  project,
  projectReview,
  providerCredential,
  providerPolicy,
  quotaLedger,
  runnerJob,
  session,
  storedObject,
  user,
} from "@/lib/db/schema";

const contentRepository = new ContentRepository();

const effectiveAttemptScore = sql<number | null>`case
  when ${assessmentAttemptEffectiveResult.attemptId} is not null
    then nullif(${assessmentAttemptEffectiveResult.result} ->> 'officialScorePercent', '')::float8
  else ${attempt.score}
end`;
const effectiveAttemptPassed = sql<boolean | null>`case
  when ${assessmentAttemptEffectiveResult.attemptId} is not null
    then case
      when ${assessmentAttemptEffectiveResult.result} ->> 'gradingStatus' = 'graded'
        then (${assessmentAttemptEffectiveResult.result} ->> 'outcome') in ('PASSED', 'MASTERED')
      else null
    end
  else ${attempt.passed}
end`;
const effectiveAttemptMastery = sql<boolean>`case
  when ${assessmentAttemptEffectiveResult.attemptId} is not null
    then ${assessmentAttemptEffectiveResult.result} ->> 'outcome' = 'MASTERED'
  else coalesce(${attempt.masteryAwarded}, false)
end`;
const effectiveAttemptInfrastructureFailure = sql<boolean>`case
  when ${assessmentAttemptEffectiveResult.attemptId} is not null
    then coalesce((${assessmentAttemptEffectiveResult.result} ->> 'infrastructureFailure')::boolean, false)
  else ${attempt.infrastructureFailure}
end`;

function toNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function statusCounts(
  rows: readonly { readonly status: string; readonly count: unknown }[],
): readonly StatusCount[] {
  return rows
    .map((row) => ({ status: row.status, count: toNumber(row.count) }))
    .sort((left, right) => left.status.localeCompare(right.status));
}

function storageQuotaBytes(): number | null {
  const parsed = Number(process.env.STORAGE_QUOTA_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeCredential(row: {
  readonly id: string;
  readonly ownerPublicId: string;
  readonly ownerName: string;
  readonly provider: string;
  readonly lastFour: string;
  readonly status: string;
  readonly preferred: boolean;
  readonly lastValidatedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly failureCode: string | null;
}): SafeCredentialSummary {
  return {
    id: row.id,
    ownerPublicId: row.ownerPublicId,
    ownerName: row.ownerName,
    provider: row.provider,
    lastFour: safeLastFour(row.lastFour),
    status: row.status,
    preferred: row.preferred,
    lastValidatedAt: toIso(row.lastValidatedAt),
    lastUsedAt: toIso(row.lastUsedAt),
    failureCode: safeOperationalCode(row.failureCode),
  };
}

export async function getAdminDashboardData(now = new Date()): Promise<AdminDashboardData> {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);

  const [
    learnerRows,
    masteryByLearner,
    attemptsByLearner,
    sessionsByLearner,
    accessSummaryRows,
    appealSummaryRows,
    runnerSummaryRows,
    credentialRows,
    credentialStatusRows,
    policyRows,
    publicationRows,
    moduleCountRows,
    lessonCountRows,
    blockCountRows,
    activityCountRows,
    globalMasteryRows,
    globalAttemptRows,
    globalSessionRows,
    globalChatRows,
    globalProjectRows,
    runnerStatusRows,
    runnerOldestRows,
    runnerFailureRows,
    backgroundStatusRows,
    backgroundFailureRows,
    storageRows,
    ledgerRows,
    emailStatusRows,
    emailOldestRows,
    emailFailureRows,
    backupRows,
    appealRows,
    auditRows,
    contentSnapshot,
  ] = await Promise.all([
    db
      .select({
        internalId: user.id,
        publicId: user.publicId,
        name: user.name,
        email: user.email,
        status: user.status,
        lastMeaningfulActivityAt: user.lastMeaningfulActivityAt,
        level: learnerProfile.selfReportedLevel,
        selectedTracks: learnerProfile.selectedTracks,
        onboardingCompletedAt: learnerProfile.onboardingCompletedAt,
      })
      .from(user)
      .leftJoin(learnerProfile, eq(learnerProfile.userId, user.id))
      .where(eq(user.role, "learner"))
      .orderBy(asc(user.name)),
    db
      .select({
        userId: conceptMastery.userId,
        total: sql<number>`count(*)::int`,
        average: sql<number>`coalesce(avg(${conceptMastery.score}), 0)::float8`,
        mastered: sql<number>`count(*) filter (where ${conceptMastery.status} = 'mastered')::int`,
      })
      .from(conceptMastery)
      .groupBy(conceptMastery.userId),
    db
      .select({
        userId: attempt.userId,
        total: sql<number>`count(*)::int`,
        passed: sql<number>`count(*) filter (where ${effectiveAttemptPassed} = true)::int`,
      })
      .from(attempt)
      .leftJoin(
        assessmentAttemptEffectiveResult,
        eq(assessmentAttemptEffectiveResult.attemptId, attempt.id),
      )
      .groupBy(attempt.userId),
    db
      .select({
        userId: learningSession.userId,
        total: sql<number>`count(*)::int`,
        minutes: sql<number>`coalesce(sum(extract(epoch from (${learningSession.endedAt} - ${learningSession.startedAt})) / 60) filter (where ${learningSession.endedAt} is not null), 0)::float8`,
      })
      .from(learningSession)
      .groupBy(learningSession.userId),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(accessRequest)
      .where(eq(accessRequest.status, "pending")),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(appeal)
      .where(inArray(appeal.status, ["open", "under_review", "needs_learner_input"])),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runnerJob)
      .where(inArray(runnerJob.status, ["queued", "leased", "running"])),
    db
      .select({
        id: providerCredential.id,
        ownerPublicId: user.publicId,
        ownerName: user.name,
        provider: providerCredential.provider,
        lastFour: providerCredential.lastFour,
        status: providerCredential.status,
        preferred: providerCredential.isPreferred,
        lastValidatedAt: providerCredential.lastValidatedAt,
        lastUsedAt: providerCredential.lastUsedAt,
        failureCode: providerCredential.failureCode,
      })
      .from(providerCredential)
      .innerJoin(user, eq(user.id, providerCredential.userId))
      .orderBy(asc(user.name), asc(providerCredential.provider)),
    db
      .select({ status: providerCredential.status, count: sql<number>`count(*)::int` })
      .from(providerCredential)
      .groupBy(providerCredential.status),
    db
      .select({
        provider: providerPolicy.provider,
        operation: providerPolicy.operation,
        model: providerPolicy.model,
        priority: providerPolicy.priority,
        enabled: providerPolicy.enabled,
        timeoutMs: providerPolicy.timeoutMs,
      })
      .from(providerPolicy)
      .orderBy(asc(providerPolicy.operation), asc(providerPolicy.priority)),
    db
      .select({
        id: courseVersion.id,
        courseSlug: course.slug,
        title: course.title,
        version: courseVersion.version,
        stage: courseVersion.stage,
        publishedAt: courseVersion.publishedAt,
        updatedAt: courseVersion.updatedAt,
      })
      .from(courseVersion)
      .innerJoin(course, eq(course.id, courseVersion.courseId))
      .orderBy(desc(courseVersion.updatedAt))
      .limit(24),
    db
      .select({
        versionId: courseModule.courseVersionId,
        count: sql<number>`count(*)::int`,
      })
      .from(courseModule)
      .groupBy(courseModule.courseVersionId),
    db
      .select({
        versionId: courseModule.courseVersionId,
        count: sql<number>`count(*)::int`,
        publishable: sql<number>`count(*) filter (where ${lesson.contentStatus} in ('beta', 'verified'))::int`,
      })
      .from(lesson)
      .innerJoin(courseModule, eq(courseModule.id, lesson.moduleId))
      .groupBy(courseModule.courseVersionId),
    db
      .select({
        versionId: courseModule.courseVersionId,
        count: sql<number>`count(*)::int`,
      })
      .from(lessonBlock)
      .innerJoin(lesson, eq(lesson.id, lessonBlock.lessonId))
      .innerJoin(courseModule, eq(courseModule.id, lesson.moduleId))
      .groupBy(courseModule.courseVersionId),
    db
      .select({
        versionId: courseModule.courseVersionId,
        count: sql<number>`count(*)::int`,
      })
      .from(activity)
      .innerJoin(lesson, eq(lesson.id, activity.lessonId))
      .innerJoin(courseModule, eq(courseModule.id, lesson.moduleId))
      .groupBy(courseModule.courseVersionId),
    db
      .select({
        total: sql<number>`count(*)::int`,
        average: sql<number>`coalesce(avg(${conceptMastery.score}), 0)::float8`,
        mastered: sql<number>`count(*) filter (where ${conceptMastery.status} = 'mastered')::int`,
        reviewDue: sql<number>`count(*) filter (where ${conceptMastery.nextReviewAt} <= ${now})::int`,
      })
      .from(conceptMastery),
    db
      .select({
        total: sql<number>`count(*)::int`,
        passed: sql<number>`count(*) filter (where ${effectiveAttemptPassed} = true)::int`,
      })
      .from(attempt)
      .leftJoin(
        assessmentAttemptEffectiveResult,
        eq(assessmentAttemptEffectiveResult.attemptId, attempt.id),
      ),
    db
      .select({
        active: sql<number>`count(*) filter (where ${learningSession.status} = 'active')::int`,
        minutes: sql<number>`coalesce(sum(extract(epoch from (${learningSession.endedAt} - ${learningSession.startedAt})) / 60) filter (where ${learningSession.endedAt} is not null), 0)::float8`,
      })
      .from(learningSession),
    db
      .select({
        threads: sql<number>`count(distinct ${chatThread.id})::int`,
        messages: sql<number>`count(${chatMessage.id})::int`,
      })
      .from(chatThread)
      .leftJoin(chatMessage, eq(chatMessage.threadId, chatThread.id)),
    db.select({ count: sql<number>`count(*)::int` }).from(project),
    db
      .select({ status: runnerJob.status, count: sql<number>`count(*)::int` })
      .from(runnerJob)
      .groupBy(runnerJob.status),
    db
      .select({ queuedAt: sql<Date | null>`min(${runnerJob.queuedAt})` })
      .from(runnerJob)
      .where(eq(runnerJob.status, "queued")),
    db
      .select({
        id: runnerJob.id,
        status: runnerJob.status,
        queuedAt: runnerJob.queuedAt,
        completedAt: runnerJob.completedAt,
      })
      .from(runnerJob)
      .where(inArray(runnerJob.status, ["failed", "timed_out"]))
      .orderBy(desc(runnerJob.queuedAt))
      .limit(8),
    db
      .select({ status: backgroundJob.status, count: sql<number>`count(*)::int` })
      .from(backgroundJob)
      .groupBy(backgroundJob.status),
    db
      .select({
        id: backgroundJob.id,
        type: backgroundJob.type,
        status: backgroundJob.status,
        errorCode: backgroundJob.lastErrorCode,
        createdAt: backgroundJob.createdAt,
      })
      .from(backgroundJob)
      .where(inArray(backgroundJob.status, ["failed", "timed_out"]))
      .orderBy(desc(backgroundJob.createdAt))
      .limit(8),
    db
      .select({
        objects: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${storedObject.sizeBytes}), 0)::float8`,
        pendingScans: sql<number>`count(*) filter (where ${storedObject.scanStatus} in ('pending', 'scanning', 'scanner_error'))::int`,
      })
      .from(storedObject)
      .where(isNull(storedObject.deletedAt)),
    db
      .select({ bytes: sql<number>`coalesce(sum(${quotaLedger.bytes}), 0)::float8` })
      .from(quotaLedger)
      .where(gte(quotaLedger.occurredAt, thirtyDaysAgo)),
    db
      .select({ status: emailOutbox.status, count: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .groupBy(emailOutbox.status),
    db
      .select({ createdAt: sql<Date | null>`min(${emailOutbox.createdAt})` })
      .from(emailOutbox)
      .where(eq(emailOutbox.status, "pending")),
    db
      .select({
        id: emailOutbox.id,
        template: emailOutbox.template,
        errorCode: emailOutbox.lastErrorCode,
        attemptCount: emailOutbox.attemptCount,
        updatedAt: emailOutbox.updatedAt,
      })
      .from(emailOutbox)
      .where(eq(emailOutbox.status, "failed"))
      .orderBy(desc(emailOutbox.updatedAt))
      .limit(8),
    db
      .select({
        type: backgroundJob.type,
        status: backgroundJob.status,
        errorCode: backgroundJob.lastErrorCode,
        createdAt: backgroundJob.createdAt,
        completedAt: backgroundJob.completedAt,
      })
      .from(backgroundJob)
      .where(ilike(backgroundJob.type, "%backup%"))
      .orderBy(desc(backgroundJob.createdAt))
      .limit(1),
    db
      .select({
        id: appeal.id,
        learnerPublicId: user.publicId,
        learnerName: user.name,
        attemptId: appeal.attemptId,
        projectReviewId: appeal.projectReviewId,
        status: appeal.status,
        createdAt: appeal.createdAt,
        decidedAt: appeal.decidedAt,
      })
      .from(appeal)
      .innerJoin(user, eq(user.id, appeal.userId))
      .orderBy(desc(appeal.createdAt))
      .limit(12),
    db
      .select({
        id: auditEvent.id,
        actorName: user.name,
        action: auditEvent.action,
        resourceType: auditEvent.resourceType,
        resourceId: auditEvent.resourceId,
        outcome: auditEvent.outcome,
        occurredAt: auditEvent.occurredAt,
      })
      .from(auditEvent)
      .leftJoin(user, eq(user.id, auditEvent.actorUserId))
      .orderBy(desc(auditEvent.occurredAt))
      .limit(16),
    contentRepository.getSnapshot(),
  ]);

  const masteryMap = new Map(masteryByLearner.map((row) => [row.userId, row]));
  const attemptMap = new Map(attemptsByLearner.map((row) => [row.userId, row]));
  const sessionMap = new Map(sessionsByLearner.map((row) => [row.userId, row]));
  const learners = learnerRows.map((row) => {
    const mastery = masteryMap.get(row.internalId);
    const learnerAttempts = attemptMap.get(row.internalId);
    const learnerSessions = sessionMap.get(row.internalId);
    return {
      publicId: row.publicId,
      name: row.name,
      email: row.email,
      status: row.status,
      level: row.level ?? "not set",
      onboardingComplete: Boolean(row.onboardingCompletedAt),
      selectedTracks: row.selectedTracks ?? [],
      lastMeaningfulActivityAt: toIso(row.lastMeaningfulActivityAt),
      masteryAverage: Math.round(toNumber(mastery?.average) * 1_000) / 10,
      masteredSkills: toNumber(mastery?.mastered),
      attempts: toNumber(learnerAttempts?.total),
      passRate: percentage(toNumber(learnerAttempts?.passed), toNumber(learnerAttempts?.total)),
      sessions: toNumber(learnerSessions?.total),
      sessionMinutes: Math.round(toNumber(learnerSessions?.minutes)),
    };
  });

  const modulesByVersion = new Map(moduleCountRows.map((row) => [row.versionId, toNumber(row.count)]));
  const lessonsByVersion = new Map(lessonCountRows.map((row) => [row.versionId, row]));
  const blocksByVersion = new Map(blockCountRows.map((row) => [row.versionId, toNumber(row.count)]));
  const activitiesByVersion = new Map(
    activityCountRows.map((row) => [row.versionId, toNumber(row.count)]),
  );
  const publications = publicationRows.map((row) => {
    const lessonCounts = lessonsByVersion.get(row.id);
    const lessons = toNumber(lessonCounts?.count);
    const publishableLessons = toNumber(lessonCounts?.publishable);
    return {
      courseSlug: row.courseSlug,
      title: row.title,
      version: row.version,
      stage: row.stage,
      modules: modulesByVersion.get(row.id) ?? 0,
      lessons,
      publishableLessons,
      blocks: blocksByVersion.get(row.id) ?? 0,
      activities: activitiesByVersion.get(row.id) ?? 0,
      coveragePercent: percentage(publishableLessons, lessons),
      publishedAt: toIso(row.publishedAt),
      updatedAt: toIso(row.updatedAt)!,
    };
  });

  const authoredCourses = contentSnapshot.courses;
  const authoredSkills = authoredCourses.flatMap((authoredCourse) =>
    authoredCourse.modules.flatMap((courseSection) => courseSection.skills),
  );
  const authoredStatusMap = new Map<string, number>();
  for (const authoredCourse of authoredCourses) {
    authoredStatusMap.set(
      authoredCourse.status,
      (authoredStatusMap.get(authoredCourse.status) ?? 0) + 1,
    );
  }
  const authoredStatuses = [...authoredStatusMap]
    .map(([status, count]) => ({ status, count }))
    .sort((left, right) => left.status.localeCompare(right.status));

  const globalMastery = globalMasteryRows[0];
  const globalAttempts = globalAttemptRows[0];
  const globalSessions = globalSessionRows[0];
  const globalChats = globalChatRows[0];
  const storage = storageRows[0];
  const quotaBytes = storageQuotaBytes();
  const usedBytes = toNumber(storage?.bytes);
  const latestBackup = backupRows[0];
  const backupReference = latestBackup?.completedAt ?? latestBackup?.createdAt;
  const backupAgeSeconds = backupReference
    ? Math.max(0, Math.floor((now.getTime() - backupReference.getTime()) / 1_000))
    : null;
  const activeLast7Days = learnerRows.filter(
    (row) => row.lastMeaningfulActivityAt && row.lastMeaningfulActivityAt >= weekAgo,
  ).length;

  return {
    generatedAt: now.toISOString(),
    summary: {
      learners: learners.length,
      activeLearners: learnerRows.filter((row) => row.status === "active").length,
      activeLast7Days,
      pendingAccessRequests: toNumber(accessSummaryRows[0]?.count),
      openAppeals: toNumber(appealSummaryRows[0]?.count),
      runnerBacklog: toNumber(runnerSummaryRows[0]?.count),
    },
    learners,
    learning: {
      masteryRecords: toNumber(globalMastery?.total),
      averageMastery: Math.round(toNumber(globalMastery?.average) * 1_000) / 10,
      masteredSkills: toNumber(globalMastery?.mastered),
      reviewDue: toNumber(globalMastery?.reviewDue),
      attempts: toNumber(globalAttempts?.total),
      passedAttempts: toNumber(globalAttempts?.passed),
      passRate: percentage(toNumber(globalAttempts?.passed), toNumber(globalAttempts?.total)),
      activeSessions: toNumber(globalSessions?.active),
      sessionMinutes: Math.round(toNumber(globalSessions?.minutes)),
      chatThreads: toNumber(globalChats?.threads),
      chatMessages: toNumber(globalChats?.messages),
      projects: toNumber(globalProjectRows[0]?.count),
    },
    providers: {
      credentials: credentialRows.map(safeCredential),
      credentialStatusCounts: statusCounts(credentialStatusRows),
      policies: policyRows,
    },
    content: {
      authored: {
        courses: authoredCourses.length,
        modules: authoredCourses.reduce((total, authoredCourse) => total + authoredCourse.modules.length, 0),
        skills: authoredSkills.length,
        covered: authoredSkills.filter((skill) => skill.coverage_status === "covered").length,
        partial: authoredSkills.filter((skill) => skill.coverage_status === "partial").length,
        planned: authoredSkills.filter((skill) => skill.coverage_status === "planned").length,
        statuses: authoredStatuses,
      },
      publications,
    },
    operations: {
      runner: {
        statuses: statusCounts(runnerStatusRows),
        oldestQueuedAt: toIso(runnerOldestRows[0]?.queuedAt),
        recentFailures: runnerFailureRows.map((row) => ({
          id: row.id,
          status: row.status,
          queuedAt: toIso(row.queuedAt)!,
          completedAt: toIso(row.completedAt),
        })),
      },
      backgroundJobs: {
        statuses: statusCounts(backgroundStatusRows),
        recentFailures: backgroundFailureRows.map((row) => ({
          id: row.id,
          type: safeOperationalCode(row.type) ?? "unknown",
          status: row.status,
          errorCode: safeOperationalCode(row.errorCode),
          createdAt: toIso(row.createdAt)!,
        })),
      },
      storage: {
        objects: toNumber(storage?.objects),
        bytes: usedBytes,
        pendingScans: toNumber(storage?.pendingScans),
        quotaBytes,
        quotaPercent: quotaBytes ? percentage(usedBytes, quotaBytes) : null,
        ledgerBytes30Days: toNumber(ledgerRows[0]?.bytes),
      },
      email: {
        statuses: statusCounts(emailStatusRows),
        oldestPendingAt: toIso(emailOldestRows[0]?.createdAt),
        recentFailures: emailFailureRows.map((row) => ({
          id: row.id,
          template: safeOperationalCode(row.template) ?? "unknown",
          errorCode: safeOperationalCode(row.errorCode),
          attemptCount: row.attemptCount,
          updatedAt: toIso(row.updatedAt)!,
        })),
      },
      backup: latestBackup
        ? {
            recorded: true,
            status: latestBackup.status,
            type: safeOperationalCode(latestBackup.type),
            createdAt: toIso(latestBackup.createdAt),
            completedAt: toIso(latestBackup.completedAt),
            ageSeconds: backupAgeSeconds,
            errorCode: safeOperationalCode(latestBackup.errorCode),
          }
        : {
            recorded: false,
            status: "not_recorded",
            type: null,
            createdAt: null,
            completedAt: null,
            ageSeconds: null,
            errorCode: null,
          },
    },
    appeals: appealRows.map((row) => ({
      id: row.id,
      learnerPublicId: row.learnerPublicId,
      learnerName: row.learnerName,
      target: row.attemptId ? "attempt" : row.projectReviewId ? "project_review" : "unspecified",
      status: row.status,
      createdAt: toIso(row.createdAt)!,
      decidedAt: toIso(row.decidedAt),
    })),
    audit: auditRows.map((row) => ({
      id: row.id,
      actorName: row.actorName ?? "System",
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      outcome: row.outcome,
      occurredAt: toIso(row.occurredAt)!,
    })),
  };
}

export async function getLearnerDetailData(
  learnerPublicId: string,
  now = new Date(),
): Promise<LearnerDetailData | undefined> {
  const [learner] = await db
    .select({
      internalId: user.id,
      publicId: user.publicId,
      name: user.name,
      email: user.email,
      status: user.status,
      emailVerified: user.emailVerified,
      mfaEnabled: user.twoFactorEnabled,
      level: learnerProfile.selfReportedLevel,
      preferredSessionMinutes: learnerProfile.preferredSessionMinutes,
      weeklyGoalMinutes: learnerProfile.weeklyGoalMinutes,
      selectedTracks: learnerProfile.selectedTracks,
      learningGoals: learnerProfile.learningGoals,
      storageQuotaBytes: learnerProfile.storageQuotaBytes,
      profileRowVersion: learnerProfile.rowVersion,
      onboardingCompletedAt: learnerProfile.onboardingCompletedAt,
      lastMeaningfulActivityAt: user.lastMeaningfulActivityAt,
      createdAt: user.createdAt,
    })
    .from(user)
    .leftJoin(learnerProfile, eq(learnerProfile.userId, user.id))
    .where(and(eq(user.publicId, learnerPublicId), eq(user.role, "learner")))
    .limit(1);
  if (!learner) return undefined;

  const [
    enrollmentRows,
    masterySummaryRows,
    masteryStatusRows,
    recentMasteryRows,
    attemptSummaryRows,
    attemptStatusRows,
    recentAttemptRows,
    sessionSummaryRows,
    recentSessionRows,
    chatSummaryRows,
    recentChatRows,
    projectSummaryRows,
    recentProjectRows,
    credentialRows,
    authSessionRows,
    storageRows,
    emailStatusRows,
    appealRows,
  ] = await Promise.all([
    db
      .select({
        id: enrollment.id,
        course: course.title,
        version: courseVersion.version,
        status: enrollment.status,
        implementationLanguage: enrollment.implementationLanguage,
        startedAt: enrollment.startedAt,
        completedAt: enrollment.completedAt,
      })
      .from(enrollment)
      .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
      .innerJoin(course, eq(course.id, courseVersion.courseId))
      .where(eq(enrollment.userId, learner.internalId))
      .orderBy(desc(enrollment.updatedAt)),
    db
      .select({
        total: sql<number>`count(*)::int`,
        averageScore: sql<number>`coalesce(avg(${conceptMastery.score}), 0)::float8`,
        averageConfidence: sql<number>`coalesce(avg(${conceptMastery.confidence}), 0)::float8`,
        reviewDue: sql<number>`count(*) filter (where ${conceptMastery.nextReviewAt} <= ${now})::int`,
      })
      .from(conceptMastery)
      .where(eq(conceptMastery.userId, learner.internalId)),
    db
      .select({ status: conceptMastery.status, count: sql<number>`count(*)::int` })
      .from(conceptMastery)
      .where(eq(conceptMastery.userId, learner.internalId))
      .groupBy(conceptMastery.status),
    db
      .select({
        concept: concept.title,
        languageContext: conceptMastery.languageContext,
        status: conceptMastery.status,
        score: conceptMastery.score,
        confidence: conceptMastery.confidence,
        lastEvidenceAt: conceptMastery.lastEvidenceAt,
        nextReviewAt: conceptMastery.nextReviewAt,
      })
      .from(conceptMastery)
      .innerJoin(concept, eq(concept.id, conceptMastery.conceptId))
      .where(eq(conceptMastery.userId, learner.internalId))
      .orderBy(desc(conceptMastery.updatedAt))
      .limit(18),
    db
      .select({
        total: sql<number>`count(*)::int`,
        passed: sql<number>`count(*) filter (where ${effectiveAttemptPassed} = true)::int`,
        averageScore: sql<number>`coalesce(avg(${effectiveAttemptScore}), 0)::float8`,
      })
      .from(attempt)
      .leftJoin(
        assessmentAttemptEffectiveResult,
        eq(assessmentAttemptEffectiveResult.attemptId, attempt.id),
      )
      .where(eq(attempt.userId, learner.internalId)),
    db
      .select({ status: attempt.status, count: sql<number>`count(*)::int` })
      .from(attempt)
      .where(eq(attempt.userId, learner.internalId))
      .groupBy(attempt.status),
    db
      .select({
        id: attempt.id,
        kind: attempt.kind,
        status: attempt.status,
        score: effectiveAttemptScore,
        passed: effectiveAttemptPassed,
        masteryAwarded: effectiveAttemptMastery,
        infrastructureFailure: effectiveAttemptInfrastructureFailure,
        correctedAt: assessmentAttemptEffectiveResult.updatedAt,
        createdAt: attempt.createdAt,
      })
      .from(attempt)
      .leftJoin(
        assessmentAttemptEffectiveResult,
        eq(assessmentAttemptEffectiveResult.attemptId, attempt.id),
      )
      .where(eq(attempt.userId, learner.internalId))
      .orderBy(desc(attempt.createdAt))
      .limit(18),
    db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${learningSession.status} = 'active')::int`,
        plannedMinutes: sql<number>`coalesce(sum(${learningSession.plannedMinutes}), 0)::int`,
        completedMinutes: sql<number>`coalesce(sum(extract(epoch from (${learningSession.endedAt} - ${learningSession.startedAt})) / 60) filter (where ${learningSession.endedAt} is not null), 0)::float8`,
      })
      .from(learningSession)
      .where(eq(learningSession.userId, learner.internalId)),
    db
      .select({
        id: learningSession.id,
        goal: learningSession.goal,
        status: learningSession.status,
        plannedMinutes: learningSession.plannedMinutes,
        startedAt: learningSession.startedAt,
        lastActivityAt: learningSession.lastActivityAt,
        endedAt: learningSession.endedAt,
      })
      .from(learningSession)
      .where(eq(learningSession.userId, learner.internalId))
      .orderBy(desc(learningSession.startedAt))
      .limit(12),
    db
      .select({
        threads: sql<number>`count(distinct ${chatThread.id})::int`,
        messages: sql<number>`count(${chatMessage.id})::int`,
      })
      .from(chatThread)
      .leftJoin(chatMessage, eq(chatMessage.threadId, chatThread.id))
      .where(eq(chatThread.userId, learner.internalId)),
    db
      .select({
        id: chatThread.id,
        status: chatThread.status,
        messages: sql<number>`count(${chatMessage.id})::int`,
        updatedAt: chatThread.updatedAt,
      })
      .from(chatThread)
      .leftJoin(chatMessage, eq(chatMessage.threadId, chatThread.id))
      .where(eq(chatThread.userId, learner.internalId))
      .groupBy(chatThread.id)
      .orderBy(desc(chatThread.updatedAt))
      .limit(12),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(project)
      .where(eq(project.userId, learner.internalId)),
    db
      .select({
        id: project.id,
        title: project.title,
        status: project.status,
        visibility: project.visibility,
        reviews: sql<number>`count(${projectReview.id})::int`,
        updatedAt: project.updatedAt,
      })
      .from(project)
      .leftJoin(projectReview, eq(projectReview.projectId, project.id))
      .where(eq(project.userId, learner.internalId))
      .groupBy(project.id)
      .orderBy(desc(project.updatedAt))
      .limit(12),
    db
      .select({
        id: providerCredential.id,
        ownerPublicId: user.publicId,
        ownerName: user.name,
        provider: providerCredential.provider,
        lastFour: providerCredential.lastFour,
        status: providerCredential.status,
        preferred: providerCredential.isPreferred,
        lastValidatedAt: providerCredential.lastValidatedAt,
        lastUsedAt: providerCredential.lastUsedAt,
        failureCode: providerCredential.failureCode,
      })
      .from(providerCredential)
      .innerJoin(user, eq(user.id, providerCredential.userId))
      .where(eq(providerCredential.userId, learner.internalId))
      .orderBy(asc(providerCredential.provider)),
    db
      .select({
        active: sql<number>`count(*)::int`,
        lastSeenAt: sql<Date | null>`max(${session.lastSeenAt})`,
      })
      .from(session)
      .where(
        and(
          eq(session.userId, learner.internalId),
          isNull(session.revokedAt),
          gt(session.expiresAt, now),
        ),
      ),
    db
      .select({
        objects: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${storedObject.sizeBytes}), 0)::float8`,
        pendingScans: sql<number>`count(*) filter (where ${storedObject.scanStatus} in ('pending', 'scanning', 'scanner_error'))::int`,
      })
      .from(storedObject)
      .where(and(eq(storedObject.ownerUserId, learner.internalId), isNull(storedObject.deletedAt))),
    db
      .select({ status: emailOutbox.status, count: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(eq(emailOutbox.userId, learner.internalId))
      .groupBy(emailOutbox.status),
    db
      .select({
        id: appeal.id,
        attemptId: appeal.attemptId,
        projectReviewId: appeal.projectReviewId,
        status: appeal.status,
        createdAt: appeal.createdAt,
        decidedAt: appeal.decidedAt,
      })
      .from(appeal)
      .where(eq(appeal.userId, learner.internalId))
      .orderBy(desc(appeal.createdAt))
      .limit(12),
  ]);

  const masterySummary = masterySummaryRows[0];
  const attemptSummary = attemptSummaryRows[0];
  const sessionSummary = sessionSummaryRows[0];
  const chatSummary = chatSummaryRows[0];
  const authSessions = authSessionRows[0];
  const storage = storageRows[0];
  const quotaBytes = learner.storageQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES;
  const storageBytes = toNumber(storage?.bytes);

  return {
    generatedAt: now.toISOString(),
    learner: {
      publicId: learner.publicId,
      name: learner.name,
      email: learner.email,
      status: learner.status,
      emailVerified: learner.emailVerified,
      mfaEnabled: Boolean(learner.mfaEnabled),
      level: learner.level ?? "not set",
      preferredSessionMinutes: learner.preferredSessionMinutes,
      weeklyGoalMinutes: learner.weeklyGoalMinutes,
      selectedTracks: learner.selectedTracks ?? [],
      learningGoals: learner.learningGoals ?? [],
      onboardingCompletedAt: toIso(learner.onboardingCompletedAt),
      lastMeaningfulActivityAt: toIso(learner.lastMeaningfulActivityAt),
      createdAt: toIso(learner.createdAt)!,
    },
    enrollments: enrollmentRows.map((row) => ({
      ...row,
      startedAt: toIso(row.startedAt),
      completedAt: toIso(row.completedAt),
    })),
    mastery: {
      total: toNumber(masterySummary?.total),
      averageScore: Math.round(toNumber(masterySummary?.averageScore) * 1_000) / 10,
      averageConfidence: Math.round(toNumber(masterySummary?.averageConfidence) * 1_000) / 10,
      reviewDue: toNumber(masterySummary?.reviewDue),
      statuses: statusCounts(masteryStatusRows),
      recent: recentMasteryRows.map((row) => ({
        concept: row.concept,
        languageContext: row.languageContext,
        status: row.status,
        score: Math.round(row.score * 1_000) / 10,
        confidence: Math.round(row.confidence * 1_000) / 10,
        lastEvidenceAt: toIso(row.lastEvidenceAt),
        nextReviewAt: toIso(row.nextReviewAt),
      })),
    },
    attempts: {
      total: toNumber(attemptSummary?.total),
      passed: toNumber(attemptSummary?.passed),
      passRate: percentage(toNumber(attemptSummary?.passed), toNumber(attemptSummary?.total)),
      averageScore: Math.round(toNumber(attemptSummary?.averageScore) * 10) / 10,
      statuses: statusCounts(attemptStatusRows),
      recent: recentAttemptRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        score: row.score,
        passed: row.passed,
        masteryAwarded: Boolean(row.masteryAwarded),
        infrastructureFailure: row.infrastructureFailure,
        corrected: row.correctedAt !== null,
        createdAt: toIso(row.createdAt)!,
      })),
    },
    sessions: {
      total: toNumber(sessionSummary?.total),
      active: toNumber(sessionSummary?.active),
      plannedMinutes: toNumber(sessionSummary?.plannedMinutes),
      completedMinutes: Math.round(toNumber(sessionSummary?.completedMinutes)),
      recent: recentSessionRows.map((row) => ({
        id: row.id,
        goal: row.goal,
        status: row.status,
        plannedMinutes: row.plannedMinutes,
        startedAt: toIso(row.startedAt)!,
        lastActivityAt: toIso(row.lastActivityAt)!,
        endedAt: toIso(row.endedAt),
      })),
    },
    chats: {
      threads: toNumber(chatSummary?.threads),
      messages: toNumber(chatSummary?.messages),
      recent: recentChatRows.map((row) => ({
        id: row.id,
        status: row.status,
        messages: toNumber(row.messages),
        updatedAt: toIso(row.updatedAt)!,
      })),
    },
    projects: {
      total: toNumber(projectSummaryRows[0]?.count),
      recent: recentProjectRows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        visibility: row.visibility,
        reviews: toNumber(row.reviews),
        updatedAt: toIso(row.updatedAt)!,
      })),
    },
    credentials: credentialRows.map(safeCredential),
    operations: {
      activeAuthSessions: toNumber(authSessions?.active),
      lastSessionSeenAt: toIso(authSessions?.lastSeenAt),
      storageObjects: toNumber(storage?.objects),
      storageBytes,
      pendingScans: toNumber(storage?.pendingScans),
      quotaBytes,
      quotaPercent: quotaBytes ? percentage(storageBytes, quotaBytes) : null,
      quotaRowVersion: learner.profileRowVersion ?? 0,
      emailStatuses: statusCounts(emailStatusRows),
    },
    appeals: appealRows.map((row) => ({
      id: row.id,
      target: row.attemptId ? "attempt" : row.projectReviewId ? "project_review" : "unspecified",
      status: row.status,
      createdAt: toIso(row.createdAt)!,
      decidedAt: toIso(row.decidedAt),
    })),
  };
}
