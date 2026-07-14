import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";

import { createContentRepository } from "@/lib/content";
import { db } from "@/lib/db/client";
import {
  attempt,
  concept,
  conceptMastery,
  course,
  courseVersion,
  curriculumPublicationPointer,
  enrollment,
  learnerProfile,
  lesson,
  planRevision,
  reviewSchedule,
  sessionEvent,
  user,
} from "@/lib/db/schema";
import { LESSON_COMPLETION_AUTHORITY } from "@/lib/learning-service/types";
import { learningService } from "@/lib/learning-service/runtime";
import { loadRewardProgress } from "@/lib/rewards/service";

const OFFICIAL_ACTIVITY_TYPES = new Set(["lesson_completed", "attempt_submitted"]);
const DASHBOARD_TOPIC_LIMIT = 4;

const NEEDS_REVIEW_REASON = "Mastery status requires review.";
const PRACTICE_FALLBACK_REASON = "Evidence has not reached proficiency yet.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DashboardFailureScope = "authoritative-load" | "next-recommendation" | "reward-projection";

/**
 * Emit an operator-visible failure without logging exception messages, query
 * values, learner identifiers, or provider data. Error messages can contain
 * sensitive database/provider context, so only a bounded error class is used.
 */
export function reportDashboardFailure(scope: DashboardFailureScope, error: unknown) {
  const candidate = error instanceof Error ? error.name : typeof error;
  const kind = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(candidate) ? candidate : "UnknownError";
  console.error(`[dashboard] ${scope} failed (${kind}).`);
}

export type RoadmapState =
  | "ready"
  | "no_tracks"
  | "awaiting_publication"
  | "initialization_required"
  | "unavailable";

export type DashboardEnrollmentStatus = "planned" | "active" | "paused" | "completed";
export type DashboardCourseProgressState = "verified" | "manifest_unavailable";

export interface DashboardEnrollmentCandidate {
  readonly enrollmentId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly contentVersion: string;
  readonly stage: string;
  readonly status: DashboardEnrollmentStatus;
  readonly startedAt: Date | null;
  readonly createdAt: Date;
}

export interface RoadmapStateProjection {
  readonly state: RoadmapState;
  readonly selectedTrackIds: readonly string[];
  readonly unavailableTrackIds: readonly string[];
}

export interface SelectedTrackPreview {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly moduleCount: number;
  readonly skillCount: number;
  readonly publicationReady: boolean;
  readonly href: string | null;
}

export interface RoadmapProjection extends RoadmapStateProjection {
  readonly selectedTrackPreviews: readonly SelectedTrackPreview[];
}

export function deriveRoadmapProjection(input: {
  readonly selectedTrackIds: readonly string[];
  readonly publishedTrackIds: readonly string[];
  readonly enrollmentCount: number;
}): RoadmapStateProjection {
  const selectedTrackIds = [...new Set(input.selectedTrackIds)];
  const publishedTrackIds = new Set(input.publishedTrackIds);
  const unavailableTrackIds = selectedTrackIds.filter((trackId) => !publishedTrackIds.has(trackId));

  if (input.enrollmentCount > 0) {
    return { state: "ready", selectedTrackIds, unavailableTrackIds };
  }
  if (!selectedTrackIds.length) {
    return { state: "no_tracks", selectedTrackIds, unavailableTrackIds };
  }
  if (unavailableTrackIds.length === selectedTrackIds.length) {
    return { state: "awaiting_publication", selectedTrackIds, unavailableTrackIds };
  }
  return { state: "initialization_required", selectedTrackIds, unavailableTrackIds };
}

export function deriveSelectedTrackPreviews(input: {
  readonly selectedTrackIds: readonly string[];
  readonly manifests: readonly {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly version: string;
    readonly moduleCount: number;
    readonly skillCount: number;
  }[];
  readonly publications: readonly {
    readonly trackId: string;
    readonly version: string;
  }[];
}): readonly SelectedTrackPreview[] {
  const manifestById = new Map(input.manifests.map((manifest) => [manifest.id, manifest]));
  const publicationVersionByTrack = new Map(
    input.publications.map((publication) => [publication.trackId, publication.version]),
  );

  return [...new Set(input.selectedTrackIds)].map((trackId) => {
    const manifest = manifestById.get(trackId);
    if (!manifest) {
      return {
        id: trackId,
        title: trackId,
        summary: "Course details are unavailable because its content manifest could not be loaded.",
        moduleCount: 0,
        skillCount: 0,
        publicationReady: false,
        href: null,
      };
    }
    return {
      id: manifest.id,
      title: manifest.title,
      summary: manifest.summary,
      moduleCount: manifest.moduleCount,
      skillCount: manifest.skillCount,
      publicationReady: publicationVersionByTrack.get(trackId) === manifest.version,
      href: `/courses/${encodeURIComponent(manifest.id)}`,
    };
  });
}

export interface AuthoritativeDashboardData {
  readonly firstName: string;
  readonly masteryPercent: number;
  readonly averageConfidencePercent: number;
  readonly masteredSkills: number;
  readonly reviews: readonly { id: string; title: string; course: string; href: string; due: string; confidence: number; reason: string }[];
  readonly reviewsDueCount: number;
  readonly meaningfulThisWeek: number;
  readonly streak: number;
  readonly weeklyActivity: readonly number[];
  readonly completedLessons: number;
  readonly rewards: Awaited<ReturnType<typeof loadRewardProgress>> | null;
  readonly strongTopics: readonly {
    id: string;
    title: string;
    /** Rounded percentage in the inclusive range 0-100. */
    confidence: number;
  }[];
  readonly needsReviewTopics: readonly {
    id: string;
    title: string;
    /** Rounded percentage in the inclusive range 0-100. */
    confidence: number;
    reason: string;
  }[];
  readonly next: { title: string; course: string; reason: string; href: string } | null;
  readonly courses: readonly {
    enrollmentId: string;
    id: string;
    title: string;
    contentVersion: string;
    progressState: DashboardCourseProgressState;
    progress: number;
    mastered: number;
    total: number;
    stage: string;
    status: DashboardEnrollmentStatus;
    planRevision?: {
      revision: number;
      source: string;
      reason: string;
      createdAt: string;
    };
  }[];
  readonly roadmap: RoadmapProjection;
  readonly degraded: boolean;
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function resolveDashboardTimeZone(candidate: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "UTC";
  }
}

export function dashboardLocalDateKey(date: Date, timeZone: string) {
  const safeTimeZone = resolveDashboardTimeZone(timeZone);
  let formatter = dateFormatterCache.get(safeTimeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatterCache.set(safeTimeZone, formatter);
  }
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDateKey(dayKey: string, days: number) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

function activityStreak(dayKeys: ReadonlySet<string>, todayKey: string) {
  let cursor = todayKey;
  if (!dayKeys.has(cursor)) cursor = shiftDateKey(cursor, -1);
  let count = 0;
  while (dayKeys.has(cursor)) {
    count += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return count;
}

export interface DashboardActivityEvent {
  readonly type: string;
  readonly occurredAt: Date;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  /** True only for server-issued evidence, never a raw browser assertion. */
  readonly authoritative: boolean;
}

/**
 * Derives dashboard activity from the complete authoritative event history.
 * Weekly counts remain a seven-day window, while streaks intentionally use
 * every recorded meaningful day. Lesson completions are a lifetime count of
 * distinct authoritative lesson ids, so retries cannot inflate the result.
 */
export function deriveActivityProjection(
  rows: readonly DashboardActivityEvent[],
  now: Date,
  knownLessonIds: ReadonlySet<string>,
  timeZone: string,
) {
  const safeTimeZone = resolveDashboardTimeZone(timeZone);
  const todayKey = dashboardLocalDateKey(now, safeTimeZone);
  const weekKeys = Array.from({ length: 7 }, (_, index) => shiftDateKey(todayKey, index - 6));
  const weekKeySet = new Set(weekKeys);
  const meaningful = rows.filter((row) => (
    row.authoritative
    && OFFICIAL_ACTIVITY_TYPES.has(row.type)
    && Number.isFinite(row.occurredAt.getTime())
    && row.occurredAt <= now
  ));
  const dayKeys = meaningful.map((row) => dashboardLocalDateKey(row.occurredAt, safeTimeZone));
  const weeklyMeaningful = dayKeys.filter((dayKey) => weekKeySet.has(dayKey));
  const weeklyActivity = weekKeys.map((dayKey) => weeklyMeaningful.filter((item) => item === dayKey).length);
  const completedLessonIds = new Set(
    meaningful
      .filter((row) => row.type === "lesson_completed" && row.subjectType === "lesson")
      .map((row) => row.subjectId?.trim().toLowerCase() ?? "")
      .filter((subjectId) => knownLessonIds.has(subjectId)),
  );

  return {
    meaningfulThisWeek: weeklyMeaningful.length,
    streak: activityStreak(new Set(dayKeys), todayKey),
    weeklyActivity,
    completedLessons: completedLessonIds.size,
  } as const;
}

export interface DashboardMasteryTopicInput {
  readonly conceptId: string;
  readonly skillId: string;
  readonly title: string;
  readonly score: number;
  readonly confidence: number;
  readonly status: (typeof conceptMastery.$inferSelect)["status"];
  readonly lastEvidenceAt: Date | null;
}

function boundedPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function topicIdentity(row: DashboardMasteryTopicInput) {
  const id = row.skillId.trim() || row.conceptId;
  return { id, title: row.title.trim() || id };
}

/**
 * Produces conservative topic summaries from persisted mastery rows.
 * Explicit `needs_review` rows win over every other context for the same
 * concept. Evidenced learning/practicing rows fill remaining review slots;
 * `unseen` rows and unevidenced fallback rows are never presented as weak.
 */
export function deriveTopicProjections(
  rows: readonly DashboardMasteryTopicInput[],
  limit = DASHBOARD_TOPIC_LIMIT,
): Pick<AuthoritativeDashboardData, "strongTopics" | "needsReviewTopics"> {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : DASHBOARD_TOPIC_LIMIT;
  const reviewCandidates = rows
    .filter((row) => (
      row.status === "needs_review"
      || ((row.status === "learning" || row.status === "practicing") && row.lastEvidenceAt !== null)
    ))
    .map((row) => ({
      ...topicIdentity(row),
      score: row.score,
      confidence: boundedPercent(row.confidence),
      explicit: row.status === "needs_review",
      reason: row.status === "needs_review" ? NEEDS_REVIEW_REASON : PRACTICE_FALLBACK_REASON,
    }))
    .sort((left, right) => (
      Number(right.explicit) - Number(left.explicit)
      || left.confidence - right.confidence
      || left.score - right.score
      || compareText(left.title, right.title)
      || compareText(left.id, right.id)
    ));

  const reviewIds = new Set<string>();
  const needsReviewTopics: AuthoritativeDashboardData["needsReviewTopics"][number][] = [];
  for (const candidate of reviewCandidates) {
    if (reviewIds.has(candidate.id)) continue;
    reviewIds.add(candidate.id);
    if (needsReviewTopics.length < safeLimit) {
      needsReviewTopics.push({
        id: candidate.id,
        title: candidate.title,
        confidence: candidate.confidence,
        reason: candidate.reason,
      });
    }
  }

  const strongCandidates = rows
    .filter((row) => (
      (row.status === "proficient" || row.status === "mastered")
      && !reviewIds.has(topicIdentity(row).id)
    ))
    .map((row) => ({
      ...topicIdentity(row),
      score: row.score,
      confidence: boundedPercent(row.confidence),
      mastered: row.status === "mastered",
    }))
    .sort((left, right) => (
      Number(right.mastered) - Number(left.mastered)
      || right.score - left.score
      || right.confidence - left.confidence
      || compareText(left.title, right.title)
      || compareText(left.id, right.id)
    ));
  const strongIds = new Set<string>();
  const strongTopics: AuthoritativeDashboardData["strongTopics"][number][] = [];
  for (const candidate of strongCandidates) {
    if (strongIds.has(candidate.id) || strongTopics.length >= safeLimit) continue;
    strongIds.add(candidate.id);
    strongTopics.push({
      id: candidate.id,
      title: candidate.title,
      confidence: candidate.confidence,
    });
  }

  return { strongTopics, needsReviewTopics };
}

export interface DashboardDueReviewInput {
  readonly id: string;
  readonly skillId: string;
  readonly title: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly dueAt: Date;
  readonly confidence: number;
  readonly reason: string;
}

/** Counts every learner-local due review while keeping the card preview bounded. */
export function deriveReviewProjection(
  rows: readonly DashboardDueReviewInput[],
  now: Date,
  timeZone: string,
): Pick<AuthoritativeDashboardData, "reviews" | "reviewsDueCount"> {
  const todayKey = dashboardLocalDateKey(now, timeZone);
  const due = rows
    .filter((row) => (
      Number.isFinite(row.dueAt.getTime())
      && dashboardLocalDateKey(row.dueAt, timeZone) <= todayKey
    ))
    .sort((left, right) => (
      left.dueAt.getTime() - right.dueAt.getTime()
      || compareText(left.id, right.id)
    ));
  return {
    reviewsDueCount: due.length,
    reviews: due.slice(0, 6).map((row) => ({
      id: row.id,
      title: row.title,
      course: row.courseTitle,
      href: `/courses/${row.courseId}/skills/${encodeURIComponent(row.skillId)}`,
      due: row.dueAt <= now ? "Now" : "Today",
      confidence: boundedPercent(row.confidence),
      reason: row.reason,
    })),
  };
}

export function deriveCourseMasteryProgress(
  rows: readonly Pick<DashboardMasteryTopicInput, "conceptId">[],
  totalSkills: number,
) {
  const safeTotal = Number.isSafeInteger(totalSkills) && totalSkills > 0 ? totalSkills : 0;
  const distinctMastered = new Set(rows.map((row) => row.conceptId)).size;
  const mastered = Math.min(safeTotal, distinctMastered);
  return {
    mastered,
    progress: safeTotal ? Math.min(100, Math.round((mastered / safeTotal) * 100)) : 0,
  } as const;
}

const ENROLLMENT_STATUS_PRIORITY: Readonly<Record<DashboardEnrollmentStatus, number>> = {
  active: 0,
  paused: 1,
  planned: 2,
  completed: 3,
};

/**
 * Chooses the single enrollment that represents each course on learner-facing
 * dashboards. The database intentionally keeps historical/versioned
 * enrollments, so rendering every row would duplicate cards and blend
 * incompatible skill totals. A currently active path wins; ties use the most
 * recently started/created row and finally the enrollment id for stability.
 */
export function selectDashboardEnrollments(
  rows: readonly DashboardEnrollmentCandidate[],
): readonly DashboardEnrollmentCandidate[] {
  const ordered = [...rows].sort((left, right) => (
    compareText(left.courseId, right.courseId)
    || ENROLLMENT_STATUS_PRIORITY[left.status] - ENROLLMENT_STATUS_PRIORITY[right.status]
    || (right.startedAt ?? right.createdAt).getTime() - (left.startedAt ?? left.createdAt).getTime()
    || compareText(left.enrollmentId, right.enrollmentId)
  ));
  const seen = new Set<string>();
  return ordered.filter((row) => {
    if (seen.has(row.courseId)) return false;
    seen.add(row.courseId);
    return true;
  });
}

/** Never applies a current manifest's denominator to a different enrollment version. */
export function deriveVersionSafeCourseProgress(input: {
  readonly masteryRows: readonly Pick<DashboardMasteryTopicInput, "conceptId">[];
  readonly enrollmentVersion: string;
  readonly manifest: { readonly version: string; readonly totalSkills: number } | undefined;
}) {
  if (!input.manifest || input.manifest.version !== input.enrollmentVersion) {
    return {
      mastered: 0,
      progress: 0,
      total: 0,
      progressState: "manifest_unavailable" as const,
    };
  }
  const progress = deriveCourseMasteryProgress(input.masteryRows, input.manifest.totalSkills);
  return {
    ...progress,
    total: input.manifest.totalSkills,
    progressState: "verified" as const,
  };
}

export function createUnavailableDashboardData(displayName: string): AuthoritativeDashboardData {
  return {
    firstName: displayName.trim().split(/\s+/)[0] || "buddy",
    masteryPercent: 0,
    averageConfidencePercent: 0,
    masteredSkills: 0,
    reviews: [],
    reviewsDueCount: 0,
    meaningfulThisWeek: 0,
    streak: 0,
    weeklyActivity: [0, 0, 0, 0, 0, 0, 0],
    completedLessons: 0,
    rewards: null,
    strongTopics: [],
    needsReviewTopics: [],
    next: null,
    courses: [],
    roadmap: {
      state: "unavailable",
      selectedTrackIds: [],
      unavailableTrackIds: [],
      selectedTrackPreviews: [],
    },
    degraded: true,
  };
}

export async function loadAuthoritativeDashboard(
  userId: string,
  displayName: string,
  now = new Date(),
): Promise<AuthoritativeDashboardData> {
  try {
    const [owner] = await db
      .select({ timezone: user.timezone })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!owner) throw new Error("Dashboard owner is unavailable.");
    const timeZone = resolveDashboardTimeZone(owner.timezone);
    const [masteryRows, dueRows, eventRows, officialAttemptRows, enrollmentRows, profileRows, publicationRows, nextAction, rewards] = await Promise.all([
      db
        .select({
          conceptId: conceptMastery.conceptId,
          enrollmentId: conceptMastery.enrollmentId,
          score: conceptMastery.score,
          confidence: conceptMastery.confidence,
          status: conceptMastery.status,
          skillId: concept.slug,
          title: concept.title,
          lastEvidenceAt: conceptMastery.lastEvidenceAt,
        })
        .from(conceptMastery)
        .innerJoin(concept, eq(concept.id, conceptMastery.conceptId))
        .innerJoin(
          enrollment,
          and(
            eq(enrollment.id, conceptMastery.enrollmentId),
            eq(enrollment.userId, userId),
          ),
        )
        .where(eq(conceptMastery.userId, userId)),
      db
        .select({
          id: reviewSchedule.id,
          conceptId: reviewSchedule.conceptId,
          skillId: concept.slug,
          title: concept.title,
          courseId: course.slug,
          courseTitle: course.title,
          dueAt: reviewSchedule.dueAt,
          reason: reviewSchedule.reason,
          enrollmentId: reviewSchedule.enrollmentId,
        })
        .from(reviewSchedule)
        .innerJoin(concept, eq(concept.id, reviewSchedule.conceptId))
        .innerJoin(enrollment, eq(enrollment.id, reviewSchedule.enrollmentId))
        .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
        .innerJoin(course, eq(course.id, courseVersion.courseId))
        .where(and(
          eq(reviewSchedule.userId, userId),
          eq(enrollment.userId, userId),
          eq(reviewSchedule.status, "scheduled"),
        ))
        .orderBy(asc(reviewSchedule.dueAt), asc(reviewSchedule.id)),
      db
        .select({
          type: sessionEvent.type,
          occurredAt: sessionEvent.occurredAt,
          subjectType: sessionEvent.subjectType,
          subjectId: sessionEvent.subjectId,
          metadata: sessionEvent.metadata,
        })
        .from(sessionEvent)
        .where(and(
          eq(sessionEvent.userId, userId),
          eq(sessionEvent.type, "lesson_completed"),
          lte(sessionEvent.occurredAt, now),
        )),
      db
        .select({
          id: attempt.id,
          occurredAt: attempt.submittedAt,
        })
        .from(attempt)
        .innerJoin(
          enrollment,
          and(
            eq(enrollment.id, attempt.enrollmentId),
            eq(enrollment.userId, userId),
          ),
        )
        .where(and(
          eq(attempt.userId, userId),
          inArray(attempt.status, ["submitted", "grading", "graded"]),
          isNotNull(attempt.submittedAt),
          lte(attempt.submittedAt, now),
        )),
      db
        .select({
          enrollmentId: enrollment.id,
          courseId: course.slug,
          courseTitle: course.title,
          contentVersion: courseVersion.version,
          stage: courseVersion.stage,
          status: enrollment.status,
          startedAt: enrollment.startedAt,
          createdAt: enrollment.createdAt,
        })
        .from(enrollment)
        .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
        .innerJoin(course, eq(course.id, courseVersion.courseId))
        .where(and(
          eq(enrollment.userId, userId),
          inArray(enrollment.status, ["planned", "active", "paused", "completed"]),
        )),
      db
        .select({ selectedTracks: learnerProfile.selectedTracks })
        .from(learnerProfile)
        .where(eq(learnerProfile.userId, userId))
        .limit(1),
      db
        .select({ trackId: course.slug, version: courseVersion.version })
        .from(curriculumPublicationPointer)
        .innerJoin(
          courseVersion,
          eq(courseVersion.id, curriculumPublicationPointer.currentCourseVersionId),
        )
        .innerJoin(
          course,
          and(
            eq(course.id, curriculumPublicationPointer.courseId),
            eq(course.id, courseVersion.courseId),
          ),
        )
        .where(inArray(courseVersion.stage, ["beta", "verified"])),
      learningService.recommendNext(userId).catch((error) => {
        reportDashboardFailure("next-recommendation", error);
        return { state: "degraded", action: null } as const;
      }),
      loadRewardProgress(userId, now).catch((error) => {
        reportDashboardFailure("reward-projection", error);
        return null;
      }),
    ]);

    const activityRows: DashboardActivityEvent[] = [
      ...eventRows.map((row) => ({
        type: row.type,
        occurredAt: row.occurredAt,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        authoritative: row.metadata.authority === LESSON_COMPLETION_AUTHORITY,
      })),
      ...officialAttemptRows.flatMap((row) => row.occurredAt ? [{
        type: "attempt_submitted",
        occurredAt: row.occurredAt,
        subjectType: "attempt",
        subjectId: row.id,
        authoritative: true,
      }] : []),
    ];
    const completedLessonCandidates = [...new Set(activityRows
      .filter((row) => row.authoritative)
      .filter((row) => row.type === "lesson_completed" && row.subjectType === "lesson")
      .map((row) => row.subjectId?.trim().toLowerCase() ?? "")
      .filter((subjectId) => UUID_PATTERN.test(subjectId)))];
    const knownLessonRows = completedLessonCandidates.length
      ? await db
          .select({ id: lesson.id })
          .from(lesson)
          .where(inArray(lesson.id, completedLessonCandidates))
      : [];
    const activity = deriveActivityProjection(
      activityRows,
      now,
      new Set(knownLessonRows.map((row) => row.id)),
      timeZone,
    );
    const topics = deriveTopicProjections(masteryRows);
    const masteredRows = masteryRows.filter((row) => row.status === "proficient" || row.status === "mastered");
    const masteryPercent = masteryRows.length
      ? Math.round((masteryRows.reduce((sum, row) => sum + row.score, 0) / masteryRows.length) * 100)
      : 0;
    const averageConfidencePercent = masteryRows.length
      ? Math.round((masteryRows.reduce((sum, row) => sum + row.confidence, 0) / masteryRows.length) * 100)
      : 0;
    const contentRepository = createContentRepository();
    const manifests = await contentRepository.listCourses();
    const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
    const confidenceByEnrollmentConcept = new Map<string, number>();
    for (const row of masteryRows) {
      const key = `${row.enrollmentId}:${row.conceptId}`;
      const existing = confidenceByEnrollmentConcept.get(key);
      if (existing === undefined || row.confidence < existing) {
        confidenceByEnrollmentConcept.set(key, row.confidence);
      }
    }
    const reviewProjection = deriveReviewProjection(
      dueRows.map((row) => ({
        ...row,
        confidence: confidenceByEnrollmentConcept.get(`${row.enrollmentId}:${row.conceptId}`) ?? 0,
      })),
      now,
      timeZone,
    );
    const dashboardEnrollmentRows = selectDashboardEnrollments(
      enrollmentRows as readonly DashboardEnrollmentCandidate[],
    );
    const revisionRows = dashboardEnrollmentRows.length
      ? await db
          .select({
            enrollmentId: planRevision.enrollmentId,
            revision: planRevision.revision,
            source: planRevision.source,
            reason: planRevision.reason,
            createdAt: planRevision.createdAt,
          })
          .from(planRevision)
          .where(inArray(
            planRevision.enrollmentId,
            dashboardEnrollmentRows.map((row) => row.enrollmentId),
          ))
          .orderBy(desc(planRevision.revision))
      : [];
    const latestRevisionByEnrollment = new Map<
      string,
      (typeof revisionRows)[number]
    >();
    for (const revisionRow of revisionRows) {
      if (!latestRevisionByEnrollment.has(revisionRow.enrollmentId)) {
        latestRevisionByEnrollment.set(revisionRow.enrollmentId, revisionRow);
      }
    }
    const courses = dashboardEnrollmentRows.map((row) => {
      const manifest = manifestById.get(row.courseId);
      const masteryProgress = deriveVersionSafeCourseProgress({
        masteryRows: masteredRows.filter((item) => item.enrollmentId === row.enrollmentId),
        enrollmentVersion: row.contentVersion,
        manifest: manifest
          ? { version: manifest.version, totalSkills: manifest.coverage_summary.total_skills }
          : undefined,
      });
      const latestRevision = latestRevisionByEnrollment.get(row.enrollmentId);
      return {
        enrollmentId: row.enrollmentId,
        id: row.courseId,
        title: row.courseTitle,
        contentVersion: row.contentVersion,
        progressState: masteryProgress.progressState,
        progress: masteryProgress.progress,
        mastered: masteryProgress.mastered,
        total: masteryProgress.total,
        stage: row.stage,
        // The query excludes withdrawn enrollments; keep the public dashboard
        // projection narrower than the database enum.
        status: row.status as DashboardEnrollmentStatus,
        planRevision: latestRevision
          ? {
              revision: latestRevision.revision,
              source: latestRevision.source,
              reason: latestRevision.reason,
              createdAt: latestRevision.createdAt.toISOString(),
            }
          : undefined,
      };
    });
    const selectedTrackIds = profileRows[0]?.selectedTracks ?? [];
    const selectedTrackPreviews = deriveSelectedTrackPreviews({
      selectedTrackIds,
      manifests: manifests.map((manifest) => ({
        id: manifest.id,
        title: manifest.title,
        summary: manifest.summary,
        version: manifest.version,
        moduleCount: manifest.modules.length,
        skillCount: manifest.coverage_summary.total_skills,
      })),
      publications: publicationRows,
    });
    const roadmap = {
      ...deriveRoadmapProjection({
        selectedTrackIds,
        // Planning binds the database publication pointer to the exact authored
        // manifest version. A stale pointer must not advertise an actionable plan.
        publishedTrackIds: selectedTrackPreviews
          .filter((track) => track.publicationReady)
          .map((track) => track.id),
        enrollmentCount: enrollmentRows.length,
      }),
      selectedTrackPreviews,
    } satisfies RoadmapProjection;
    let next: AuthoritativeDashboardData["next"] = null;
    if (nextAction.action?.skillId) {
      const location = await contentRepository.getSkillLocation(nextAction.action.skillId);
      if (location) {
        next = {
          title: location.skill.title,
          course: location.course.title,
          reason: nextAction.action.reason,
          href: `/courses/${location.course.id}/skills/${encodeURIComponent(location.skill.id)}`,
        };
      }
    }
    return {
      firstName: displayName.trim().split(/\s+/)[0] || "buddy",
      masteryPercent,
      averageConfidencePercent,
      masteredSkills: new Set(masteredRows.map((row) => `${row.enrollmentId}:${row.conceptId}`)).size,
      reviews: reviewProjection.reviews,
      reviewsDueCount: reviewProjection.reviewsDueCount,
      meaningfulThisWeek: activity.meaningfulThisWeek,
      streak: activity.streak,
      weeklyActivity: activity.weeklyActivity,
      completedLessons: activity.completedLessons,
      rewards,
      strongTopics: topics.strongTopics,
      needsReviewTopics: topics.needsReviewTopics,
      next,
      courses,
      roadmap,
      degraded: nextAction.state === "degraded" || rewards === null,
    };
  } catch (error) {
    reportDashboardFailure("authoritative-load", error);
    return createUnavailableDashboardData(displayName);
  }
}
