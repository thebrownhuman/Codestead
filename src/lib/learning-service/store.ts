import type {
  ActivityContext,
  AdaptiveSnapshot,
  AttemptContext,
  CoursePublication,
  DsaLanguage,
  LearningAttemptRecord,
  LearningPlanItem,
  LearningSessionRecord,
  MasteryBundle,
  MasteryTransition,
  PersistedPlan,
  PlanningProfile,
  PracticeHelpEventRecord,
  PracticeHelpKind,
  SessionEventRecord,
  SessionEventAuthority,
  SessionEventType,
  StoredReview,
  SubmissionInput,
  SupportedAttemptKind,
  TrackPlanDraft,
} from "./types";

export interface PlanPersistenceInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly draft: TrackPlanDraft;
  readonly publication: CoursePublication;
}

export interface SessionStartInput {
  readonly id: string;
  readonly userId: string;
  readonly enrollmentId: string | null;
  readonly goal: string;
  readonly plannedMinutes: number;
  readonly reviewOnly: boolean;
  readonly now: Date;
}

export interface SessionEventInput {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly clientEventId: string;
  readonly expectedRowVersion: number;
  readonly type: SessionEventType;
  readonly meaningful: boolean;
  readonly authority: SessionEventAuthority;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly clientTime: Date | null;
  readonly now: Date;
}

export interface AttemptCreateInput {
  readonly id: string;
  readonly userId: string;
  readonly activity: ActivityContext;
  readonly kind: SupportedAttemptKind;
  readonly now: Date;
}

export interface AttemptGradeInput {
  readonly attemptId: string;
  readonly userId: string;
  readonly score: number;
  readonly passed: boolean;
  readonly masteryAwarded: boolean;
  readonly now: Date;
}

export interface PracticeHelpWriteInput {
  readonly id: string;
  readonly attemptId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly expectedStep: number;
  readonly step: number;
  readonly kind: PracticeHelpKind;
  readonly assistanceLevel: "A1" | "A2" | "A3" | "A4";
  readonly solutionRevealed: boolean;
  readonly now: Date;
}

export interface MasteryWriteInput {
  readonly userId: string;
  readonly attempt: AttemptContext;
  readonly transition: MasteryTransition;
  readonly evidenceType: string;
  readonly evidenceSourceType: "deterministic_attempt" | "verified_runner";
  readonly evidenceSourceId: string;
  readonly evidenceWeight: number;
  readonly now: Date;
  readonly expectedRowVersion: number | null;
}

export interface ReviewWriteInput {
  readonly userId: string;
  readonly attempt: AttemptContext;
  readonly previous: StoredReview | null;
  readonly dueAt: Date;
  readonly intervalDays: number;
  readonly reason: string;
  readonly now: Date;
}

export interface DsaEnrollmentRecord {
  readonly enrollmentId: string;
  readonly courseVersionId: string;
  readonly courseVersion: string;
  readonly implementationLanguage: string | null;
  readonly latestRevisionId: string | null;
  readonly latestRevision: number;
  readonly latestPlan: readonly LearningPlanItem[];
}

export interface DsaLanguageWriteInput {
  readonly userId: string;
  readonly enrollment: DsaEnrollmentRecord;
  readonly language: DsaLanguage;
  readonly revisionId: string;
  readonly idempotencyKey: string;
  readonly plan: readonly LearningPlanItem[];
  readonly now: Date;
}

export interface LearningTransaction {
  /** Serialize one learner's plan initialization before any check-then-insert work. */
  lockPlanInitialization(userId: string): Promise<void>;
  getPlanningProfile(userId: string): Promise<PlanningProfile | null>;
  getCoursePublications(trackIds: readonly string[]): Promise<readonly CoursePublication[]>;
  persistPlan(input: PlanPersistenceInput): Promise<PersistedPlan>;

  /** Serialize deterministic session replay and the one-active-session check. */
  lockSessionStart(userId: string): Promise<void>;
  getActiveSession(userId: string): Promise<LearningSessionRecord | null>;
  getSession(userId: string, sessionId: string): Promise<LearningSessionRecord | null>;
  insertSession(input: SessionStartInput): Promise<LearningSessionRecord>;
  updateSession(
    userId: string,
    sessionId: string,
    expectedRowVersion: number,
    update: {
      readonly status: string;
      readonly lastActivityAt: Date;
      readonly endedAt?: Date | null;
    },
  ): Promise<LearningSessionRecord | null>;
  getSessionEvent(userId: string, clientEventId: string): Promise<SessionEventRecord | null>;
  /**
   * Requires an active owner enrollment on the current reviewed publication
   * and valid, passed, A0 graded attempt evidence for every lesson concept.
   */
  isLessonCompletionAuthorized(
    userId: string,
    enrollmentId: string,
    lessonId: string,
  ): Promise<boolean>;
  insertSessionEvent(input: SessionEventInput): Promise<SessionEventRecord>;
  touchMeaningfulActivity(userId: string, occurredAt: Date): Promise<void>;

  /** Serialize a deterministic request id before checking or creating its attempt. */
  lockAttemptCreation(userId: string, attemptId: string): Promise<void>;
  resolveActivity(
    userId: string,
    skillId: string,
    kind: SupportedAttemptKind,
    variantSeed: string,
  ): Promise<ActivityContext | null>;
  getAttempt(userId: string, attemptId: string): Promise<AttemptContext | null>;
  lockPracticeHelpRequest(userId: string, requestId: string): Promise<void>;
  lockAttempt(userId: string, attemptId: string): Promise<AttemptContext | null>;
  getPracticeHelpEvent(userId: string, requestId: string): Promise<PracticeHelpEventRecord | null>;
  recordPracticeHelp(input: PracticeHelpWriteInput): Promise<{
    readonly attempt: LearningAttemptRecord;
    readonly event: PracticeHelpEventRecord;
  } | null>;
  insertAttempt(input: AttemptCreateInput): Promise<LearningAttemptRecord>;
  insertResponseIfAbsent(
    attemptId: string,
    input: SubmissionInput,
  ): Promise<boolean>;
  markAttemptSubmitted(
    userId: string,
    attemptId: string,
    submittedAt: Date,
  ): Promise<boolean>;
  gradeAttempt(input: AttemptGradeInput): Promise<boolean>;
  getVerifiedRunnerResult(attemptId: string): Promise<unknown | null>;

  getMasteryBundle(context: AttemptContext): Promise<MasteryBundle>;
  appendOfficialEvidence(input: MasteryWriteInput): Promise<boolean>;
  writeMastery(input: MasteryWriteInput): Promise<boolean>;
  writeReview(input: ReviewWriteInput): Promise<StoredReview>;

  getAdaptiveSnapshot(userId: string, sessionId?: string): Promise<AdaptiveSnapshot>;
  /** Serialize DSA language snapshots and their immutable plan revisions. */
  lockDsaLanguageSwitch(userId: string): Promise<void>;
  getDsaEnrollment(userId: string): Promise<DsaEnrollmentRecord | null>;
  writeDsaLanguageSwitch(input: DsaLanguageWriteInput): Promise<
    "written" | "replayed" | "unchanged" | "conflict" | "stale"
  >;
}

export interface LearningStore {
  transaction<T>(work: (transaction: LearningTransaction) => Promise<T>): Promise<T>;
}
