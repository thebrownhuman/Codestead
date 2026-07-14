import type {
  AssistanceLevel,
  EvidenceLevel,
  EvidenceObservation,
  LearningStage,
  SkillProgress,
} from "@/lib/domain";

export const LEARNING_POLICY_VERSION = "adaptive-learning-v1";
export const LEARNING_PLAN_SCHEMA_VERSION = 1;

export type SupportedAttemptKind =
  | "diagnostic"
  | "practice"
  | "quiz"
  | "game"
  | "mastery_check";

export type DsaLanguage = "C" | "C++" | "Java" | "Python";
export type LearningPlanItemKind = "diagnostic" | "learn" | "syntax_retest";

export interface LearningPlanItem extends Record<string, unknown> {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: LearningPlanItemKind;
  readonly trackId: string;
  readonly courseVersion: string;
  readonly moduleId: string;
  readonly skillId: string;
  readonly title: string;
  readonly position: number;
  readonly required: boolean;
  readonly prerequisites: readonly string[];
  readonly evidenceTypes: readonly string[];
  readonly languageContext: string;
  readonly goalPriority: number;
  readonly prerequisiteCentrality: number;
}

export interface TrackPlanDraft {
  readonly trackId: string;
  readonly manifestVersion: string;
  readonly implementationLanguage: DsaLanguage | null;
  readonly prerequisiteTrackIds: readonly string[];
  readonly items: readonly LearningPlanItem[];
}

export interface PlanResolution {
  readonly selectedTrackIds: readonly string[];
  readonly resolvedTrackIds: readonly string[];
  readonly drafts: readonly TrackPlanDraft[];
  readonly warnings: readonly string[];
}

export interface PlanningProfile {
  readonly selectedTrackIds: readonly string[];
  readonly dsaLanguage: string | null;
  readonly selfReportedLevel: string;
}

export interface CoursePublication {
  readonly trackId: string;
  readonly courseVersionId: string;
  readonly version: string;
  readonly stage: string;
}

export interface PersistedPlan {
  readonly enrollmentId: string;
  readonly trackId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly idempotent: boolean;
}

export interface PlanInitializationResult {
  readonly state: "ready" | "degraded" | "empty";
  readonly plans: readonly PersistedPlan[];
  readonly selectedTrackIds: readonly string[];
  readonly resolvedTrackIds: readonly string[];
  readonly missingPublications: readonly string[];
  readonly warnings: readonly string[];
  readonly placement: {
    readonly required: true;
    readonly selfReportUsedAsEvidence: false;
    readonly reason: string;
  };
}

export interface LearningSessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly enrollmentId: string | null;
  readonly goal: string;
  readonly plannedMinutes: number;
  readonly reviewOnly: boolean;
  readonly status: string;
  readonly startedAt: Date;
  readonly lastActivityAt: Date;
  readonly endedAt: Date | null;
  readonly rowVersion: number;
}

export type SessionEventType =
  | "heartbeat"
  | "lesson_viewed"
  | "hint_requested"
  | "code_run"
  | "lesson_completed"
  | "attempt_submitted"
  | "review_completed"
  | "remediation_recovered"
  | "project_milestone";

/** Server-issued only after the lesson, enrollment, publication, and owner bind. */
export const LESSON_COMPLETION_AUTHORITY = "lesson_enrollment_binding.v1" as const;
export type SessionEventAuthority = typeof LESSON_COMPLETION_AUTHORITY | null;

export interface SessionEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly clientEventId: string;
  readonly type: SessionEventType;
  readonly meaningful: boolean;
  readonly authority: SessionEventAuthority;
  readonly occurredAt: Date;
}

export interface SessionMutationResult {
  readonly session: LearningSessionRecord;
  readonly idempotent?: boolean;
  readonly resumed?: boolean;
}

export interface ActivityContext {
  readonly activityId: string;
  readonly activitySlug: string;
  readonly activityType: string;
  readonly specification: Readonly<Record<string, unknown>>;
  readonly skillId: string;
  readonly conceptId: string;
  readonly enrollmentId: string;
  readonly courseVersion: string;
  readonly trackId: string;
  readonly implementationLanguage: string | null;
  readonly languageContext: string;
}

export interface LearningAttemptRecord {
  readonly id: string;
  readonly userId: string;
  readonly activityId: string;
  readonly enrollmentId: string;
  readonly kind: SupportedAttemptKind;
  readonly attemptNumber: number;
  readonly status: string;
  readonly policyVersion: string;
  readonly contentVersion: string;
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly masteryAwarded: boolean;
  readonly infrastructureFailure: boolean;
  readonly assistanceLevel: AssistanceLevel;
  readonly solutionRevealed: boolean;
  readonly helpStep: number;
  readonly startedAt: Date | null;
  readonly submittedAt: Date | null;
  readonly gradedAt: Date | null;
}

export type PracticeHelpKind = "hint" | "alternate" | "example" | "solution";

export interface PracticeHelpEventRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly step: number;
  readonly kind: PracticeHelpKind;
  readonly assistanceLevel: AssistanceLevel;
  readonly solutionRevealed: boolean;
  readonly createdAt: Date;
}

export interface PracticeHelpResult {
  readonly state: "ready" | "exhausted";
  readonly attemptId: string;
  readonly helpStep: number;
  readonly assistanceLevel: AssistanceLevel;
  readonly solutionRevealed: boolean;
  readonly help: {
    readonly kind: PracticeHelpKind;
    readonly content: string;
    readonly answer: string | null;
  } | null;
  readonly requiresFreshAttempt: boolean;
  readonly idempotent: boolean;
}

export interface AttemptContext {
  readonly attempt: LearningAttemptRecord;
  readonly activity: ActivityContext;
}

export interface AttemptCreationResult {
  readonly state: "ready" | "degraded";
  readonly attempt: LearningAttemptRecord | null;
  readonly activity: ActivityContext | null;
  readonly idempotent: boolean;
  readonly reason?: "activity_unavailable" | "publication_unavailable" | "activity_unsupported";
}

export interface DeterministicEvaluation {
  readonly state: "graded";
  readonly origin: "deterministic_spec" | "verified_runner";
  readonly score: number;
  readonly passed: boolean;
  readonly correct: boolean;
  readonly misconceptionTags: readonly string[];
}

export interface UnavailableEvaluation {
  readonly state: "unavailable";
  readonly reason:
    | "grader_not_configured"
    | "unsupported_grader"
    | "runner_not_complete"
    | "invalid_grader_specification";
}

export type AttemptEvaluation = DeterministicEvaluation | UnavailableEvaluation;

export interface SubmissionInput {
  readonly itemKey: string;
  readonly responseRevision: number;
  readonly answer: Readonly<Record<string, unknown>>;
  readonly assistanceLevel: AssistanceLevel;
  readonly solutionRevealed: boolean;
  readonly submittedAt: Date;
}

export interface PracticeFeedback {
  readonly correct: boolean;
  readonly headline: string;
  readonly why: string;
  readonly misconceptionTags: readonly string[];
  readonly remediation: readonly {
    readonly tag: string;
    readonly explanation: string;
    readonly retryPrompt: string;
  }[];
  readonly independent: boolean;
  readonly assistanceLevel: AssistanceLevel;
  readonly solutionRevealed: boolean;
  readonly solution: {
    readonly answer: string;
    readonly explanation: string;
  } | null;
  readonly nextAction: "continue" | "retry_fresh";
}

export interface AttemptSubmissionResult {
  readonly state: "graded" | "degraded";
  readonly attemptId: string;
  readonly attemptStatus: string;
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly officialEvidenceRecorded: boolean;
  readonly masteryAwarded: boolean;
  readonly progress: SkillProgress | null;
  readonly criticalGates: readonly string[];
  readonly remediation: {
    readonly activeTags: readonly string[];
    readonly confirmingProbeTags: readonly string[];
  };
  readonly feedback: PracticeFeedback | null;
  readonly reviewDueAt: string | null;
  readonly degradedReason?: UnavailableEvaluation["reason"];
  readonly idempotent?: boolean;
}

export interface StoredMastery {
  readonly userId: string;
  readonly enrollmentId: string;
  readonly conceptId: string;
  readonly skillId: string;
  readonly languageContext: string;
  readonly score: number;
  readonly confidence: number;
  readonly status: string;
  readonly criticalRequirementsMet: boolean;
  readonly lastEvidenceAt: Date | null;
  readonly lastPracticedAt: Date | null;
  readonly nextReviewAt: Date | null;
  readonly rowVersion: number;
}

export interface StoredEvidence {
  readonly id: string;
  readonly skillId: string;
  readonly enrollmentId: string;
  readonly conceptId: string;
  readonly languageContext: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly evidenceType: string;
  readonly score: number;
  readonly weight: number;
  readonly criticalCriterion: string | null;
  readonly validity: string;
  readonly recordedBy: string | null;
  readonly recordedAt: Date;
}

export interface StoredReview {
  readonly id: string;
  readonly userId: string;
  readonly enrollmentId: string;
  readonly conceptId: string;
  readonly skillId: string;
  readonly languageContext: string;
  readonly dueAt: Date;
  readonly intervalDays: number;
  readonly reason: string;
  readonly status: string;
}

export interface MasteryBundle {
  readonly mastery: StoredMastery | null;
  readonly evidence: readonly StoredEvidence[];
  readonly activeReview: StoredReview | null;
}

export interface MasteryTransition {
  readonly observation: EvidenceObservation;
  readonly progress: SkillProgress;
  readonly databaseStatus: string;
  readonly confidence: number;
  readonly criticalRequirementsMet: boolean;
  readonly unmetCriticalGates: readonly string[];
  readonly activeMisconceptionTags: readonly string[];
  readonly confirmingProbeTags: readonly string[];
  readonly masteryAwarded: boolean;
  readonly evidenceType: string;
  readonly reviewOutcome: "CLEAN" | "ASSISTED" | "FAILED" | null;
  readonly createInitialReview: boolean;
}

export interface AdaptiveSnapshot {
  readonly planItems: readonly LearningPlanItem[];
  readonly progress: readonly SkillProgress[];
  readonly reviews: readonly {
    readonly skillId: string;
    readonly intervalIndex: number;
    readonly intervalDays: number;
    readonly dueAtMs: number;
    readonly lastReviewedAtMs?: number;
    readonly successfulReviews: number;
    readonly lapses: number;
  }[];
  readonly sessionCounts: {
    readonly completedActions: number;
    readonly reviewActions: number;
    readonly reviewOnly?: boolean;
  };
}

export interface NextActionResult {
  readonly state: "ready" | "empty" | "degraded";
  readonly action: {
    readonly kind: string;
    readonly skillId?: string;
    readonly reason: string;
    readonly priorityScore: number;
  } | null;
  readonly reason?: string;
}

export interface DsaLanguageSwitchResult {
  readonly state: "updated" | "unchanged" | "degraded";
  readonly previousLanguage: string | null;
  readonly language: DsaLanguage;
  readonly revisionId: string | null;
  readonly syntaxRetestSkillIds: readonly string[];
  readonly preservedPriorEvidence: true;
  readonly reason?: string;
}

export interface EvidenceEnvelopeV1 {
  readonly version: 1;
  readonly origin: DeterministicEvaluation["origin"];
  readonly skillId: string;
  readonly itemVariantId: string;
  readonly evidenceLevel: EvidenceLevel;
  readonly assistanceLevel: AssistanceLevel;
  readonly correct: boolean;
  readonly learningOpportunity: boolean;
  readonly solutionRevealed: boolean;
  readonly misconceptionTags: readonly string[];
  readonly languageContext: string;
}

export interface PersistMasteryInput {
  readonly attempt: AttemptContext;
  readonly response: SubmissionInput;
  readonly evaluation: DeterministicEvaluation;
  readonly transition: MasteryTransition;
  readonly evidenceEnvelope: EvidenceEnvelopeV1;
  readonly now: Date;
}

export interface AdaptiveProgressRecord {
  readonly skillId: string;
  readonly languageContext: string;
  readonly stage: LearningStage;
  readonly masteryProbability: number;
  readonly evidence: readonly EvidenceObservation[];
}

export class LearningServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "LearningServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
