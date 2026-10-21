import type {
  ExamAnswer,
  ExamFormSnapshot,
  ExamGradingEvidence,
  ExamItem,
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
  /**
   * Stable identity of the authored bank item. Question IDs are randomized per
   * form (qNN-hash(seed, bank, item)), so the same authored item carries a
   * different ID in every learner's form. Matching uses this content identity
   * plus the exact faulty bundle and evidence hash, never the form-local ID.
   */
  readonly authoredItemHash: string;
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
      | "RUNNER_RUNTIME_RETIRED"
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

/** Hash of everything authored about an item except its form-local ID and oracle. */
export function authoredItemHash(item: ExamItem): string {
  return hashAppealEvidence({
    schemaVersion: 1,
    kind: item.kind,
    skillId: item.skillId,
    clusterId: item.clusterId,
    title: item.title,
    prompt: item.prompt,
    points: item.points,
    critical: item.critical,
    language: item.language ?? null,
    starterCode: item.starterCode ?? null,
    runtime: item.runtime ?? null,
  });
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
    authoredItemHash: authoredItemHash(item),
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

/**
 * The form-local ID of the target's authored item in this form, or null. The
 * same authored item with the same faulty oracle maps to exactly one question;
 * an ambiguous form (two identical questions) is never guessed at.
 */
export function targetItemIdInForm(form: ExamFormSnapshot, target: CorrectionTarget): string | null {
  if (
    form.courseId !== target.courseId
    || form.moduleId !== target.moduleId
    || form.contentVersion !== target.contentVersion
  ) return null;
  const matches = form.items.filter((item) =>
    item.skillId === target.skillId
    && item.gradingEvidence.kind === "runner-tests"
    && item.gradingEvidence.bundleVersion === target.faultyBundleVersion
    && hashAppealEvidence(item.gradingEvidence) === target.faultyEvidenceHash
    && authoredItemHash(item) === target.authoredItemHash);
  return matches.length === 1 ? matches[0]!.id : null;
}

export function formMatchesTarget(form: ExamFormSnapshot, target: CorrectionTarget): boolean {
  return targetItemIdInForm(form, target) !== null;
}

export function replaceFormEvidence(
  form: ExamFormSnapshot,
  target: CorrectionTarget,
  replacementValue: unknown,
): ExamFormSnapshot {
  const localItemId = targetItemIdInForm(form, target);
  if (localItemId === null) throw new AssessmentCorrectionError("EXAM_EVIDENCE_MISSING");
  const replacement = reviewedReplacement(target, replacementValue);
  return {
    ...form,
    items: form.items.map((item) => item.id === localItemId
      ? { ...item, gradingEvidence: replacement as ExamGradingEvidence }
      : item),
  };
}

/**
 * A correction that already produced this attempt's effective result. Captured
 * hash-bound in the impact snapshot so a later correction regrades on top of
 * it instead of silently restoring the original faulty oracle.
 */
export interface AppliedCorrection {
  readonly correctionId: string;
  readonly outcomeId: string;
  readonly itemId: string;
  readonly faultyEvidenceHash: string;
  readonly replacement: ReplacementEvidence;
}

/**
 * Re-applies the effective correction chain (oldest first) to the immutable
 * base form. Each link must still match the base form's faulty oracle for its
 * own question. `supersededItemId` is the question the current correction
 * replaces; its earlier replacement is superseded rather than stacked.
 */
export function applyPriorCorrections(
  form: ExamFormSnapshot,
  applied: readonly AppliedCorrection[],
  supersededItemId: string,
): ExamFormSnapshot {
  const evidence = new Map<string, ExamGradingEvidence>();
  for (const link of applied) {
    const base = form.items.find((item) => item.id === link.itemId);
    if (
      !base
      || base.gradingEvidence.kind !== "runner-tests"
      || hashAppealEvidence(base.gradingEvidence) !== link.faultyEvidenceHash
    ) throw new AssessmentCorrectionError("EXAM_EVIDENCE_MISSING");
    evidence.set(link.itemId, replacementEvidenceSchema.parse(link.replacement) as ExamGradingEvidence);
  }
  evidence.delete(supersededItemId);
  return {
    ...form,
    items: form.items.map((item) => {
      const corrected = evidence.get(item.id);
      return corrected ? { ...item, gradingEvidence: corrected } : item;
    }),
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
  /** Form-local question this impact corrects (absent on legacy snapshots). */
  readonly targetItemId?: string;
  /** Effective correction chain at capture, oldest first (absent on legacy snapshots). */
  readonly appliedCorrections?: readonly AppliedCorrection[];
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
