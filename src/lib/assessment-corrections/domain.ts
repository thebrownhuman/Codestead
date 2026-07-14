import type {
  ExamAnswer,
  ExamFormSnapshot,
  ExamGradingEvidence,
  ExamResult,
  ExamRunnerResult,
} from "@/lib/exams/contracts";
import { hashAppealEvidence } from "@/lib/appeals/evidence";

import {
  replacementEvidenceSchema,
  type CorrectionReview,
  type ReplacementEvidence,
} from "./contracts";

export interface CorrectionTarget {
  readonly courseId: string;
  readonly moduleId: string;
  readonly itemId: string;
  readonly skillId: string;
  readonly contentVersion: string;
  readonly faultyBundleVersion: string;
  readonly faultyEvidenceHash: string;
  readonly hadHiddenTests: boolean;
}

export class AssessmentCorrectionError extends Error {
  constructor(
    public readonly code:
      | "ADMIN_REQUIRED"
      | "APPEAL_NOT_FOUND"
      | "APPEAL_NOT_OVERTURNED"
      | "EXAM_EVIDENCE_MISSING"
      | "ITEM_NOT_FOUND"
      | "ITEM_NOT_DETERMINISTIC"
      | "REPLACEMENT_VERSION_REUSED"
      | "HIDDEN_TEST_COVERAGE_REMOVED"
      | "NO_AFFECTED_ATTEMPTS"
      | "AFFECTED_ATTEMPT_LIMIT_EXCEEDED"
      | "CORRECTION_NOT_FOUND"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_MISMATCH"
      | "INVALID_STATE"
      | "LEARNER_NOT_ACTIVE"
      | "RETRY_LIMIT_EXHAUSTED"
      | "RUNNER_CAPACITY_BUSY"
      | "RUNNER_INDETERMINATE"
      | "RUNNER_INFRASTRUCTURE_FAILURE"
      | "WRITE_CONFLICT",
  ) {
    super(code);
    this.name = "AssessmentCorrectionError";
  }
}

/**
 * Mastery facets use one canonical context for the whole formal-exam form.
 * Language courses keep conceptual mastery even when a coding item executes in
 * that language. DSA is the only shared track whose concept facet follows the
 * learner's selected implementation language.
 */
export function correctionMasteryLanguageContext(form: ExamFormSnapshot): string {
  if (form.courseId !== "dsa") return "conceptual";
  const languages = [...new Set(
    form.items
      .map((item) => {
        const language = item.language?.trim().toLocaleLowerCase("en-US");
        if (!language) return undefined;
        if (language === "cpp" || language === "c++") return "c++";
        if (language === "py" || language === "python") return "python";
        if (language === "c" || language === "java") return language;
        throw new AssessmentCorrectionError("EXAM_EVIDENCE_MISSING");
      })
      .filter((language): language is NonNullable<typeof language> => Boolean(language)),
  )];
  if (languages.length !== 1 || !/^[a-z][a-z0-9_+.-]{0,39}$/.test(languages[0]!)) {
    throw new AssessmentCorrectionError("EXAM_EVIDENCE_MISSING");
  }
  return `dsa:${languages[0]}`;
}

export function correctionTarget(form: ExamFormSnapshot, itemId: string): CorrectionTarget {
  const item = form.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new AssessmentCorrectionError("ITEM_NOT_FOUND");
  if (item.gradingEvidence.kind !== "runner-tests" || item.gradingEvidence.tests.length === 0) {
    throw new AssessmentCorrectionError("ITEM_NOT_DETERMINISTIC");
  }
  return {
    courseId: form.courseId,
    moduleId: form.moduleId,
    itemId: item.id,
    skillId: item.skillId,
    contentVersion: form.contentVersion,
    faultyBundleVersion: item.gradingEvidence.bundleVersion,
    faultyEvidenceHash: hashAppealEvidence(item.gradingEvidence),
    hadHiddenTests: item.gradingEvidence.tests.some((test) => test.visibility === "HIDDEN"),
  };
}

export function reviewedReplacement(
  target: CorrectionTarget,
  value: unknown,
): ReplacementEvidence {
  const replacement = replacementEvidenceSchema.parse(value);
  if (replacement.bundleVersion === target.faultyBundleVersion) {
    throw new AssessmentCorrectionError("REPLACEMENT_VERSION_REUSED");
  }
  if (target.hadHiddenTests && !replacement.tests.some((test) => test.visibility === "HIDDEN")) {
    throw new AssessmentCorrectionError("HIDDEN_TEST_COVERAGE_REMOVED");
  }
  return replacement;
}

export function formMatchesTarget(form: ExamFormSnapshot, target: CorrectionTarget): boolean {
  if (
    form.courseId !== target.courseId
    || form.moduleId !== target.moduleId
    || form.contentVersion !== target.contentVersion
  ) return false;
  const item = form.items.find((candidate) => candidate.id === target.itemId);
  return item?.skillId === target.skillId
    && item.gradingEvidence.kind === "runner-tests"
    && item.gradingEvidence.bundleVersion === target.faultyBundleVersion
    && hashAppealEvidence(item.gradingEvidence) === target.faultyEvidenceHash;
}

export function replaceFormEvidence(
  form: ExamFormSnapshot,
  target: CorrectionTarget,
  replacementValue: unknown,
): ExamFormSnapshot {
  if (!formMatchesTarget(form, target)) throw new AssessmentCorrectionError("EXAM_EVIDENCE_MISSING");
  const replacement = reviewedReplacement(target, replacementValue);
  return {
    ...form,
    items: form.items.map((item) => item.id === target.itemId
      ? { ...item, gradingEvidence: replacement as ExamGradingEvidence }
      : item),
  };
}

export interface ImpactSnapshot {
  readonly schemaVersion: 1;
  readonly attempt: {
    readonly id: string;
    readonly userId: string;
    readonly status: string;
    readonly policyVersion: string;
    readonly contentVersion: string;
    readonly score: number | null;
    readonly passed: boolean | null;
    readonly masteryAwarded: boolean;
  };
  readonly examSessionId: string | null;
  readonly form: ExamFormSnapshot;
  readonly answers: Readonly<Record<string, { readonly revision: number; readonly answer: ExamAnswer }>>;
  readonly originalResult: ExamResult;
}

export function buildImpactHashes(snapshot: ImpactSnapshot) {
  const answerSet = Object.fromEntries(Object.entries(snapshot.answers).sort(([left], [right]) => left.localeCompare(right)));
  return {
    formHash: hashAppealEvidence(snapshot.form),
    answerSetHash: hashAppealEvidence(answerSet),
    originalResultHash: hashAppealEvidence(snapshot.originalResult),
    snapshotHash: hashAppealEvidence(snapshot),
  } as const;
}

export function verifyImpactSnapshot(snapshot: ImpactSnapshot, expected: {
  formHash: string;
  answerSetHash: string;
  originalResultHash: string;
  snapshotHash: string;
}) {
  const actual = buildImpactHashes(snapshot);
  return actual.formHash === expected.formHash
    && actual.answerSetHash === expected.answerSetHash
    && actual.originalResultHash === expected.originalResultHash
    && actual.snapshotHash === expected.snapshotHash;
}

export function effectiveAnswers(snapshot: ImpactSnapshot): Record<string, ExamAnswer> {
  return Object.fromEntries(Object.entries(snapshot.answers).map(([itemId, value]) => [itemId, value.answer]));
}

export function runnerEvidenceManifest(input: {
  target: CorrectionTarget;
  replacement: ReplacementEvidence;
  results: Readonly<Record<string, ExamRunnerResult>>;
  executedAt: Date;
}) {
  return {
    schemaVersion: 1,
    executedAt: input.executedAt.toISOString(),
    target: input.target,
    replacementEvidenceHash: hashAppealEvidence(input.replacement),
    items: Object.entries(input.results)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([itemId, result]) => ({
        itemId,
        requestHash: result.requestHash,
        sourceHash: result.sourceHash,
        runtimeVersion: result.runtimeVersion,
        imageDigest: result.imageDigest,
        status: result.status,
        compileStatus: result.compile.status,
        tests: result.tests.map((test) => ({
          id: test.id,
          visibility: test.visibility,
          category: test.category,
          status: test.status,
          feedbackCode: test.feedbackCode,
        })),
        totals: result.totals,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      })),
  } as const;
}

export function masteryEffect(prior: ExamResult["outcome"], corrected: ExamResult["outcome"]): "award" | "revoke" | "no_change" {
  if (prior !== "MASTERED" && corrected === "MASTERED") return "award";
  if (prior === "MASTERED" && corrected !== "MASTERED") return "revoke";
  return "no_change";
}

export function correctionReviewHash(review: CorrectionReview): string {
  return hashAppealEvidence(review);
}
