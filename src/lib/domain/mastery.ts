import {
  assertProbability,
  evidenceRank,
  type EvidenceObservation,
  type LearningStage,
  type SkillProgress,
} from "./types";

export interface BktParameters {
  readonly learn: number;
  readonly slip: number;
  readonly guess: number;
}

export interface MasteryPolicy {
  readonly guidedThreshold: number;
  readonly independentThreshold: number;
  readonly examReadyThreshold: number;
  readonly minimumDistinctApplications: number;
  readonly minimumIndependentImplementations: number;
  readonly minimumDelayedChecks: number;
  readonly minimumTransferChecks: number;
}

export interface MasteryEvidenceSummary {
  readonly distinctApplicationVariants: number;
  readonly independentImplementations: number;
  readonly delayedChecks: number;
  readonly transferChecks: number;
  readonly hasBlockingMisconception: boolean;
}

export interface MasteryGateResult {
  readonly eligible: boolean;
  readonly unmet: readonly string[];
  readonly summary: MasteryEvidenceSummary;
}

export const DEFAULT_BKT_PARAMETERS: BktParameters = Object.freeze({
  learn: 0.15,
  slip: 0.1,
  guess: 0.2,
});

export const DEFAULT_MASTERY_POLICY: MasteryPolicy = Object.freeze({
  guidedThreshold: 0.55,
  independentThreshold: 0.75,
  examReadyThreshold: 0.9,
  minimumDistinctApplications: 2,
  minimumIndependentImplementations: 1,
  minimumDelayedChecks: 1,
  minimumTransferChecks: 1,
});

function validateBktParameters(parameters: BktParameters): void {
  assertProbability(parameters.learn, "learn");
  assertProbability(parameters.slip, "slip");
  assertProbability(parameters.guess, "guess");
}

function validateMasteryPolicy(policy: MasteryPolicy): void {
  assertProbability(policy.guidedThreshold, "guidedThreshold");
  assertProbability(policy.independentThreshold, "independentThreshold");
  assertProbability(policy.examReadyThreshold, "examReadyThreshold");

  if (
    policy.guidedThreshold > policy.independentThreshold ||
    policy.independentThreshold > policy.examReadyThreshold
  ) {
    throw new RangeError(
      "mastery thresholds must be ordered guided <= independent <= examReady",
    );
  }

  for (const [name, value] of Object.entries({
    minimumDistinctApplications: policy.minimumDistinctApplications,
    minimumIndependentImplementations:
      policy.minimumIndependentImplementations,
    minimumDelayedChecks: policy.minimumDelayedChecks,
    minimumTransferChecks: policy.minimumTransferChecks,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer`);
    }
  }
}

function bayesianPosterior(
  current: number,
  correct: boolean,
  parameters: BktParameters,
): number {
  if (correct) {
    const numerator = current * (1 - parameters.slip);
    const denominator =
      numerator + (1 - current) * parameters.guess;
    return denominator === 0 ? current : numerator / denominator;
  }

  const numerator = current * parameters.slip;
  const denominator =
    numerator + (1 - current) * (1 - parameters.guess);
  return denominator === 0 ? current : numerator / denominator;
}

export function updateMasteryProbability(
  current: number,
  observation: EvidenceObservation,
  parameters: BktParameters = DEFAULT_BKT_PARAMETERS,
): number {
  assertProbability(current, "current mastery probability");
  validateBktParameters(parameters);

  const independentlyObserved =
    observation.assistanceLevel === "A0" &&
    observation.evidenceLevel !== "E0" &&
    !observation.solutionRevealed;

  let updated = independentlyObserved
    ? bayesianPosterior(current, observation.correct, parameters)
    : current;

  if (observation.learningOpportunity) {
    updated += (1 - updated) * parameters.learn;
  }

  return Math.min(1, Math.max(0, updated));
}

export function isQualifyingIndependentEvidence(
  observation: EvidenceObservation,
  minimumLevel: EvidenceObservation["evidenceLevel"] = "E3",
): boolean {
  return (
    observation.correct &&
    observation.assistanceLevel === "A0" &&
    !observation.solutionRevealed &&
    evidenceRank(observation.evidenceLevel) >= evidenceRank(minimumLevel)
  );
}

export function summarizeMasteryEvidence(
  progress: Pick<SkillProgress, "evidence" | "activeMisconceptions">,
): MasteryEvidenceSummary {
  const applications = new Set<string>();
  let independentImplementations = 0;
  let delayedChecks = 0;
  let transferChecks = 0;

  for (const observation of progress.evidence) {
    if (isQualifyingIndependentEvidence(observation, "E3")) {
      applications.add(observation.itemVariantId);
    }
    if (isQualifyingIndependentEvidence(observation, "E4")) {
      independentImplementations += 1;
    }
    if (isQualifyingIndependentEvidence(observation, "E5")) {
      transferChecks += 1;
    }
    if (isQualifyingIndependentEvidence(observation, "E6")) {
      delayedChecks += 1;
    }
  }

  return {
    distinctApplicationVariants: applications.size,
    independentImplementations,
    delayedChecks,
    transferChecks,
    hasBlockingMisconception: progress.activeMisconceptions.some(
      (misconception) => misconception.blocking,
    ),
  };
}

export function evaluateExamReadiness(
  progress: Pick<
    SkillProgress,
    "masteryProbability" | "evidence" | "activeMisconceptions"
  >,
  policy: MasteryPolicy = DEFAULT_MASTERY_POLICY,
): MasteryGateResult {
  validateMasteryPolicy(policy);
  assertProbability(progress.masteryProbability, "masteryProbability");
  const summary = summarizeMasteryEvidence(progress);
  const unmet: string[] = [];

  if (progress.masteryProbability < policy.examReadyThreshold) {
    unmet.push("mastery_probability");
  }
  if (
    summary.distinctApplicationVariants <
    policy.minimumDistinctApplications
  ) {
    unmet.push("distinct_applications");
  }
  if (
    summary.independentImplementations <
    policy.minimumIndependentImplementations
  ) {
    unmet.push("independent_implementation");
  }
  if (summary.delayedChecks < policy.minimumDelayedChecks) {
    unmet.push("delayed_check");
  }
  if (summary.transferChecks < policy.minimumTransferChecks) {
    unmet.push("transfer_check");
  }
  if (summary.hasBlockingMisconception) {
    unmet.push("blocking_misconception");
  }

  return { eligible: unmet.length === 0, unmet, summary };
}

function deriveActiveStage(
  progress: SkillProgress,
  newProbability: number,
  latest: EvidenceObservation,
  policy: MasteryPolicy,
): LearningStage {
  const hasBlocking = progress.activeMisconceptions.some(
    (misconception) => misconception.blocking,
  );

  if (hasBlocking) {
    return "REMEDIATION";
  }

  const independentFailure =
    latest.assistanceLevel === "A0" &&
    !latest.correct &&
    latest.evidenceLevel !== "E0";
  const independentReviewRecovery = isQualifyingIndependentEvidence(latest, "E3");

  if (progress.masteredAtMs !== undefined) {
    if (progress.stage === "REVIEW_DUE") {
      return independentReviewRecovery ? "MASTERED" : "REVIEW_DUE";
    }
    return independentFailure ? "REVIEW_DUE" : "MASTERED";
  }
  if (progress.passedAtMs !== undefined) {
    // Passing is durable evidence, but it must not hide later independent
    // evidence that the learner has regressed. Preserve `passedAtMs` while
    // routing the learner back through review, exactly as we do for mastery.
    if (progress.stage === "REVIEW_DUE") {
      return independentReviewRecovery ? "PASSED" : "REVIEW_DUE";
    }
    return independentFailure ? "REVIEW_DUE" : "PASSED";
  }

  const readiness = evaluateExamReadiness(
    { ...progress, masteryProbability: newProbability },
    policy,
  );
  if (readiness.eligible) {
    return "EXAM_READY";
  }

  if (newProbability >= policy.independentThreshold) {
    return "INDEPENDENT_PRACTICE";
  }
  if (newProbability >= policy.guidedThreshold) {
    return "GUIDED_PRACTICE";
  }
  return "LEARNING";
}

export function applyEvidence(
  progress: SkillProgress,
  observation: EvidenceObservation,
  parameters: BktParameters = DEFAULT_BKT_PARAMETERS,
  policy: MasteryPolicy = DEFAULT_MASTERY_POLICY,
): SkillProgress {
  if (progress.skillId !== observation.skillId) {
    throw new Error(
      `evidence for ${observation.skillId} cannot update ${progress.skillId}`,
    );
  }
  if (
    !Number.isFinite(observation.occurredAtMs) ||
    observation.occurredAtMs < 0
  ) {
    throw new RangeError("occurredAtMs must be a finite non-negative number");
  }

  validateMasteryPolicy(policy);
  const masteryProbability = updateMasteryProbability(
    progress.masteryProbability,
    observation,
    parameters,
  );
  const evidence = [...progress.evidence, observation];
  const nextBase: SkillProgress = {
    ...progress,
    masteryProbability,
    evidence,
  };

  return {
    ...nextBase,
    stage: deriveActiveStage(nextBase, masteryProbability, observation, policy),
  };
}
