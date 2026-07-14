import { isDeepStrictEqual } from "node:util";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";

import { progressFromMasteryBundle } from "./evidence-engine";
import { deterministicUuid } from "./ids";
import { toLearnerActivityForAttemptKind } from "./learner-activity";
import { reviewedAuthoredActivitySpecification } from "./publication-binding";
import { decodeReviewSchedule, reviewLanguageContext } from "./review-codec";
import type {
  AttemptCreateInput,
  AttemptGradeInput,
  DsaEnrollmentRecord,
  DsaLanguageWriteInput,
  LearningStore,
  LearningTransaction,
  MasteryWriteInput,
  PlanPersistenceInput,
  PracticeHelpWriteInput,
  ReviewWriteInput,
  SessionEventInput,
  SessionStartInput,
} from "./store";
import type {
  ActivityContext,
  AdaptiveSnapshot,
  AttemptContext,
  CoursePublication,
  LearningAttemptRecord,
  LearningPlanItem,
  LearningSessionRecord,
  MasteryBundle,
  PersistedPlan,
  PlanningProfile,
  PracticeHelpEventRecord,
  SessionEventRecord,
  StoredEvidence,
  StoredMastery,
  StoredReview,
  SubmissionInput,
} from "./types";
import {
  LEARNING_POLICY_VERSION,
  LESSON_COMPLETION_AUTHORITY,
  LearningServiceError,
} from "./types";

import { db, type Database } from "@/lib/db/client";
import {
  activity,
  codeSubmission,
  concept,
  conceptMastery,
  course,
  courseModule,
  courseVersion,
  curriculumArtifact,
  curriculumPublicationPointer,
  enrollment,
  inactivityEpisode,
  learnerProfile,
  learningSession,
  lesson,
  lessonConcept,
  masteryEvidence,
  planRevision,
  practiceHelpEvent,
  response,
  reviewSchedule,
  runnerJob,
  sessionEvent,
  attempt,
  user,
} from "@/lib/db/schema";

type DrizzleTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | DrizzleTransaction;

const MASTERY_STATUSES = [
  "unseen",
  "learning",
  "practicing",
  "proficient",
  "mastered",
  "needs_review",
] as const;

function masteryStatus(value: string): (typeof MASTERY_STATUSES)[number] {
  return MASTERY_STATUSES.includes(value as (typeof MASTERY_STATUSES)[number])
    ? value as (typeof MASTERY_STATUSES)[number]
    : "learning";
}

function mapSession(row: typeof learningSession.$inferSelect): LearningSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    enrollmentId: row.enrollmentId,
    goal: row.goal,
    plannedMinutes: row.plannedMinutes,
    reviewOnly: row.reviewOnly,
    status: row.status,
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt,
    endedAt: row.endedAt,
    rowVersion: row.rowVersion,
  };
}

function mapAttempt(row: typeof attempt.$inferSelect): LearningAttemptRecord {
  return {
    id: row.id,
    userId: row.userId,
    activityId: row.activityId!,
    enrollmentId: row.enrollmentId!,
    kind: row.kind as LearningAttemptRecord["kind"],
    attemptNumber: row.attemptNumber,
    status: row.status,
    policyVersion: row.policyVersion,
    contentVersion: row.contentVersion,
    score: row.score,
    passed: row.passed,
    masteryAwarded: Boolean(row.masteryAwarded),
    infrastructureFailure: row.infrastructureFailure,
    assistanceLevel: row.assistanceLevel as LearningAttemptRecord["assistanceLevel"],
    solutionRevealed: row.solutionRevealed,
    helpStep: row.helpStep,
    startedAt: row.startedAt,
    submittedAt: row.submittedAt,
    gradedAt: row.gradedAt,
  };
}

function mapPracticeHelpEvent(row: typeof practiceHelpEvent.$inferSelect): PracticeHelpEventRecord {
  return {
    id: row.id,
    attemptId: row.attemptId,
    userId: row.userId,
    requestId: row.requestId,
    step: row.step,
    kind: row.kind as PracticeHelpEventRecord["kind"],
    assistanceLevel: row.assistanceLevel as PracticeHelpEventRecord["assistanceLevel"],
    solutionRevealed: row.solutionRevealed,
    createdAt: row.createdAt,
  };
}

function isPlanItem(value: unknown): value is LearningPlanItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" &&
    typeof candidate.skillId === "string" &&
    typeof candidate.trackId === "string" &&
    typeof candidate.languageContext === "string" &&
    (candidate.kind === "diagnostic" || candidate.kind === "learn" || candidate.kind === "syntax_retest")
  );
}

function planItems(value: unknown): readonly LearningPlanItem[] {
  return Array.isArray(value) ? value.filter(isPlanItem) : [];
}

function sameDsaLanguage(left: string | null, right: string | null): boolean {
  const normalize = (value: string | null) => {
    const candidate = value?.trim().toLocaleLowerCase("en-US");
    if (candidate === "c") return "C";
    if (candidate === "c++" || candidate === "cpp") return "C++";
    if (candidate === "java") return "Java";
    if (candidate === "python" || candidate === "py") return "Python";
    return value?.trim() ?? null;
  };
  return normalize(left) === normalize(right);
}

function mapEvidence(
  row: typeof masteryEvidence.$inferSelect & { skillId: string },
): StoredEvidence {
  return {
    id: row.id,
    skillId: row.skillId,
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
  };
}

function mapMastery(
  row: typeof conceptMastery.$inferSelect & { skillId: string },
): StoredMastery {
  return {
    userId: row.userId,
    enrollmentId: row.enrollmentId,
    conceptId: row.conceptId,
    skillId: row.skillId,
    languageContext: row.languageContext,
    score: row.score,
    confidence: row.confidence,
    status: row.status,
    criticalRequirementsMet: row.criticalRequirementsMet,
    lastEvidenceAt: row.lastEvidenceAt,
    lastPracticedAt: row.lastPracticedAt,
    nextReviewAt: row.nextReviewAt,
    rowVersion: row.rowVersion,
  };
}

function mapReview(
  row: typeof reviewSchedule.$inferSelect & { skillId: string },
  languageContext = "conceptual",
): StoredReview {
  return {
    id: row.id,
    userId: row.userId,
    enrollmentId: row.enrollmentId,
    conceptId: row.conceptId,
    skillId: row.skillId,
    languageContext,
    dueAt: row.dueAt,
    intervalDays: row.intervalDays,
    reason: row.reason,
    status: row.status,
  };
}

export class DrizzleLearningStore implements LearningStore {
  async transaction<T>(work: (transaction: LearningTransaction) => Promise<T>): Promise<T> {
    return db.transaction((transaction) => work(new DrizzleLearningTransaction(transaction)));
  }
}

class DrizzleLearningTransaction implements LearningTransaction {
  constructor(private readonly executor: Executor) {}

  private async lock(scope: string, key: string): Promise<void> {
    // Transaction-scoped advisory locks close PostgreSQL READ COMMITTED
    // check-then-insert windows without adding durable lock rows. A hash
    // collision can only serialize unrelated work; it cannot weaken safety.
    await this.executor.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${scope}:${key}`}, 0))`,
    );
  }

  async lockPlanInitialization(userId: string): Promise<void> {
    await this.lock("learning-plan", userId);
  }

  async getPlanningProfile(userId: string): Promise<PlanningProfile | null> {
    const [row] = await this.executor
      .select({
        selectedTrackIds: learnerProfile.selectedTracks,
        dsaLanguage: learnerProfile.dsaLanguage,
        selfReportedLevel: learnerProfile.selfReportedLevel,
      })
      .from(learnerProfile)
      .where(eq(learnerProfile.userId, userId))
      .limit(1);
    return row ? row : null;
  }

  async getCoursePublications(trackIds: readonly string[]): Promise<readonly CoursePublication[]> {
    if (!trackIds.length) return [];
    return this.executor
      .select({
        trackId: course.slug,
        courseVersionId: courseVersion.id,
        version: courseVersion.version,
        stage: courseVersion.stage,
      })
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
      .where(inArray(course.slug, [...trackIds]));
  }

  async persistPlan(input: PlanPersistenceInput): Promise<PersistedPlan> {
    // persistPlan can also be called directly by maintenance jobs, so retain
    // the lock here in addition to the service's pre-read lock.
    await this.lockPlanInitialization(input.userId);
    let [ownedEnrollment] = await this.executor
      .select({ id: enrollment.id })
      .from(enrollment)
      .where(
        and(
          eq(enrollment.userId, input.userId),
          eq(enrollment.courseVersionId, input.publication.courseVersionId),
        ),
      )
      .orderBy(desc(enrollment.updatedAt))
      .limit(1);
    if (!ownedEnrollment) {
      const enrollmentId = deterministicUuid(
        "enrollment",
        `${input.userId}:${input.publication.courseVersionId}`,
      );
      [ownedEnrollment] = await this.executor
        .insert(enrollment)
        .values({
          id: enrollmentId,
          userId: input.userId,
          courseVersionId: input.publication.courseVersionId,
          implementationLanguage: input.draft.implementationLanguage,
          status: input.draft.prerequisiteTrackIds.length ? "planned" : "active",
          source: "adaptive_plan",
        })
        .onConflictDoNothing({ target: enrollment.id })
        .returning({ id: enrollment.id });
      if (!ownedEnrollment) {
        [ownedEnrollment] = await this.executor
          .select({ id: enrollment.id })
          .from(enrollment)
          .where(and(
            eq(enrollment.id, enrollmentId),
            eq(enrollment.userId, input.userId),
            eq(enrollment.courseVersionId, input.publication.courseVersionId),
          ))
          .limit(1);
      }
      if (!ownedEnrollment) {
        throw new LearningServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The deterministic enrollment id is already bound to different parameters.",
          409,
        );
      }
    }
    const revisionId = deterministicUuid(
      "plan-revision",
      `${input.userId}:${ownedEnrollment.id}:${input.idempotencyKey}`,
    );
    const [existing] = await this.executor
      .select({
        id: planRevision.id,
        revision: planRevision.revision,
        plan: planRevision.plan,
        source: planRevision.source,
        policyVersion: planRevision.policyVersion,
        createdBy: planRevision.createdBy,
      })
      .from(planRevision)
      .where(and(eq(planRevision.id, revisionId), eq(planRevision.enrollmentId, ownedEnrollment.id)))
      .limit(1);
    if (existing) {
      const expectedPlan = input.draft.items.map((item) => ({ ...item }));
      if (
        existing.source !== "adaptive_initializer"
        || existing.policyVersion !== LEARNING_POLICY_VERSION
        || existing.createdBy !== input.userId
        || !isDeepStrictEqual(existing.plan, expectedPlan)
      ) {
        throw new LearningServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The plan idempotency key was reused for different parameters.",
          409,
        );
      }
      return {
        enrollmentId: ownedEnrollment.id,
        trackId: input.draft.trackId,
        revisionId: existing.id,
        revision: existing.revision,
        idempotent: true,
      };
    }
    const [latest] = await this.executor
      .select({ id: planRevision.id, revision: planRevision.revision })
      .from(planRevision)
      .where(eq(planRevision.enrollmentId, ownedEnrollment.id))
      .orderBy(desc(planRevision.revision))
      .limit(1);
    const revision = (latest?.revision ?? 0) + 1;
    const inserted = await this.executor.insert(planRevision).values({
      id: revisionId,
      enrollmentId: ownedEnrollment.id,
      revision,
      parentId: latest?.id,
      source: "adaptive_initializer",
      reason: "Selected-track plan; diagnostics required; self-report excluded from evidence.",
      policyVersion: LEARNING_POLICY_VERSION,
      createdBy: input.userId,
      plan: input.draft.items.map((item) => ({ ...item })),
    }).onConflictDoNothing().returning({ id: planRevision.id });
    if (!inserted.length) {
      const [replay] = await this.executor
        .select({ id: planRevision.id })
        .from(planRevision)
        .where(and(eq(planRevision.id, revisionId), eq(planRevision.enrollmentId, ownedEnrollment.id)))
        .limit(1);
      if (replay) {
        // Re-read through the normal replay path so parameter mismatches are
        // never silently accepted.
        return this.persistPlan(input);
      }
      throw new LearningServiceError(
        "VERSION_CONFLICT",
        "The learning plan changed in another request. Reload and retry.",
        409,
      );
    }
    return {
      enrollmentId: ownedEnrollment.id,
      trackId: input.draft.trackId,
      revisionId,
      revision,
      idempotent: false,
    };
  }

  async lockSessionStart(userId: string): Promise<void> {
    await this.lock("learning-session-start", userId);
  }

  async getActiveSession(userId: string): Promise<LearningSessionRecord | null> {
    const [row] = await this.executor
      .select()
      .from(learningSession)
      .where(and(eq(learningSession.userId, userId), eq(learningSession.status, "active"), isNull(learningSession.endedAt)))
      .orderBy(desc(learningSession.lastActivityAt))
      .limit(1);
    return row ? mapSession(row) : null;
  }

  async getSession(userId: string, sessionId: string): Promise<LearningSessionRecord | null> {
    const [row] = await this.executor
      .select()
      .from(learningSession)
      .where(and(eq(learningSession.id, sessionId), eq(learningSession.userId, userId)))
      .limit(1);
    return row ? mapSession(row) : null;
  }

  async insertSession(input: SessionStartInput): Promise<LearningSessionRecord> {
    if (input.enrollmentId) {
      const [owned] = await this.executor
        .select({ id: enrollment.id })
        .from(enrollment)
        .where(and(eq(enrollment.id, input.enrollmentId), eq(enrollment.userId, input.userId)))
        .limit(1);
      if (!owned) throw new Error("Enrollment ownership check failed.");
    }
    let [row] = await this.executor
      .insert(learningSession)
      .values({
        id: input.id,
        userId: input.userId,
        enrollmentId: input.enrollmentId,
        goal: input.goal,
        plannedMinutes: input.plannedMinutes,
        reviewOnly: input.reviewOnly,
        status: "active",
        startedAt: input.now,
        lastActivityAt: input.now,
        rowVersion: 1,
      })
      .onConflictDoNothing({ target: learningSession.id })
      .returning();
    if (!row) {
      [row] = await this.executor
        .select()
        .from(learningSession)
        .where(and(eq(learningSession.id, input.id), eq(learningSession.userId, input.userId)))
        .limit(1);
    }
    if (!row) {
      throw new LearningServiceError(
        "IDEMPOTENCY_CONFLICT",
        "The deterministic session id is already bound to another learner.",
        409,
      );
    }
    if (
      row.enrollmentId !== input.enrollmentId
      || row.goal !== input.goal
      || row.plannedMinutes !== input.plannedMinutes
      || row.reviewOnly !== input.reviewOnly
    ) {
      throw new LearningServiceError(
        "IDEMPOTENCY_CONFLICT",
        "The session idempotency key was reused for different parameters.",
        409,
      );
    }
    return mapSession(row);
  }

  async updateSession(
    userId: string,
    sessionId: string,
    expectedRowVersion: number,
    update: { readonly status: string; readonly lastActivityAt: Date; readonly endedAt?: Date | null },
  ): Promise<LearningSessionRecord | null> {
    const [row] = await this.executor
      .update(learningSession)
      .set({
        status: update.status,
        lastActivityAt: update.lastActivityAt,
        ...(Object.prototype.hasOwnProperty.call(update, "endedAt") ? { endedAt: update.endedAt } : {}),
        rowVersion: sql`${learningSession.rowVersion} + 1`,
      })
      .where(
        and(
          eq(learningSession.id, sessionId),
          eq(learningSession.userId, userId),
          eq(learningSession.rowVersion, expectedRowVersion),
        ),
      )
      .returning();
    return row ? mapSession(row) : null;
  }

  async getSessionEvent(userId: string, clientEventId: string): Promise<SessionEventRecord | null> {
    const [row] = await this.executor
      .select()
      .from(sessionEvent)
      .where(and(eq(sessionEvent.userId, userId), eq(sessionEvent.clientEventId, clientEventId)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      userId: row.userId,
      clientEventId: row.clientEventId,
      type: row.type as SessionEventRecord["type"],
      meaningful: row.metadata.meaningful === true,
      authority: row.metadata.authority === LESSON_COMPLETION_AUTHORITY
        ? LESSON_COMPLETION_AUTHORITY
        : null,
      occurredAt: row.occurredAt,
    };
  }

  async isLessonCompletionAuthorized(
    userId: string,
    enrollmentId: string,
    lessonId: string,
  ): Promise<boolean> {
    const [boundLesson] = await this.executor
      .select({ id: lesson.id })
      .from(lesson)
      .innerJoin(courseModule, eq(courseModule.id, lesson.moduleId))
      .innerJoin(courseVersion, eq(courseVersion.id, courseModule.courseVersionId))
      .innerJoin(
        enrollment,
        and(
          eq(enrollment.id, enrollmentId),
          eq(enrollment.userId, userId),
          eq(enrollment.courseVersionId, courseVersion.id),
          eq(enrollment.status, "active"),
        ),
      )
      .innerJoin(
        curriculumPublicationPointer,
        and(
          eq(curriculumPublicationPointer.courseId, courseVersion.courseId),
          eq(curriculumPublicationPointer.currentCourseVersionId, courseVersion.id),
        ),
      )
      .where(and(
        eq(lesson.id, lessonId),
        inArray(lesson.contentStatus, ["beta", "verified"]),
        inArray(courseVersion.stage, ["beta", "verified"]),
      ))
      .limit(1);
    if (!boundLesson) return false;
    const requiredConcepts = await this.executor
      .select({ conceptId: lessonConcept.conceptId })
      .from(lessonConcept)
      .where(eq(lessonConcept.lessonId, lessonId));
    if (!requiredConcepts.length) return false;
    const independentEvidence = await this.executor
      .selectDistinct({ conceptId: masteryEvidence.conceptId })
      .from(masteryEvidence)
      .innerJoin(attempt, eq(masteryEvidence.sourceId, sql`${attempt.id}::text`))
      .where(and(
        eq(masteryEvidence.userId, userId),
        eq(masteryEvidence.enrollmentId, enrollmentId),
        inArray(masteryEvidence.conceptId, requiredConcepts.map((row) => row.conceptId)),
        eq(masteryEvidence.validity, "valid"),
        inArray(masteryEvidence.sourceType, ["deterministic_attempt", "verified_runner"]),
        eq(attempt.userId, userId),
        eq(attempt.enrollmentId, enrollmentId),
        eq(attempt.status, "graded"),
        eq(attempt.passed, true),
        eq(attempt.assistanceLevel, "A0"),
        eq(attempt.solutionRevealed, false),
        eq(attempt.infrastructureFailure, false),
      ));
    const evidencedConceptIds = new Set(independentEvidence.map((row) => row.conceptId));
    return requiredConcepts.every((row) => evidencedConceptIds.has(row.conceptId));
  }

  async insertSessionEvent(input: SessionEventInput): Promise<SessionEventRecord> {
    const [row] = await this.executor
      .insert(sessionEvent)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        userId: input.userId,
        clientEventId: input.clientEventId,
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        metadata: {
          meaningful: input.meaningful,
          authority: input.authority,
          policyVersion: LEARNING_POLICY_VERSION,
        },
        clientTime: input.clientTime,
        occurredAt: input.now,
      })
      .returning();
    return {
      id: row.id,
      sessionId: row.sessionId,
      userId: row.userId,
      clientEventId: row.clientEventId,
      type: row.type as SessionEventRecord["type"],
      meaningful: input.meaningful,
      authority: input.authority,
      occurredAt: row.occurredAt,
    };
  }

  async touchMeaningfulActivity(userId: string, occurredAt: Date): Promise<void> {
    await this.executor
      .update(user)
      .set({ lastMeaningfulActivityAt: occurredAt, rowVersion: sql`${user.rowVersion} + 1` })
      .where(eq(user.id, userId));
    // Close the active inactivity episode in the same transaction as the
    // authoritative meaningful-event marker. The scheduler also reconciles
    // this defensively, but this write makes reactivation immediate.
    await this.executor
      .update(inactivityEpisode)
      .set({ closedAt: occurredAt, updatedAt: occurredAt })
      .where(and(
        eq(inactivityEpisode.userId, userId),
        isNull(inactivityEpisode.closedAt),
        sql`${inactivityEpisode.lastActivityAt} < ${occurredAt}`,
      ));
  }

  async resolveActivity(
    userId: string,
    skillId: string,
    kind: LearningAttemptRecord["kind"],
    variantSeed: string,
  ): Promise<ActivityContext | null> {
    const rows = await this.executor
      .select({
        activityId: activity.id,
        activitySlug: activity.slug,
        activityType: activity.type,
        specification: activity.specification,
        skillId: concept.slug,
        conceptId: concept.id,
        enrollmentId: enrollment.id,
        courseVersion: courseVersion.version,
        trackId: course.slug,
        implementationLanguage: enrollment.implementationLanguage,
        assessmentBank: curriculumArtifact.content,
      })
      .from(activity)
      .innerJoin(concept, eq(concept.id, activity.conceptId))
      .innerJoin(lesson, eq(lesson.id, activity.lessonId))
      .innerJoin(courseModule, eq(courseModule.id, lesson.moduleId))
      .innerJoin(courseVersion, eq(courseVersion.id, courseModule.courseVersionId))
      .innerJoin(course, eq(course.id, courseVersion.courseId))
      .innerJoin(
        curriculumArtifact,
        and(
          eq(curriculumArtifact.courseVersionId, courseVersion.id),
          eq(curriculumArtifact.artifactType, "assessment_bank"),
          eq(curriculumArtifact.skillKey, concept.slug),
          eq(curriculumArtifact.reviewStatus, "approved"),
          inArray(curriculumArtifact.publicationStage, ["approved", "published"]),
        ),
      )
      .innerJoin(
        enrollment,
        and(
          eq(enrollment.courseVersionId, courseVersion.id),
          eq(enrollment.userId, userId),
        ),
      )
      .where(
        and(
          eq(concept.slug, skillId),
          inArray(courseVersion.stage, ["beta", "verified"]),
          inArray(lesson.contentStatus, ["beta", "verified"]),
          inArray(enrollment.status, ["planned", "active"]),
          kind === "quiz" ? sql`${enrollment.status} = 'active'
          and ${curriculumArtifact.publicationStage} = 'published'
          and exists (
            select 1
              from curriculum_publication_pointer publication_pointer
             where publication_pointer.course_id = ${course.id}
               and publication_pointer.current_course_version_id = ${courseVersion.id}
          ) and exists (
            select 1
              from curriculum_review_event review_event
             where review_event.artifact_id = ${curriculumArtifact.id}
               and review_event.reviewer_kind = 'human'
               and review_event.decision = 'approved'
               and review_event.content_hash = ${curriculumArtifact.contentHash}
               and review_event.reviewed_item_ids ? (${activity.specification}->>'authoredItemId')
          ) and exists (
            select 1
              from plan_revision current_plan
              cross join lateral jsonb_array_elements(current_plan.plan) plan_item(item)
             where current_plan.enrollment_id = ${enrollment.id}
               and current_plan.id = (
                 select latest_plan.id
                   from plan_revision latest_plan
                  where latest_plan.enrollment_id = ${enrollment.id}
                  order by latest_plan.revision desc
                  limit 1
               )
               and plan_item.item->>'skillId' = ${concept.slug}
               and not exists (
                 select 1
                   from jsonb_array_elements_text(
                     coalesce(plan_item.item->'prerequisites', '[]'::jsonb)
                   ) prerequisite(skill_id)
                  where not exists (
                    select 1
                      from concept prerequisite_concept
                      join concept_mastery prerequisite_mastery
                        on prerequisite_mastery.concept_id = prerequisite_concept.id
                       and prerequisite_mastery.user_id = ${enrollment.userId}
                       and prerequisite_mastery.enrollment_id = ${enrollment.id}
                       and prerequisite_mastery.status in ('proficient', 'mastered', 'needs_review')
                     where prerequisite_concept.slug = prerequisite.skill_id
                  )
               )
          )` : undefined,
        ),
      )
      .orderBy(desc(enrollment.updatedAt), asc(enrollment.id), asc(activity.createdAt))
      .limit(64);
    const reviewedRows = rows.flatMap((row) => {
      const specification = reviewedAuthoredActivitySpecification(
        row.specification,
        row.assessmentBank,
        row.skillId,
      );
      return specification ? [{ ...row, specification }] : [];
    });
    const learnerSafeRows = ["practice", "diagnostic", "quiz", "game"].includes(kind)
      ? reviewedRows.filter((row) => toLearnerActivityForAttemptKind({
          activityId: row.activityId,
          activitySlug: row.activitySlug,
          activityType: row.activityType,
          specification: row.specification,
          skillId: row.skillId,
          conceptId: row.conceptId,
          enrollmentId: row.enrollmentId,
          courseVersion: row.courseVersion,
          trackId: row.trackId,
          implementationLanguage: row.implementationLanguage,
          languageContext: row.trackId === "dsa"
            ? `dsa:${(row.implementationLanguage ?? "unselected").toLocaleLowerCase("en-US")}`
            : "conceptual",
        }, kind) !== null)
      : reviewedRows;
    // A skill can briefly have old and current enrollments during a plan
    // transition. Never mix variants across them: the newest deterministic
    // enrollment ordering above is the sole attempt authority.
    const preferredEnrollmentId = learnerSafeRows[0]?.enrollmentId;
    const enrollmentRows = preferredEnrollmentId
      ? learnerSafeRows.filter((row) => row.enrollmentId === preferredEnrollmentId)
      : learnerSafeRows;
    const compatible = enrollmentRows.filter((row) => {
      const type = row.activityType.toLocaleLowerCase("en-US");
      if (kind === "diagnostic") return type.includes("diagnostic") || type.includes("check") || type.includes("quiz");
      if (kind === "mastery_check") return type.includes("mastery") || type.includes("check") || type.includes("quiz") || type.includes("code");
      return type.includes(kind) || enrollmentRows.length === 1;
    });
    const candidates = compatible.length ? compatible : enrollmentRows;
    const selector = Number.parseInt(
      deterministicUuid("activity-variant", variantSeed).replaceAll("-", "").slice(0, 8),
      16,
    );
    const row = candidates.length ? candidates[selector % candidates.length] : undefined;
    if (!row) return null;
    return {
      activityId: row.activityId,
      activitySlug: row.activitySlug,
      activityType: row.activityType,
      specification: row.specification,
      skillId: row.skillId,
      conceptId: row.conceptId,
      enrollmentId: row.enrollmentId,
      courseVersion: row.courseVersion,
      trackId: row.trackId,
      implementationLanguage: row.implementationLanguage,
      languageContext:
        row.trackId === "dsa"
          ? `dsa:${(row.implementationLanguage ?? "unselected").toLocaleLowerCase("en-US")}`
          : "conceptual",
    };
  }

  private async activityContextForAttempt(
    userId: string,
    attemptId: string,
  ): Promise<AttemptContext | null> {
    const [row] = await this.executor
      .select({
        attempt,
        activityId: activity.id,
        activitySlug: activity.slug,
        activityType: activity.type,
        specification: activity.specification,
        skillId: concept.slug,
        conceptId: concept.id,
        enrollmentId: enrollment.id,
        courseVersion: courseVersion.version,
        trackId: course.slug,
        implementationLanguage: enrollment.implementationLanguage,
        assessmentBank: curriculumArtifact.content,
      })
      .from(attempt)
      .innerJoin(activity, eq(activity.id, attempt.activityId))
      .innerJoin(concept, eq(concept.id, activity.conceptId))
      .innerJoin(enrollment, eq(enrollment.id, attempt.enrollmentId))
      .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
      .innerJoin(course, eq(course.id, courseVersion.courseId))
      .innerJoin(
        curriculumArtifact,
        and(
          eq(curriculumArtifact.courseVersionId, courseVersion.id),
          eq(curriculumArtifact.artifactType, "assessment_bank"),
          eq(curriculumArtifact.skillKey, concept.slug),
          eq(curriculumArtifact.reviewStatus, "approved"),
          inArray(curriculumArtifact.publicationStage, ["approved", "published"]),
        ),
      )
      .where(and(eq(attempt.id, attemptId), eq(attempt.userId, userId), eq(enrollment.userId, userId)))
      .limit(1);
    if (!row) return null;
    const specification = reviewedAuthoredActivitySpecification(
      row.specification,
      row.assessmentBank,
      row.skillId,
    );
    if (!specification) return null;
    return {
      attempt: mapAttempt(row.attempt),
      activity: {
        activityId: row.activityId,
        activitySlug: row.activitySlug,
        activityType: row.activityType,
        specification,
        skillId: row.skillId,
        conceptId: row.conceptId,
        enrollmentId: row.enrollmentId,
        courseVersion: row.courseVersion,
        trackId: row.trackId,
        implementationLanguage: row.implementationLanguage,
        languageContext:
          row.trackId === "dsa"
            ? `dsa:${(row.implementationLanguage ?? "unselected").toLocaleLowerCase("en-US")}`
            : "conceptual",
      },
    };
  }

  getAttempt(userId: string, attemptId: string): Promise<AttemptContext | null> {
    return this.activityContextForAttempt(userId, attemptId);
  }

  async lockAttemptCreation(userId: string, attemptId: string): Promise<void> {
    await this.lock("learning-attempt-request", `${userId}:${attemptId}`);
  }

  async lockPracticeHelpRequest(userId: string, requestId: string): Promise<void> {
    await this.executor.execute(sql`select pg_advisory_xact_lock(hashtext(${`practice-help:${userId}:${requestId}`}))`);
  }

  async lockAttempt(userId: string, attemptId: string): Promise<AttemptContext | null> {
    await this.executor.execute(sql`select id from ${attempt} where ${attempt.id} = ${attemptId} and ${attempt.userId} = ${userId} for update`);
    return this.activityContextForAttempt(userId, attemptId);
  }

  async getPracticeHelpEvent(userId: string, requestId: string): Promise<PracticeHelpEventRecord | null> {
    const [row] = await this.executor
      .select()
      .from(practiceHelpEvent)
      .where(and(eq(practiceHelpEvent.userId, userId), eq(practiceHelpEvent.requestId, requestId)))
      .limit(1);
    return row ? mapPracticeHelpEvent(row) : null;
  }

  async recordPracticeHelp(input: PracticeHelpWriteInput): Promise<{
    readonly attempt: LearningAttemptRecord;
    readonly event: PracticeHelpEventRecord;
  } | null> {
    const [updated] = await this.executor
      .update(attempt)
      .set({
        assistanceLevel: input.assistanceLevel,
        solutionRevealed: input.solutionRevealed,
        helpStep: input.step,
        updatedAt: input.now,
      })
      .where(and(
        eq(attempt.id, input.attemptId),
        eq(attempt.userId, input.userId),
        eq(attempt.helpStep, input.expectedStep),
        inArray(attempt.status, ["created", "in_progress"]),
      ))
      .returning();
    if (!updated) return null;
    const [event] = await this.executor
      .insert(practiceHelpEvent)
      .values({
        id: input.id,
        attemptId: input.attemptId,
        userId: input.userId,
        requestId: input.requestId,
        step: input.step,
        kind: input.kind,
        assistanceLevel: input.assistanceLevel,
        solutionRevealed: input.solutionRevealed,
        createdAt: input.now,
      })
      .returning();
    if (!event) return null;
    return { attempt: mapAttempt(updated), event: mapPracticeHelpEvent(event) };
  }

  async insertAttempt(input: AttemptCreateInput): Promise<LearningAttemptRecord> {
    await this.lock(
      "learning-attempt-sequence",
      `${input.userId}:${input.activity.activityId}:${input.kind}`,
    );
    const [countRow] = await this.executor
      .select({ count: sql<number>`count(*)::int` })
      .from(attempt)
      .where(
        and(
          eq(attempt.userId, input.userId),
          eq(attempt.activityId, input.activity.activityId),
          eq(attempt.kind, input.kind),
        ),
      );
    let [row] = await this.executor
      .insert(attempt)
      .values({
        id: input.id,
        userId: input.userId,
        activityId: input.activity.activityId,
        enrollmentId: input.activity.enrollmentId,
        kind: input.kind,
        attemptNumber: Number(countRow?.count ?? 0) + 1,
        status: "in_progress",
        policyVersion: LEARNING_POLICY_VERSION,
        contentVersion: input.activity.courseVersion,
        startedAt: input.now,
      })
      .onConflictDoNothing({ target: attempt.id })
      .returning();
    if (!row) {
      [row] = await this.executor
        .select()
        .from(attempt)
        .where(and(eq(attempt.id, input.id), eq(attempt.userId, input.userId)))
        .limit(1);
      if (
        !row
        || row.activityId !== input.activity.activityId
        || row.enrollmentId !== input.activity.enrollmentId
        || row.kind !== input.kind
        || row.contentVersion !== input.activity.courseVersion
      ) {
        throw new LearningServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The attempt idempotency key was reused for different parameters.",
          409,
        );
      }
    }
    return mapAttempt(row);
  }

  async insertResponseIfAbsent(attemptId: string, input: SubmissionInput): Promise<boolean> {
    const rows = await this.executor
      .insert(response)
      .values({
        id: deterministicUuid("attempt-response", `${attemptId}:${input.itemKey}:${input.responseRevision}`),
        attemptId,
        itemKey: input.itemKey,
        revision: input.responseRevision,
        answer: { ...input.answer },
        source: "adaptive_browser",
        savedAt: input.submittedAt,
        submittedAt: input.submittedAt,
      })
      .onConflictDoNothing({ target: [response.attemptId, response.itemKey, response.revision] })
      .returning({ id: response.id });
    return rows.length > 0;
  }

  async markAttemptSubmitted(userId: string, attemptId: string, submittedAt: Date): Promise<boolean> {
    const rows = await this.executor
      .update(attempt)
      .set({ status: "submitted", submittedAt })
      .where(
        and(
          eq(attempt.id, attemptId),
          eq(attempt.userId, userId),
          inArray(attempt.status, ["created", "in_progress", "submitted"]),
        ),
      )
      .returning({ id: attempt.id });
    return rows.length > 0;
  }

  async gradeAttempt(input: AttemptGradeInput): Promise<boolean> {
    const rows = await this.executor
      .update(attempt)
      .set({
        status: "graded",
        score: input.score,
        passed: input.passed,
        masteryAwarded: input.masteryAwarded,
        submittedAt: input.now,
        gradedAt: input.now,
      })
      .where(
        and(
          eq(attempt.id, input.attemptId),
          eq(attempt.userId, input.userId),
          inArray(attempt.status, ["created", "in_progress", "submitted"]),
        ),
      )
      .returning({ id: attempt.id });
    return rows.length > 0;
  }

  async getVerifiedRunnerResult(attemptId: string): Promise<unknown | null> {
    const [row] = await this.executor
      .select({ result: runnerJob.result })
      .from(runnerJob)
      .innerJoin(codeSubmission, eq(codeSubmission.id, runnerJob.submissionId))
      .where(and(eq(codeSubmission.attemptId, attemptId), eq(runnerJob.status, "succeeded")))
      .orderBy(desc(runnerJob.completedAt))
      .limit(1);
    return row?.result ?? null;
  }

  async getMasteryBundle(context: AttemptContext): Promise<MasteryBundle> {
    const { activity: activityContext, attempt: attemptContext } = context;
    const [masteryRow] = await this.executor
      .select({ mastery: conceptMastery, skillId: concept.slug })
      .from(conceptMastery)
      .innerJoin(concept, eq(concept.id, conceptMastery.conceptId))
      .where(
        and(
          eq(conceptMastery.userId, attemptContext.userId),
          eq(conceptMastery.enrollmentId, activityContext.enrollmentId),
          eq(conceptMastery.conceptId, activityContext.conceptId),
          eq(conceptMastery.languageContext, activityContext.languageContext),
        ),
      )
      .limit(1);
    const evidenceRows = await this.executor
      .select({ evidence: masteryEvidence, skillId: concept.slug })
      .from(masteryEvidence)
      .innerJoin(concept, eq(concept.id, masteryEvidence.conceptId))
      .where(
        and(
          eq(masteryEvidence.userId, attemptContext.userId),
          eq(masteryEvidence.enrollmentId, activityContext.enrollmentId),
          eq(masteryEvidence.conceptId, activityContext.conceptId),
          eq(masteryEvidence.languageContext, activityContext.languageContext),
        ),
      )
      .orderBy(asc(masteryEvidence.recordedAt));
    const reviewRows = await this.executor
      .select({ review: reviewSchedule, skillId: concept.slug })
      .from(reviewSchedule)
      .innerJoin(concept, eq(concept.id, reviewSchedule.conceptId))
      .where(
        and(
          eq(reviewSchedule.userId, attemptContext.userId),
          eq(reviewSchedule.enrollmentId, activityContext.enrollmentId),
          eq(reviewSchedule.conceptId, activityContext.conceptId),
          eq(reviewSchedule.status, "scheduled"),
        ),
      )
      .orderBy(desc(reviewSchedule.createdAt));
    const mappedReviews = reviewRows.map((row) => mapReview({ ...row.review, skillId: row.skillId }));
    const activeReview = mappedReviews.find(
      (review) => reviewLanguageContext(review) === activityContext.languageContext,
    ) ?? null;
    return {
      mastery: masteryRow ? mapMastery({ ...masteryRow.mastery, skillId: masteryRow.skillId }) : null,
      evidence: evidenceRows.map((row) => mapEvidence({ ...row.evidence, skillId: row.skillId })),
      activeReview,
    };
  }

  async appendOfficialEvidence(input: MasteryWriteInput): Promise<boolean> {
    const rows = await this.executor
      .insert(masteryEvidence)
      .values({
        id: deterministicUuid(
          "mastery-evidence",
          `${input.userId}:${input.attempt.activity.conceptId}:${input.attempt.activity.languageContext}:${input.evidenceSourceType}:${input.evidenceSourceId}`,
        ),
        userId: input.userId,
        enrollmentId: input.attempt.activity.enrollmentId,
        conceptId: input.attempt.activity.conceptId,
        languageContext: input.attempt.activity.languageContext,
        evidenceType: input.evidenceType,
        sourceType: input.evidenceSourceType,
        sourceId: input.evidenceSourceId,
        score: input.transition.observation.correct ? 1 : 0,
        weight: input.evidenceWeight,
        criticalCriterion: "core",
        validity: "valid",
        policyVersion: LEARNING_POLICY_VERSION,
        recordedBy: input.evidenceSourceType === "verified_runner" ? "verified-runner" : "adaptive-deterministic-engine",
        recordedAt: input.now,
      })
      .onConflictDoNothing({
        target: [
          masteryEvidence.userId,
          masteryEvidence.sourceType,
          masteryEvidence.sourceId,
          masteryEvidence.conceptId,
          masteryEvidence.criticalCriterion,
        ],
      })
      .returning({ id: masteryEvidence.id });
    return rows.length > 0;
  }

  async writeMastery(input: MasteryWriteInput): Promise<boolean> {
    const values = {
      score: input.transition.progress.masteryProbability,
      confidence: input.transition.confidence,
      status: masteryStatus(input.transition.databaseStatus),
      criticalRequirementsMet: input.transition.criticalRequirementsMet,
      lastEvidenceAt: input.now,
      lastPracticedAt: input.now,
      policyVersion: LEARNING_POLICY_VERSION,
      updatedAt: input.now,
    } as const;
    if (input.expectedRowVersion === null) {
      const rows = await this.executor
        .insert(conceptMastery)
        .values({
          userId: input.userId,
          enrollmentId: input.attempt.activity.enrollmentId,
          conceptId: input.attempt.activity.conceptId,
          languageContext: input.attempt.activity.languageContext,
          rowVersion: 1,
          ...values,
        })
        .onConflictDoNothing({
          target: [
            conceptMastery.userId,
            conceptMastery.enrollmentId,
            conceptMastery.conceptId,
            conceptMastery.languageContext,
          ],
        })
        .returning({ userId: conceptMastery.userId });
      return rows.length > 0;
    }
    const rows = await this.executor
      .update(conceptMastery)
      .set({ ...values, rowVersion: sql`${conceptMastery.rowVersion} + 1` })
      .where(
        and(
          eq(conceptMastery.userId, input.userId),
          eq(conceptMastery.enrollmentId, input.attempt.activity.enrollmentId),
          eq(conceptMastery.conceptId, input.attempt.activity.conceptId),
          eq(conceptMastery.languageContext, input.attempt.activity.languageContext),
          eq(conceptMastery.rowVersion, input.expectedRowVersion),
        ),
      )
      .returning({ userId: conceptMastery.userId });
    return rows.length > 0;
  }

  async writeReview(input: ReviewWriteInput): Promise<StoredReview> {
    if (input.previous) {
      await this.executor
        .update(reviewSchedule)
        .set({ status: "completed", updatedAt: input.now })
        .where(
          and(
            eq(reviewSchedule.id, input.previous.id),
            eq(reviewSchedule.userId, input.userId),
            eq(reviewSchedule.status, "scheduled"),
          ),
        );
    }
    const id = deterministicUuid(
      "review-schedule",
      `${input.userId}:${input.attempt.activity.conceptId}:${input.attempt.activity.languageContext}:${input.attempt.attempt.id}:${input.dueAt.toISOString()}`,
    );
    const [row] = await this.executor
      .insert(reviewSchedule)
      .values({
        id,
        userId: input.userId,
        enrollmentId: input.attempt.activity.enrollmentId,
        conceptId: input.attempt.activity.conceptId,
        dueAt: input.dueAt,
        intervalDays: input.intervalDays,
        reason: input.reason,
        status: "scheduled",
        completedAttemptId: input.attempt.attempt.id,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning();
    await this.executor
      .update(conceptMastery)
      .set({ nextReviewAt: input.dueAt, updatedAt: input.now })
      .where(
        and(
          eq(conceptMastery.userId, input.userId),
          eq(conceptMastery.enrollmentId, input.attempt.activity.enrollmentId),
          eq(conceptMastery.conceptId, input.attempt.activity.conceptId),
          eq(conceptMastery.languageContext, input.attempt.activity.languageContext),
        ),
      );
    const persisted = row ?? (await this.executor
      .select()
      .from(reviewSchedule)
      .where(eq(reviewSchedule.id, id))
      .limit(1))[0]!;
    return mapReview(
      { ...persisted, skillId: input.attempt.activity.skillId },
      input.attempt.activity.languageContext,
    );
  }

  async getAdaptiveSnapshot(userId: string, sessionId?: string): Promise<AdaptiveSnapshot> {
    const enrollmentRows = await this.executor
      .select({ id: enrollment.id })
      .from(enrollment)
      .where(
        and(
          eq(enrollment.userId, userId),
          inArray(enrollment.status, ["planned", "active", "completed"]),
        ),
      );
    const enrollmentIds = enrollmentRows.map((row) => row.id);
    if (!enrollmentIds.length) {
      return { planItems: [], progress: [], reviews: [], sessionCounts: { completedActions: 0, reviewActions: 0 } };
    }
    const revisions = await this.executor
      .select()
      .from(planRevision)
      .where(inArray(planRevision.enrollmentId, enrollmentIds))
      .orderBy(desc(planRevision.revision));
    const seenEnrollments = new Set<string>();
    const plans = revisions.filter((row) => {
      if (seenEnrollments.has(row.enrollmentId)) return false;
      seenEnrollments.add(row.enrollmentId);
      return true;
    });
    const currentPlanItems = plans.flatMap((row) => planItems(row.plan));
    const masteryRows = await this.executor
      .select({ mastery: conceptMastery, skillId: concept.slug })
      .from(conceptMastery)
      .innerJoin(concept, eq(concept.id, conceptMastery.conceptId))
      .where(and(eq(conceptMastery.userId, userId), inArray(conceptMastery.enrollmentId, enrollmentIds)));
    const evidenceRows = await this.executor
      .select({ evidence: masteryEvidence, skillId: concept.slug })
      .from(masteryEvidence)
      .innerJoin(concept, eq(concept.id, masteryEvidence.conceptId))
      .where(and(eq(masteryEvidence.userId, userId), inArray(masteryEvidence.enrollmentId, enrollmentIds)))
      .orderBy(asc(masteryEvidence.recordedAt));
    const evidenceByKey = new Map<string, StoredEvidence[]>();
    for (const row of evidenceRows) {
      const mapped = mapEvidence({ ...row.evidence, skillId: row.skillId });
      const key = `${mapped.enrollmentId}:${mapped.conceptId}:${mapped.languageContext}`;
      const items = evidenceByKey.get(key) ?? [];
      items.push(mapped);
      evidenceByKey.set(key, items);
    }
    const masteryBySkillContext = new Map<string, StoredMastery>();
    for (const row of masteryRows) {
      const mapped = mapMastery({ ...row.mastery, skillId: row.skillId });
      masteryBySkillContext.set(`${mapped.skillId}:${mapped.languageContext}`, mapped);
    }
    const progress = [];
    const progressSeen = new Set<string>();
    for (const item of currentPlanItems.filter((item) => item.kind !== "diagnostic")) {
      if (progressSeen.has(item.skillId)) continue;
      const mastery = masteryBySkillContext.get(`${item.skillId}:${item.languageContext}`);
      if (!mastery) continue;
      const key = `${mastery.enrollmentId}:${mastery.conceptId}:${mastery.languageContext}`;
      progress.push(progressFromMasteryBundle(item.skillId, {
        mastery,
        evidence: evidenceByKey.get(key) ?? [],
        activeReview: null,
      }));
      progressSeen.add(item.skillId);
    }
    const reviewRows = await this.executor
      .select({ review: reviewSchedule, skillId: concept.slug })
      .from(reviewSchedule)
      .innerJoin(concept, eq(concept.id, reviewSchedule.conceptId))
      .where(
        and(
          eq(reviewSchedule.userId, userId),
          eq(reviewSchedule.status, "scheduled"),
          inArray(reviewSchedule.enrollmentId, enrollmentIds),
        ),
      );
    const currentContextBySkill = new Map(
      currentPlanItems
        .filter((item) => item.kind !== "diagnostic")
        .map((item) => [item.skillId, item.languageContext]),
    );
    const reviews = reviewRows
      .map((row) => mapReview({ ...row.review, skillId: row.skillId }))
      .filter(
        (review) =>
          reviewLanguageContext(review) === currentContextBySkill.get(review.skillId),
      )
      .map(decodeReviewSchedule);
    let completedActions = 0;
    let reviewActions = 0;
    let reviewOnly = false;
    if (sessionId) {
      const [ownedSession] = await this.executor
        .select({ id: learningSession.id, reviewOnly: learningSession.reviewOnly })
        .from(learningSession)
        .where(and(eq(learningSession.id, sessionId), eq(learningSession.userId, userId)))
        .limit(1);
      if (ownedSession) {
        const eventRows = await this.executor
          .select({ type: sessionEvent.type, metadata: sessionEvent.metadata })
          .from(sessionEvent)
          .where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.userId, userId)));
        completedActions = eventRows.filter((row) => row.metadata.meaningful === true).length;
        reviewActions = eventRows.filter((row) => row.type === "review_completed").length;
        reviewOnly = ownedSession.reviewOnly;
      }
    }
    return {
      planItems: currentPlanItems,
      progress,
      reviews,
      sessionCounts: { completedActions, reviewActions, ...(reviewOnly ? { reviewOnly: true } : {}) },
    };
  }

  async getDsaEnrollment(userId: string): Promise<DsaEnrollmentRecord | null> {
    const [row] = await this.executor
      .select({
        enrollmentId: enrollment.id,
        courseVersionId: courseVersion.id,
        courseVersion: courseVersion.version,
        implementationLanguage: enrollment.implementationLanguage,
      })
      .from(enrollment)
      .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
      .innerJoin(course, eq(course.id, courseVersion.courseId))
      .where(
        and(
          eq(enrollment.userId, userId),
          eq(course.slug, "dsa"),
          inArray(enrollment.status, ["planned", "active", "completed"]),
        ),
      )
      .orderBy(desc(enrollment.updatedAt))
      .limit(1);
    if (!row) return null;
    const [latest] = await this.executor
      .select({ id: planRevision.id, revision: planRevision.revision, plan: planRevision.plan })
      .from(planRevision)
      .where(eq(planRevision.enrollmentId, row.enrollmentId))
      .orderBy(desc(planRevision.revision))
      .limit(1);
    return {
      ...row,
      latestRevisionId: latest?.id ?? null,
      latestRevision: latest?.revision ?? 0,
      latestPlan: planItems(latest?.plan),
    };
  }

  async lockDsaLanguageSwitch(userId: string): Promise<void> {
    // DSA switches and adaptive initialization both append plan revisions;
    // share one learner-local lock so they cannot allocate the same revision.
    await this.lockPlanInitialization(userId);
  }

  async writeDsaLanguageSwitch(input: DsaLanguageWriteInput): Promise<
    "written" | "replayed" | "unchanged" | "conflict" | "stale"
  > {
    // Keep direct transaction users safe as well as the application service.
    await this.lockDsaLanguageSwitch(input.userId);
    const expectedPlan = input.plan.map((item) => ({ ...item }));
    const expectedReason = `Language switched to ${input.language}; syntax evidence must be retested; prior evidence preserved.`;
    const [existing] = await this.executor
      .select({
        id: planRevision.id,
        source: planRevision.source,
        reason: planRevision.reason,
        policyVersion: planRevision.policyVersion,
        createdBy: planRevision.createdBy,
        plan: planRevision.plan,
      })
      .from(planRevision)
      .where(and(eq(planRevision.id, input.revisionId), eq(planRevision.enrollmentId, input.enrollment.enrollmentId)))
      .limit(1);
    if (existing) {
      const replayMatches = existing.source === "dsa_language_switch"
        && existing.reason === expectedReason
        && existing.policyVersion === LEARNING_POLICY_VERSION
        && existing.createdBy === input.userId
        && isDeepStrictEqual(existing.plan, expectedPlan);
      return replayMatches && sameDsaLanguage(input.enrollment.implementationLanguage, input.language)
        ? "replayed"
        : "conflict";
    }
    const priorLanguage = input.enrollment.implementationLanguage;
    if (sameDsaLanguage(priorLanguage, input.language)) return "unchanged";
    const rows = await this.executor
      .update(enrollment)
      .set({ implementationLanguage: input.language, updatedAt: input.now })
      .where(
        and(
          eq(enrollment.id, input.enrollment.enrollmentId),
          eq(enrollment.userId, input.userId),
          priorLanguage === null
            ? isNull(enrollment.implementationLanguage)
            : eq(enrollment.implementationLanguage, priorLanguage),
        ),
      )
      .returning({ id: enrollment.id });
    if (!rows.length) return "stale";
    const inserted = await this.executor.insert(planRevision).values({
      id: input.revisionId,
      enrollmentId: input.enrollment.enrollmentId,
      revision: input.enrollment.latestRevision + 1,
      parentId: input.enrollment.latestRevisionId,
      source: "dsa_language_switch",
      reason: expectedReason,
      policyVersion: LEARNING_POLICY_VERSION,
      createdBy: input.userId,
      plan: expectedPlan,
      createdAt: input.now,
    }).onConflictDoNothing().returning({ id: planRevision.id });
    if (!inserted.length) {
      const [conflicting] = await this.executor
        .select({ id: planRevision.id })
        .from(planRevision)
        .where(eq(planRevision.id, input.revisionId))
        .limit(1);
      return conflicting ? "conflict" : "stale";
    }
    await this.executor
      .update(learnerProfile)
      .set({
        dsaLanguage: input.language,
        rowVersion: sql`${learnerProfile.rowVersion} + 1`,
        updatedAt: input.now,
      })
      .where(eq(learnerProfile.userId, input.userId));
    return "written";
  }
}
