export const AUTHORED_CONTENT_SCHEMA_VERSION = "1.0.0" as const;

export const PUBLICATION_STAGES = [
  "draft",
  "in-review",
  "approved",
  "published",
  "retired",
] as const;
export type PublicationStage = (typeof PUBLICATION_STAGES)[number];

export interface ContentContributor {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "human" | "ai-assisted";
}

export interface ContentReviewer {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "human";
  readonly reviewedAt: string;
  readonly reviewVersion: string;
}

export interface PublicationRecord {
  readonly stage: PublicationStage;
  readonly author: ContentContributor;
  readonly authoredAt: string;
  readonly aiAssisted: boolean;
  readonly reviewer: ContentReviewer | null;
  readonly changeSummary: string;
}

export interface AuthoredSourceCitation {
  readonly sourceRef: string;
  readonly locator: string;
  readonly claim: string;
}

export interface AuthoredLessonExample {
  readonly id: string;
  readonly title: string;
  readonly situation: string;
  readonly walkthrough: readonly string[];
  readonly result: string;
}

export interface AuthoredLessonMisconception {
  readonly id: string;
  readonly mistakenBelief: string;
  readonly correction: string;
  readonly diagnosticPrompt: string;
}

export interface AuthoredTraceStep {
  readonly step: number;
  readonly focus: string;
  readonly state: Readonly<Record<string, string>>;
  readonly explanation: string;
}

export interface AuthoredPracticePrompt {
  readonly prompt: string;
  readonly scaffold: readonly string[];
  readonly expectedEvidence: readonly string[];
}

export interface AuthoredLesson {
  readonly $schema: string;
  readonly format: "authored-lesson";
  readonly schemaVersion: typeof AUTHORED_CONTENT_SCHEMA_VERSION;
  readonly id: string;
  readonly courseId: string;
  readonly courseVersion: string;
  readonly moduleId: string;
  readonly skillId: string;
  readonly title: string;
  readonly publication: PublicationRecord;
  readonly sources: readonly AuthoredSourceCitation[];
  readonly canonicalExplanation: {
    readonly summary: string;
    readonly sections: readonly { readonly heading: string; readonly body: string }[];
  };
  readonly scope: {
    readonly includes: readonly string[];
    readonly excludes: readonly string[];
  };
  readonly outcomes: readonly string[];
  readonly examples: readonly AuthoredLessonExample[];
  readonly misconceptions: readonly AuthoredLessonMisconception[];
  readonly analogy: {
    readonly optional: true;
    readonly example: string;
    readonly usefulFor: readonly string[];
    readonly limitations: readonly string[];
    readonly canonicalExplanationStandsAlone: true;
  };
  readonly trace: {
    readonly artifact: readonly string[];
    readonly steps: readonly AuthoredTraceStep[];
    readonly textAlternative: string;
  };
  readonly practice: {
    readonly faded: AuthoredPracticePrompt;
    readonly nearTransfer: AuthoredPracticePrompt;
    readonly farTransfer: AuthoredPracticePrompt;
  };
  readonly remediation: readonly {
    readonly misconceptionId: string;
    readonly explanation: string;
    readonly retryPrompt: string;
  }[];
  readonly recap: {
    readonly summary: string;
    readonly retrievalPrompts: readonly string[];
    readonly nextReviewPrompt: string;
  };
}

export const ASSESSMENT_ITEM_KINDS = ["mcq", "trace", "fill-gap", "code"] as const;
export type AssessmentItemKind = (typeof ASSESSMENT_ITEM_KINDS)[number];
export type AssessmentEvidenceLevel = "recall" | "interpret" | "apply" | "transfer";

export interface AssessmentRubric {
  readonly passPoints: number;
  readonly criteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly points: number;
    readonly critical: boolean;
  }[];
}

/**
 * Private deterministic wrong-answer evidence. It is reviewed with the bank,
 * used only by the server-side grader, and removed from learner payloads.
 */
export interface AssessmentMisconceptionMapping {
  readonly tag: string;
  readonly answers: readonly string[];
}

interface AssessmentItemBase {
  readonly id: string;
  readonly skillId: string;
  readonly title: string;
  readonly kind: AssessmentItemKind;
  readonly prompt: string;
  readonly points: number;
  readonly evidenceLevel: AssessmentEvidenceLevel;
  readonly examEligibility: {
    readonly eligible: boolean;
    readonly rationale: string;
  };
  readonly hints: readonly string[];
  readonly feedback: {
    readonly correct: string;
    readonly incorrect: string;
  };
  readonly rubric: AssessmentRubric;
  readonly privateAuthorNotes: readonly string[];
  readonly misconceptionMappings?: readonly AssessmentMisconceptionMapping[];
}

export interface McqAssessmentItem extends AssessmentItemBase {
  readonly kind: "mcq";
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly answer: {
    readonly correctOptionIds: readonly string[];
    readonly explanation: string;
  };
}

export interface TraceAssessmentItem extends AssessmentItemBase {
  readonly kind: "trace";
  readonly artifact: readonly string[];
  readonly answer: {
    readonly acceptedTraces: readonly string[];
    readonly caseSensitive: boolean;
    readonly explanation: string;
  };
}

export interface FillGapAssessmentItem extends AssessmentItemBase {
  readonly kind: "fill-gap";
  readonly template: string;
  readonly gaps: readonly { readonly id: string; readonly label: string }[];
  readonly answer: {
    readonly acceptedByGap: Readonly<Record<string, readonly string[]>>;
    readonly caseSensitive: boolean;
    readonly explanation: string;
  };
}

export interface AssessmentRunnerTest {
  readonly id: string;
  readonly visibility: "visible" | "hidden";
  readonly category: "normal" | "boundary" | "invalid" | "performance";
  readonly stdin: string;
  readonly expectedStdout: string;
  readonly comparison: "exact" | "trimmed";
  readonly critical: boolean;
}

export interface CodeAssessmentItem extends AssessmentItemBase {
  readonly kind: "code";
  readonly starterCode: string;
  readonly runtime:
    | {
        readonly engine: "isolated-runner";
        readonly language: "c" | "cpp" | "java" | "python" | "javascript";
        readonly version: string;
        readonly imageDigest?: string;
        readonly entrypoint: string;
        readonly timeLimitMs: number;
        readonly memoryLimitMb: number;
        readonly browser?: never;
        readonly bundler?: never;
      }
    | {
        /** Authoring-time browser evidence only; never routed to the untrusted-code runner. */
        readonly engine: "browser-verifier";
        readonly language: "html" | "css" | "javascript" | "react";
        readonly version: string;
        readonly imageDigest?: never;
        readonly entrypoint: string;
        readonly timeLimitMs: number;
        readonly memoryLimitMb: number;
        readonly browser: {
          readonly name: "chromium";
          readonly revision: string;
          readonly version: string;
          readonly playwrightVersion: string;
        };
        readonly bundler?: {
          readonly name: "esbuild";
          readonly version: string;
        };
      };
  readonly parity?: {
    readonly parityId: string;
    readonly contractVersion: string;
    readonly language: "c" | "cpp" | "java" | "python";
    readonly equivalentLanguages: readonly ["c", "cpp", "java", "python"];
    readonly testContractHash: string;
    readonly facet: "executable-contract";
  };
  readonly tests: readonly AssessmentRunnerTest[];
  readonly answer: {
    readonly referenceSolution: string;
    readonly explanation: string;
  };
}

export type DeterministicAssessmentItem =
  | McqAssessmentItem
  | TraceAssessmentItem
  | FillGapAssessmentItem
  | CodeAssessmentItem;

export interface AssessmentBank {
  readonly $schema: string;
  readonly format: "assessment-bank";
  readonly schemaVersion: typeof AUTHORED_CONTENT_SCHEMA_VERSION;
  readonly id: string;
  readonly courseId: string;
  readonly courseVersion: string;
  readonly moduleId: string;
  readonly skillId: string;
  readonly title: string;
  readonly publication: PublicationRecord;
  readonly sourceRefs: readonly string[];
  readonly items: readonly DeterministicAssessmentItem[];
}

export type LearnerAssessmentItem =
  | Omit<McqAssessmentItem, "answer" | "rubric" | "feedback" | "privateAuthorNotes" | "misconceptionMappings">
  | Omit<TraceAssessmentItem, "answer" | "rubric" | "feedback" | "privateAuthorNotes" | "misconceptionMappings">
  | Omit<FillGapAssessmentItem, "answer" | "rubric" | "feedback" | "privateAuthorNotes" | "misconceptionMappings">
  | (Omit<CodeAssessmentItem, "answer" | "rubric" | "feedback" | "privateAuthorNotes" | "misconceptionMappings" | "tests"> & {
      readonly tests: readonly AssessmentRunnerTest[];
    });

export interface LearnerAssessmentBank {
  readonly id: string;
  readonly schemaVersion: typeof AUTHORED_CONTENT_SCHEMA_VERSION;
  readonly courseId: string;
  readonly moduleId: string;
  readonly skillId: string;
  readonly title: string;
  readonly provenance: {
    readonly stage: PublicationStage;
    readonly aiAssisted: boolean;
    readonly reviewRequired: boolean;
  };
  readonly items: readonly LearnerAssessmentItem[];
}

export interface AuthoredContentSet {
  readonly lessons: readonly AuthoredLesson[];
  readonly assessmentBanks: readonly AssessmentBank[];
}
