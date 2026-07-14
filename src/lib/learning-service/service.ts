import {
  createInitialReviewSchedule,
  scheduleNextReview,
  selectNextAction,
  type KnowledgeComponent,
} from "@/lib/domain";
import { ContentRepository } from "@/lib/content";

import {
  buildDsaLanguageRetestDraft,
  buildLearningPlan,
  languageContextForSkill,
  normalizeDsaLanguage,
} from "./planner";
import {
  buildMasteryTransition,
  encodeEvidenceEnvelope,
  evaluateAuthoredActivity,
  evidenceEnvelopeFor,
  validateRunnerEvaluation,
} from "./evidence-engine";
import { deterministicUuid } from "./ids";
import { decodeReviewSchedule, encodeReviewReason } from "./review-codec";
import {
  practiceFeedbackFor,
  practiceHelpAt,
  toLearnerActivityForAttemptKind,
  toLearnerPracticeActivity,
} from "./learner-activity";
import type { LearningStore } from "./store";
import {
  LearningServiceError,
  LESSON_COMPLETION_AUTHORITY,
  type AttemptCreationResult,
  type AttemptEvaluation,
  type AttemptSubmissionResult,
  type DsaLanguage,
  type DsaLanguageSwitchResult,
  type LearningSessionRecord,
  type NextActionResult,
  type PlanInitializationResult,
  type PracticeHelpResult,
  type SessionEventRecord,
  type SessionEventType,
  type SessionMutationResult,
  type SubmissionInput,
  type SupportedAttemptKind,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "heartbeat",
  "lesson_viewed",
  "hint_requested",
  "code_run",
  "lesson_completed",
  "attempt_submitted",
  "review_completed",
  "remediation_recovered",
  "project_milestone",
];

export const SUPPORTED_ATTEMPT_KINDS: readonly SupportedAttemptKind[] = [
  "diagnostic",
  "practice",
  "quiz",
  "game",
  "mastery_check",
];

function requireIdempotencyKey(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(trimmed)) {
    throw new LearningServiceError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency keys must be 8-128 safe characters.",
    );
  }
  return trimmed;
}

function requireRowVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LearningServiceError("INVALID_ROW_VERSION", "A positive expected row version is required.");
  }
  return value;
}

function conflict(resource: string): never {
  throw new LearningServiceError(
    "VERSION_CONFLICT",
    `${resource} changed in another request. Reload and retry with its current row version.`,
    409,
  );
}

export interface LearningServiceOptions {
  readonly store: LearningStore;
  readonly content?: ContentRepository;
  readonly now?: () => Date;
}

export class LearningService {
  private readonly store: LearningStore;
  private readonly content: ContentRepository;
  private readonly now: () => Date;

  constructor(options: LearningServiceOptions) {
    this.store = options.store;
    this.content = options.content ?? new ContentRepository();
    this.now = options.now ?? (() => new Date());
  }

  async initializePlans(userId: string, idempotencyKeyInput: string): Promise<PlanInitializationResult> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyInput);
    const runtime = await Promise.all([
      this.content.getSnapshot(),
      this.content.getIndex(),
      this.content.getGraph(),
    ]);
    return this.store.transaction(async (transaction) => {
      await transaction.lockPlanInitialization(userId);
      const profile = await transaction.getPlanningProfile(userId);
      if (!profile || !profile.selectedTrackIds.length) {
        return {
          state: "empty",
          plans: [],
          selectedTrackIds: profile?.selectedTrackIds ?? [],
          resolvedTrackIds: [],
          missingPublications: [],
          warnings: [profile ? "No tracks are selected." : "Learner profile is unavailable."],
          placement: {
            required: true,
            selfReportUsedAsEvidence: false,
            reason: "Placement begins with recorded diagnostic evidence; self-report is never mastery evidence.",
          },
        };
      }
      const resolution = buildLearningPlan(
        runtime[0],
        runtime[1],
        runtime[2],
        profile.selectedTrackIds,
        profile.dsaLanguage,
      );
      const publications = await transaction.getCoursePublications(resolution.resolvedTrackIds);
      const publicationByTrack = new Map(
        publications
          .filter((publication) => publication.stage === "beta" || publication.stage === "verified")
          .map((publication) => [publication.trackId, publication]),
      );
      const missingPublications: string[] = [];
      const plans = [];
      for (const draft of resolution.drafts) {
        const publication = publicationByTrack.get(draft.trackId);
        if (!publication || publication.version !== draft.manifestVersion) {
          missingPublications.push(draft.trackId);
          continue;
        }
        plans.push(
          await transaction.persistPlan({
            userId,
            idempotencyKey,
            draft,
            publication,
          }),
        );
      }
      return {
        state: missingPublications.length ? "degraded" : plans.length ? "ready" : "empty",
        plans,
        selectedTrackIds: resolution.selectedTrackIds,
        resolvedTrackIds: resolution.resolvedTrackIds,
        missingPublications: missingPublications.sort(),
        warnings: resolution.warnings,
        placement: {
          required: true,
          selfReportUsedAsEvidence: false,
          reason: `Self-reported level '${profile.selfReportedLevel}' informs tone only; diagnostic attempts determine placement.`,
        },
      };
    });
  }

  async startSession(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly enrollmentId?: string | null;
    readonly goal: string;
    readonly plannedMinutes: number;
    readonly reviewOnly?: boolean;
  }): Promise<SessionMutationResult> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const goal = input.goal.trim();
    if (goal.length < 3 || goal.length > 240) {
      throw new LearningServiceError("INVALID_SESSION_GOAL", "Session goal must be 3-240 characters.");
    }
    if (!Number.isInteger(input.plannedMinutes) || input.plannedMinutes < 5 || input.plannedMinutes > 180) {
      throw new LearningServiceError("INVALID_SESSION_LENGTH", "Planned session length must be 5-180 minutes.");
    }
    const id = deterministicUuid("learning-session", `${input.userId}:${key}`);
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      await transaction.lockSessionStart(input.userId);
      const existing = await transaction.getSession(input.userId, id);
      if (existing) {
        if (
          existing.enrollmentId !== (input.enrollmentId ?? null)
          || existing.goal !== goal
          || existing.plannedMinutes !== input.plannedMinutes
          || existing.reviewOnly !== (input.reviewOnly === true)
        ) {
          throw new LearningServiceError(
            "IDEMPOTENCY_CONFLICT",
            "The session idempotency key was reused for different parameters.",
            409,
          );
        }
        return { session: existing, idempotent: true, resumed: existing.status === "active" };
      }
      const active = await transaction.getActiveSession(input.userId);
      if (active) return { session: active, resumed: true };
      return {
        session: await transaction.insertSession({
          id,
          userId: input.userId,
          enrollmentId: input.enrollmentId ?? null,
          goal,
          plannedMinutes: input.plannedMinutes,
          reviewOnly: input.reviewOnly === true,
          now,
        }),
      };
    });
  }

  async getSession(userId: string, sessionId: string): Promise<LearningSessionRecord | null> {
    return this.store.transaction((transaction) => transaction.getSession(userId, sessionId));
  }

  async mutateSession(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly expectedRowVersion: number;
    readonly action: "resume" | "end";
  }): Promise<SessionMutationResult> {
    if (input.action !== "resume" && input.action !== "end") {
      throw new LearningServiceError("INVALID_SESSION_ACTION", "Unsupported learning session action.");
    }
    const expected = requireRowVersion(input.expectedRowVersion);
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      const current = await transaction.getSession(input.userId, input.sessionId);
      if (!current) throw new LearningServiceError("SESSION_NOT_FOUND", "Learning session was not found.", 404);
      if (current.rowVersion !== expected) conflict("Learning session");
      if (input.action === "resume" && current.endedAt) {
        throw new LearningServiceError("SESSION_ENDED", "Ended sessions cannot be resumed.", 409);
      }
      if (input.action === "end" && current.endedAt) {
        return { session: current, idempotent: true };
      }
      const updated = await transaction.updateSession(
        input.userId,
        input.sessionId,
        expected,
        input.action === "end"
          ? { status: "completed", lastActivityAt: now, endedAt: now }
          : { status: "active", lastActivityAt: now, endedAt: null },
      );
      if (!updated) conflict("Learning session");
      return { session: updated, resumed: input.action === "resume" };
    });
  }

  async recordSessionEvent(input: {
    readonly userId: string;
    readonly sessionId: string;
    readonly clientEventId: string;
    readonly expectedRowVersion: number;
    readonly type: SessionEventType;
    readonly subjectType?: string | null;
    readonly subjectId?: string | null;
    readonly clientTime?: Date | null;
  }): Promise<{ readonly event: SessionEventRecord; readonly session: LearningSessionRecord; readonly idempotent: boolean }> {
    const expected = requireRowVersion(input.expectedRowVersion);
    if (!SESSION_EVENT_TYPES.includes(input.type)) {
      throw new LearningServiceError("INVALID_EVENT_TYPE", "Unsupported learning session event type.");
    }
    if (!/^[A-Za-z0-9_.:-]{8,160}$/.test(input.clientEventId)) {
      throw new LearningServiceError("INVALID_CLIENT_EVENT_ID", "Client event id is invalid.");
    }
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      const duplicate = await transaction.getSessionEvent(input.userId, input.clientEventId);
      if (duplicate) {
        const session = await transaction.getSession(input.userId, duplicate.sessionId);
        if (!session) throw new LearningServiceError("SESSION_NOT_FOUND", "Learning session was not found.", 404);
        return { event: duplicate, session, idempotent: true };
      }
      const current = await transaction.getSession(input.userId, input.sessionId);
      if (!current) throw new LearningServiceError("SESSION_NOT_FOUND", "Learning session was not found.", 404);
      if (current.endedAt) throw new LearningServiceError("SESSION_ENDED", "Ended sessions reject new events.", 409);
      if (current.rowVersion !== expected) conflict("Learning session");
      const subjectType = input.subjectType?.trim().slice(0, 80) ?? null;
      const subjectId = input.subjectId?.trim().slice(0, 160) ?? null;
      let authority: typeof LESSON_COMPLETION_AUTHORITY | null = null;
      if (input.type === "lesson_completed") {
        const validBinding = subjectType === "lesson"
          && subjectId !== null
          && UUID_PATTERN.test(subjectId)
          && current.enrollmentId !== null
          && await transaction.isLessonCompletionAuthorized(
            input.userId,
            current.enrollmentId,
            subjectId,
          );
        if (!validBinding) {
          throw new LearningServiceError(
            "INVALID_EVENT_SUBJECT",
            "Lesson completion requires a current published lesson and independent graded evidence for every lesson concept.",
          );
        }
        authority = LESSON_COMPLETION_AUTHORITY;
      }
      // Generic browser events are telemetry. Only the server-validated lesson
      // binding above may assert meaningful learning through this endpoint.
      const meaningful = authority !== null;
      const updated = await transaction.updateSession(input.userId, input.sessionId, expected, {
        status: current.status,
        lastActivityAt: now,
      });
      if (!updated) conflict("Learning session");
      const event = await transaction.insertSessionEvent({
        id: deterministicUuid("session-event", `${input.userId}:${input.clientEventId}`),
        userId: input.userId,
        sessionId: input.sessionId,
        clientEventId: input.clientEventId,
        expectedRowVersion: expected,
        type: input.type,
        meaningful,
        authority,
        subjectType,
        subjectId,
        clientTime: input.clientTime ?? null,
        now,
      });
      if (meaningful) await transaction.touchMeaningfulActivity(input.userId, now);
      return { event, session: updated, idempotent: false };
    });
  }

  async createAttempt(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly skillId: string;
    readonly kind: SupportedAttemptKind;
  }): Promise<AttemptCreationResult> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    if (!SUPPORTED_ATTEMPT_KINDS.includes(input.kind)) {
      throw new LearningServiceError("INVALID_ATTEMPT_KIND", "Unsupported adaptive attempt kind.");
    }
    const skill = await this.content.getSkill(input.skillId);
    if (!skill) throw new LearningServiceError("SKILL_NOT_FOUND", "Atomic skill was not found.", 404);
    const id = deterministicUuid("learning-attempt", `${input.userId}:${key}`);
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      await transaction.lockAttemptCreation(input.userId, id);
      const existing = await transaction.getAttempt(input.userId, id);
      if (existing) {
        if (existing.activity.skillId !== input.skillId || existing.attempt.kind !== input.kind) {
          throw new LearningServiceError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for different attempt parameters.", 409);
        }
        if (["practice", "diagnostic", "quiz"].includes(input.kind)
          && !toLearnerActivityForAttemptKind(existing.activity, input.kind)) {
          return { state: "degraded", attempt: null, activity: null, idempotent: true, reason: "activity_unsupported" };
        }
        return { state: "ready", attempt: existing.attempt, activity: existing.activity, idempotent: true };
      }
      const resolvedActivity = await transaction.resolveActivity(
        input.userId,
        input.skillId,
        input.kind,
        key,
      );
      if (!resolvedActivity) {
        return {
          state: "degraded",
          attempt: null,
          activity: null,
          idempotent: false,
          reason: "activity_unavailable",
        };
      }
      const activity = {
        ...resolvedActivity,
        languageContext: languageContextForSkill(
          resolvedActivity.trackId,
          skill,
          normalizeDsaLanguage(resolvedActivity.implementationLanguage),
        ),
      };
      if (["practice", "diagnostic", "quiz"].includes(input.kind)
        && !toLearnerActivityForAttemptKind(activity, input.kind)) {
        return {
          state: "degraded",
          attempt: null,
          activity: null,
          idempotent: false,
          reason: "activity_unsupported",
        };
      }
      const attempt = await transaction.insertAttempt({ id, userId: input.userId, activity, kind: input.kind, now });
      return { state: "ready", attempt, activity, idempotent: false };
    });
  }

  async submitAttempt(
    userId: string,
    attemptId: string,
    response: SubmissionInput,
  ): Promise<AttemptSubmissionResult> {
    if (!Number.isInteger(response.responseRevision) || response.responseRevision < 1) {
      throw new LearningServiceError("INVALID_RESPONSE_REVISION", "Response revision must be a positive integer.");
    }
    if (!response.itemKey.trim() || response.itemKey.length > 160) {
      throw new LearningServiceError("INVALID_ITEM_KEY", "Attempt item key is invalid.");
    }
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      const context = await transaction.getAttempt(userId, attemptId);
      if (!context) throw new LearningServiceError("ATTEMPT_NOT_FOUND", "Learning attempt was not found.", 404);
      const effectiveResponse: SubmissionInput = {
        ...response,
        assistanceLevel: context.attempt.assistanceLevel,
        solutionRevealed: context.attempt.solutionRevealed,
      };
      if (context.attempt.status === "graded") {
        const repeatedEvaluation = evaluateAuthoredActivity(context.activity, effectiveResponse.answer);
        const feedback = repeatedEvaluation.state === "graded"
          && repeatedEvaluation.passed === context.attempt.passed
          ? practiceFeedbackFor(context.activity, repeatedEvaluation, effectiveResponse)
          : null;
        return {
          state: "graded",
          attemptId,
          attemptStatus: "graded",
          score: context.attempt.score,
          passed: context.attempt.passed,
          officialEvidenceRecorded: true,
          masteryAwarded: context.attempt.masteryAwarded,
          progress: null,
          criticalGates: [],
          remediation: { activeTags: [], confirmingProbeTags: [] },
          feedback,
          reviewDueAt: null,
          idempotent: true,
        };
      }
      if (!["in_progress", "created", "submitted"].includes(context.attempt.status)) {
        throw new LearningServiceError("ATTEMPT_NOT_SUBMITTABLE", "Attempt is not open for submission.", 409);
      }
      const learnerActivity = toLearnerPracticeActivity(context.activity);
      if (learnerActivity && learnerActivity.specification.itemKey !== response.itemKey) {
        throw new LearningServiceError("ITEM_KEY_MISMATCH", "The response does not match this attempt item.", 409);
      }
      if (!(await transaction.insertResponseIfAbsent(attemptId, effectiveResponse))) {
        throw new LearningServiceError(
          "RESPONSE_REVISION_CONFLICT",
          "This response revision was already submitted. Reload the attempt before retrying.",
          409,
        );
      }
      let evaluation: AttemptEvaluation = evaluateAuthoredActivity(context.activity, effectiveResponse.answer);
      if (evaluation.state === "unavailable" && evaluation.reason === "runner_not_complete") {
        evaluation = validateRunnerEvaluation(await transaction.getVerifiedRunnerResult(attemptId));
      }
      if (evaluation.state === "unavailable") {
        if (!(await transaction.markAttemptSubmitted(userId, attemptId, now))) conflict("Learning attempt");
        return {
          state: "degraded",
          attemptId,
          attemptStatus: "submitted",
          score: null,
          passed: null,
          officialEvidenceRecorded: false,
          masteryAwarded: false,
          progress: null,
          criticalGates: [],
          remediation: { activeTags: [], confirmingProbeTags: [] },
          feedback: null,
          reviewDueAt: null,
          degradedReason: evaluation.reason,
        };
      }
      const bundle = await transaction.getMasteryBundle(context);
      const transition = buildMasteryTransition(context, bundle, effectiveResponse, evaluation, now);
      const envelope = evidenceEnvelopeFor(context, transition, evaluation);
      const writeInput = {
        userId,
        attempt: context,
        transition,
        evidenceType: encodeEvidenceEnvelope(envelope),
        evidenceSourceType: evaluation.origin === "verified_runner" ? "verified_runner" as const : "deterministic_attempt" as const,
        evidenceSourceId: context.attempt.id,
        evidenceWeight: 1,
        now,
        expectedRowVersion: bundle.mastery?.rowVersion ?? null,
      };
      if (!(await transaction.appendOfficialEvidence(writeInput))) conflict("Official evidence");
      if (!(await transaction.writeMastery(writeInput))) conflict("Concept mastery");

      let reviewDueAt: Date | null = null;
      if (transition.reviewOutcome && bundle.activeReview) {
        const schedule = scheduleNextReview(
          decodeReviewSchedule(bundle.activeReview),
          transition.reviewOutcome,
          now.getTime(),
        );
        const review = await transaction.writeReview({
          userId,
          attempt: context,
          previous: bundle.activeReview,
          dueAt: new Date(schedule.dueAtMs),
          intervalDays: schedule.intervalDays,
          reason: encodeReviewReason(schedule, context.activity.languageContext),
          now,
        });
        reviewDueAt = review.dueAt;
      } else if (transition.createInitialReview) {
        const schedule = createInitialReviewSchedule(context.activity.skillId, now.getTime());
        const review = await transaction.writeReview({
          userId,
          attempt: context,
          previous: null,
          dueAt: new Date(schedule.dueAtMs),
          intervalDays: schedule.intervalDays,
          reason: encodeReviewReason(schedule, context.activity.languageContext),
          now,
        });
        reviewDueAt = review.dueAt;
      }
      if (!(await transaction.gradeAttempt({
        attemptId,
        userId,
        score: evaluation.score,
        passed: evaluation.passed,
        masteryAwarded: transition.masteryAwarded,
        now,
      }))) conflict("Learning attempt");
      await transaction.touchMeaningfulActivity(userId, now);
      return {
        state: "graded",
        attemptId,
        attemptStatus: "graded",
        score: evaluation.score,
        passed: evaluation.passed,
        officialEvidenceRecorded: true,
        masteryAwarded: transition.masteryAwarded,
        progress: transition.progress,
        criticalGates: transition.unmetCriticalGates,
        remediation: {
          activeTags: transition.activeMisconceptionTags,
          confirmingProbeTags: transition.confirmingProbeTags,
        },
        feedback: practiceFeedbackFor(context.activity, evaluation, effectiveResponse),
        reviewDueAt: reviewDueAt?.toISOString() ?? null,
      };
    });
  }

  async revealNextPracticeHelp(input: {
    readonly userId: string;
    readonly attemptId: string;
    readonly requestId: string;
  }): Promise<PracticeHelpResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
      throw new LearningServiceError("INVALID_HELP_REQUEST_ID", "A valid help request id is required.");
    }
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      await transaction.lockPracticeHelpRequest(input.userId, input.requestId);
      const context = await transaction.lockAttempt(input.userId, input.attemptId);
      if (!context) throw new LearningServiceError("ATTEMPT_NOT_FOUND", "Learning attempt was not found.", 404);
      const replay = await transaction.getPracticeHelpEvent(input.userId, input.requestId);
      if (replay) {
        if (replay.attemptId !== input.attemptId) {
          throw new LearningServiceError("IDEMPOTENCY_CONFLICT", "Help request id was reused for another attempt.", 409);
        }
        const help = practiceHelpAt(context.activity, replay.step);
        if (!help || help.kind !== replay.kind || help.assistanceLevel !== replay.assistanceLevel) {
          throw new LearningServiceError("HELP_STATE_INVALID", "The persisted help step cannot be reproduced safely.", 503);
        }
        return {
          state: "ready",
          attemptId: input.attemptId,
          helpStep: replay.step,
          assistanceLevel: replay.assistanceLevel,
          solutionRevealed: replay.solutionRevealed,
          help: { kind: help.kind, content: help.content, answer: help.answer },
          requiresFreshAttempt: replay.solutionRevealed,
          idempotent: true,
        };
      }
      if (context.attempt.kind !== "practice") {
        throw new LearningServiceError("HELP_NOT_ALLOWED", "Progressive help is available only in practice attempts.", 409);
      }
      if (!["created", "in_progress"].includes(context.attempt.status)) {
        throw new LearningServiceError("ATTEMPT_NOT_SUBMITTABLE", "Closed attempts cannot reveal more help.", 409);
      }
      const help = practiceHelpAt(context.activity, context.attempt.helpStep + 1);
      if (!help) {
        return {
          state: "exhausted",
          attemptId: input.attemptId,
          helpStep: context.attempt.helpStep,
          assistanceLevel: context.attempt.assistanceLevel,
          solutionRevealed: context.attempt.solutionRevealed,
          help: null,
          requiresFreshAttempt: context.attempt.solutionRevealed,
          idempotent: false,
        };
      }
      const persisted = await transaction.recordPracticeHelp({
        id: deterministicUuid("practice-help-event", `${input.userId}:${input.requestId}`),
        attemptId: input.attemptId,
        userId: input.userId,
        requestId: input.requestId,
        expectedStep: context.attempt.helpStep,
        step: help.step,
        kind: help.kind,
        assistanceLevel: help.assistanceLevel,
        solutionRevealed: context.attempt.solutionRevealed || help.solutionRevealed,
        now,
      });
      if (!persisted) conflict("Practice help state");
      return {
        state: "ready",
        attemptId: input.attemptId,
        helpStep: persisted.attempt.helpStep,
        assistanceLevel: persisted.attempt.assistanceLevel,
        solutionRevealed: persisted.attempt.solutionRevealed,
        help: { kind: help.kind, content: help.content, answer: help.answer },
        requiresFreshAttempt: persisted.attempt.solutionRevealed,
        idempotent: false,
      };
    });
  }

  async recommendNext(userId: string, sessionId?: string): Promise<NextActionResult> {
    const snapshot = await this.store.transaction((transaction) =>
      transaction.getAdaptiveSnapshot(userId, sessionId),
    );
    const learningItems = snapshot.planItems.filter((item) => item.kind !== "diagnostic");
    if (!learningItems.length) {
      return { state: "empty", action: null, reason: "No current plan is available." };
    }
    if (learningItems.some((item) => item.languageContext === "dsa:unselected")) {
      return { state: "degraded", action: null, reason: "Choose a DSA implementation language before language-specific practice." };
    }
    const componentById = new Map<string, KnowledgeComponent>();
    for (const item of learningItems) {
      const existing = componentById.get(item.skillId);
      componentById.set(item.skillId, {
        id: item.skillId,
        prerequisites: item.prerequisites.map((skillId) => ({
          skillId,
          requiredAchievement: "PASSED" as const,
        })),
        goalPriority: Math.max(existing?.goalPriority ?? 0, item.goalPriority),
        prerequisiteCentrality: item.prerequisiteCentrality,
        optional: !item.required,
      });
    }
    const action = selectNextAction({
      components: [...componentById.values()],
      progress: snapshot.progress,
      reviewSchedules: snapshot.reviews,
      currentGoalSkillIds: new Set(learningItems.map((item) => item.skillId)),
      challengeAvailableSkillIds: new Set(learningItems.filter((item) => !item.required).map((item) => item.skillId)),
      nowMs: this.now().getTime(),
      session: snapshot.sessionCounts,
    });
    return { state: "ready", action };
  }

  async getDsaImplementationLanguage(userId: string): Promise<DsaLanguage | null> {
    return this.store.transaction(async (transaction) => {
      const enrollment = await transaction.getDsaEnrollment(userId);
      if (!enrollment) return null;

      if (enrollment.implementationLanguage?.trim()) {
        return normalizeDsaLanguage(enrollment.implementationLanguage);
      }

      const profile = await transaction.getPlanningProfile(userId);
      return normalizeDsaLanguage(profile?.dsaLanguage);
    });
  }

  async switchDsaLanguage(input: {
    readonly userId: string;
    readonly language: DsaLanguage;
    readonly idempotencyKey: string;
  }): Promise<DsaLanguageSwitchResult> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const normalized = normalizeDsaLanguage(input.language);
    if (!normalized) throw new LearningServiceError("INVALID_DSA_LANGUAGE", "Unsupported DSA language.");
    const [snapshot, index, graph] = await Promise.all([
      this.content.getSnapshot(),
      this.content.getIndex(),
      this.content.getGraph(),
    ]);
    const resolution = buildLearningPlan(snapshot, index, graph, ["dsa"], normalized);
    const baseDraft = resolution.drafts.find((draft) => draft.trackId === "dsa")!;
    const retestDraft = buildDsaLanguageRetestDraft(baseDraft, normalized);
    const now = this.now();
    return this.store.transaction(async (transaction) => {
      await transaction.lockDsaLanguageSwitch(input.userId);
      const enrollment = await transaction.getDsaEnrollment(input.userId);
      if (!enrollment) {
        return {
          state: "degraded",
          previousLanguage: null,
          language: normalized,
          revisionId: null,
          syntaxRetestSkillIds: [],
          preservedPriorEvidence: true,
          reason: "No published DSA enrollment is available.",
        };
      }
      const revisionId = deterministicUuid("dsa-language-plan", `${input.userId}:${key}`);
      const write = await transaction.writeDsaLanguageSwitch({
        userId: input.userId,
        enrollment,
        language: normalized,
        revisionId,
        idempotencyKey: key,
        plan: retestDraft.items,
        now,
      });
      if (write === "conflict") {
        throw new LearningServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The DSA language idempotency key was reused for different parameters.",
          409,
        );
      }
      if (write === "stale") conflict("DSA enrollment");
      if (write === "unchanged" || write === "replayed") {
        return {
          state: "unchanged",
          previousLanguage: enrollment.implementationLanguage,
          language: normalized,
          revisionId: write === "replayed" ? revisionId : enrollment.latestRevisionId,
          syntaxRetestSkillIds: retestDraft.items.filter((item) => item.kind === "syntax_retest").map((item) => item.skillId),
          preservedPriorEvidence: true,
        };
      }
      return {
        state: "updated",
        previousLanguage: enrollment.implementationLanguage,
        language: normalized,
        revisionId,
        syntaxRetestSkillIds: retestDraft.items.filter((item) => item.kind === "syntax_retest").map((item) => item.skillId),
        preservedPriorEvidence: true,
      };
    });
  }
}
