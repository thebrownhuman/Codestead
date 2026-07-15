export {
  BLUEPRINT_RESPONSE_KEY,
  EXAM_POLICY_VERSION,
  RESULT_RESPONSE_KEY,
} from "@/lib/exams/constants";

export const SUPPORTED_EXAM_LANGUAGES = [
  "c",
  "cpp",
  "java",
  "python",
  "javascript",
] as const;

export type ExamLanguage = (typeof SUPPORTED_EXAM_LANGUAGES)[number];
export type ExamItemKind = "short-answer" | "code";

export interface ExamRunnerTest {
  readonly id: string;
  readonly visibility: "VISIBLE" | "HIDDEN";
  readonly category: string;
  readonly stdin: string;
  readonly expectedStdout: string;
  readonly comparison: "EXACT" | "TRIMMED";
  readonly critical: boolean;
}

export type ExamGradingEvidence =
  | {
      readonly kind: "exact-answer";
      readonly acceptedAnswers: readonly string[];
      readonly caseSensitive: boolean;
    }
  | {
      readonly kind: "runner-tests";
      readonly bundleVersion: string;
      readonly tests: readonly ExamRunnerTest[];
    }
  | {
      readonly kind: "pending-review";
      readonly reason: string;
    };

export interface ExamItem {
  readonly id: string;
  readonly skillId: string;
  readonly clusterId: string;
  readonly title: string;
  readonly prompt: string;
  readonly kind: ExamItemKind;
  readonly points: number;
  readonly critical: boolean;
  readonly language?: ExamLanguage;
  readonly starterCode?: string;
  readonly runtime?: {
    readonly version: string;
    readonly imageDigest: string;
  };
  readonly gradingEvidence: ExamGradingEvidence;
}

export interface ExamIntegrityDisclosure {
  readonly version: string;
  readonly summary: string;
  readonly capturedEvents: readonly string[];
  readonly notCaptured: readonly string[];
}

export interface ExamFormSnapshot {
  readonly schemaVersion: 1;
  /** Omitted by legacy snapshots; new forms always persist an explicit purpose. */
  readonly purpose?: "formal-exam" | "mastery-recheck";
  readonly formId: string;
  readonly seed: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly moduleId: string;
  readonly moduleTitle: string;
  readonly contentVersion: string;
  readonly policyVersion: string;
  readonly durationMinutes: number;
  readonly generatedAt: string;
  readonly instructions: readonly string[];
  readonly integrityDisclosure: ExamIntegrityDisclosure;
  readonly items: readonly ExamItem[];
}

export interface PublicExamItem extends Omit<ExamItem, "gradingEvidence"> {
  readonly verificationAvailable: boolean;
}

export interface PublicExamForm extends Omit<ExamFormSnapshot, "items" | "seed"> {
  readonly items: readonly PublicExamItem[];
}

export interface ExamAnswer {
  readonly text?: string;
  readonly sourceCode?: string;
  readonly language?: ExamLanguage;
}

export interface SavedExamAnswer {
  readonly revision: number;
  readonly answer: ExamAnswer;
  readonly savedAt: string;
}

export type SavedExamAutosaveResult = SavedExamAnswer & {
  readonly clientMutationId: string;
  readonly replayed: boolean;
};

export interface RunnerCompileResult {
  readonly status:
    | "OK"
    | "COMPILE_ERROR"
    | "TIMEOUT"
    | "MEMORY_LIMIT"
    | "OUTPUT_LIMIT"
    | "INFRASTRUCTURE_ERROR";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallTimeMs: number;
}

export interface ExamRunnerResult {
  readonly status:
    | "COMPILE_ONLY"
    | "ACCEPTED"
    | "WRONG_ANSWER"
    | "COMPILE_ERROR"
    | "RUNTIME_ERROR"
    | "TIMEOUT"
    | "MEMORY_LIMIT"
    | "OUTPUT_LIMIT"
    | "INFRASTRUCTURE_ERROR";
  readonly requestHash: string;
  readonly sourceHash: string;
  readonly runtimeVersion: string;
  readonly imageDigest: string;
  readonly testBundleVersion?: string;
  readonly compile: RunnerCompileResult;
  readonly run?: {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly wallTimeMs: number;
  };
  readonly tests: readonly {
    readonly id: string;
    readonly visibility: "VISIBLE" | "HIDDEN";
    readonly category: string;
    readonly status:
      | "PASSED"
      | "FAILED"
      | "RUNTIME_ERROR"
      | "TIMEOUT"
      | "MEMORY_LIMIT"
      | "OUTPUT_LIMIT"
      | "INFRASTRUCTURE_ERROR";
    readonly feedbackCode: string;
    readonly exitCode: number | null;
    readonly wallTimeMs: number;
    readonly actualStdout?: string;
    readonly expectedStdout?: string;
    readonly stderr?: string;
  }[];
  readonly totals: { readonly passed: number; readonly failed: number; readonly total: number };
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type ExamFinalizationReason = "learner-submit" | "deadline";
export type ExamResultOutcome = "NOT_PASSED" | "PASSED" | "MASTERED" | "PENDING_REVIEW";

export interface ExamResult {
  readonly schemaVersion: 1;
  readonly gradingStatus: "graded" | "pending-review";
  readonly outcome: ExamResultOutcome;
  /** Null unless every item has deterministic authored answer/test evidence. */
  readonly officialScorePercent: number | null;
  readonly earnedPoints: number | null;
  readonly possiblePoints: number;
  readonly pendingReviewItemIds: readonly string[];
  readonly failedCriticalClusters: readonly string[];
  readonly masteryBlockingCodingItems: readonly string[];
  readonly compilationGatePassed: boolean | null;
  readonly infrastructureFailure: boolean;
  readonly finalizedAt: string;
  readonly finalizedBy: ExamFinalizationReason;
  readonly policyVersion: string;
  readonly remediation: {
    readonly required: boolean;
    readonly targets: readonly string[];
  };
  /** Optional for backward-compatible reads of results finalized before EXM-008. */
  readonly masteryRecheck?: {
    readonly required: boolean;
    readonly clusterIds: readonly string[];
    readonly codingItemIds: readonly string[];
  };
}
export type ExamSessionStatus =
  | "scheduled"
  | "active"
  | "paused_by_system"
  | "submitted"
  | "expired"
  | "graded"
  | "under_review"
  | "invalidated";

export interface RetakeEligibility {
  readonly eligible: boolean;
  readonly reason:
    | "first-attempt"
    | "technical-incident"
    | "admin-reexam-grant"
    | "cooldown"
    | "remediation-required"
    | "pending-review"
    | "already-mastered"
    | "eligible";
  readonly nextEligibleAt: string | null;
  readonly requiresRemediation: boolean;
}

export interface ExamSessionView {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly status: ExamSessionStatus;
  readonly serverNow: string;
  readonly serverStartedAt: string;
  readonly serverDeadlineAt: string;
  readonly disconnectedSeconds: number;
  readonly integrityReviewState: string;
  readonly form: PublicExamForm;
  readonly answers: Readonly<Record<string, SavedExamAnswer>>;
  readonly result: ExamResult | null;
  readonly retake: RetakeEligibility | null;
  readonly appealSubmitted: boolean;
  readonly appeal: null | {
    readonly id: string;
    readonly status: string;
    readonly decision: string | null;
    readonly decisionReason: string | null;
    readonly updatedAt: string;
  };
}

export interface ExamCatalogEntry {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly moduleId: string;
  readonly moduleTitle: string;
  readonly summary: string;
  readonly skillCount: number;
  readonly durationMinutes: number;
  readonly readiness: "available" | "resume" | "pending-review" | "passed" | "mastered" | "remediation";
  readonly activeSessionId: string | null;
  readonly latestResult: ExamResult | null;
  readonly retake: RetakeEligibility;
  readonly masteryRecheck: null | {
    readonly id: string;
    readonly status: "scheduled" | "available" | "active" | "completed";
    readonly dueAt: string;
    readonly targetCount: number;
    readonly durationMinutes: number;
    readonly activeSessionId: string | null;
    readonly priorPassProtected: true;
  };
}

export const CLIENT_EXAM_EVENT_TYPES = [
  "window_blur",
  "window_focus",
  "visibility_hidden",
  "visibility_visible",
  "paste",
  "fullscreen_exit",
  "fullscreen_enter",
  "navigation_attempt",
  "connection_lost",
  "connection_restored",
] as const;

export type ClientExamEventType = (typeof CLIENT_EXAM_EVENT_TYPES)[number];

export function toPublicExamForm(form: ExamFormSnapshot): PublicExamForm {
  const { items, ...formWithSeed } = form;
  const publicForm = { ...formWithSeed } as Omit<ExamFormSnapshot, "items" | "seed"> & {
    seed?: string;
  };
  delete publicForm.seed;
  return {
    ...publicForm,
    items: items.map(({ gradingEvidence, ...item }) => ({
      ...item,
      verificationAvailable: gradingEvidence.kind !== "pending-review",
    })),
  };
}
