import {
  assertFiniteNonNegative,
  assertProbability,
  type AssistanceLevel,
} from "./types";

export interface MisconceptionProbe {
  readonly id: string;
  readonly misconceptionTag: string;
  readonly itemVariantId: string;
  readonly correct: boolean;
  readonly assistanceLevel: AssistanceLevel;
  readonly confidence: number;
  readonly occurredAtMs: number;
}

export interface RemediationPolicy {
  readonly minimumDistinctConfirmingFailures: number;
  readonly minimumDistinctResolutionSuccesses: number;
  readonly highConfidenceThreshold: number;
}

export interface RemediationDecision {
  readonly activateRemediation: boolean;
  readonly requestConfirmingProbe: boolean;
  readonly priority: "NORMAL" | "HIGH";
  readonly distinctConfirmingFailures: number;
}

export type HintLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface HintProgression {
  readonly nextLevel: HintLevel;
  readonly solutionRevealed: boolean;
  readonly requiresSelfExplanation: boolean;
  readonly requiresFreshVariant: boolean;
}

export const DEFAULT_REMEDIATION_POLICY: RemediationPolicy = Object.freeze({
  minimumDistinctConfirmingFailures: 2,
  minimumDistinctResolutionSuccesses: 2,
  highConfidenceThreshold: 0.75,
});

function validatePolicy(policy: RemediationPolicy): void {
  for (const [name, value] of Object.entries({
    minimumDistinctConfirmingFailures:
      policy.minimumDistinctConfirmingFailures,
    minimumDistinctResolutionSuccesses:
      policy.minimumDistinctResolutionSuccesses,
  })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  assertProbability(
    policy.highConfidenceThreshold,
    "highConfidenceThreshold",
  );
}

function validateProbe(probe: MisconceptionProbe): void {
  assertProbability(probe.confidence, "probe confidence");
  assertFiniteNonNegative(probe.occurredAtMs, "probe occurredAtMs");
}

export function evaluateRemediation(
  misconceptionTag: string,
  probes: readonly MisconceptionProbe[],
  policy: RemediationPolicy = DEFAULT_REMEDIATION_POLICY,
): RemediationDecision {
  validatePolicy(policy);
  const relevant = probes.filter((probe) => {
    validateProbe(probe);
    return probe.misconceptionTag === misconceptionTag;
  });
  const failures = relevant.filter(
    (probe) => !probe.correct && probe.assistanceLevel === "A0",
  );
  const variants = new Set(failures.map((probe) => probe.itemVariantId));
  const latestFailure = failures.reduce<MisconceptionProbe | undefined>(
    (latest, probe) =>
      latest === undefined || probe.occurredAtMs > latest.occurredAtMs
        ? probe
        : latest,
    undefined,
  );
  const activate =
    variants.size >= policy.minimumDistinctConfirmingFailures;

  return {
    activateRemediation: activate,
    requestConfirmingProbe: failures.length > 0 && !activate,
    priority:
      latestFailure !== undefined &&
      latestFailure.confidence >= policy.highConfidenceThreshold
        ? "HIGH"
        : "NORMAL",
    distinctConfirmingFailures: variants.size,
  };
}

export function isRemediationResolved(
  misconceptionTag: string,
  probesAfterRemediation: readonly MisconceptionProbe[],
  policy: RemediationPolicy = DEFAULT_REMEDIATION_POLICY,
): boolean {
  validatePolicy(policy);
  const successfulVariants = new Set(
    probesAfterRemediation
      .filter((probe) => {
        validateProbe(probe);
        return (
          probe.misconceptionTag === misconceptionTag &&
          probe.correct &&
          probe.assistanceLevel === "A0"
        );
      })
      .map((probe) => probe.itemVariantId),
  );

  return (
    successfulVariants.size >= policy.minimumDistinctResolutionSuccesses
  );
}

export function advanceHintLevel(current: HintLevel): HintProgression {
  if (!Number.isInteger(current) || current < 0 || current > 6) {
    throw new RangeError("hint level must be an integer from 0 to 6");
  }
  const nextLevel = Math.min(6, current + 1) as HintLevel;
  const solutionRevealed = nextLevel === 6;

  return {
    nextLevel,
    solutionRevealed,
    requiresSelfExplanation: solutionRevealed,
    requiresFreshVariant: solutionRevealed,
  };
}

export function retakeCooldownMs(
  examDurationMinutes: number,
  technicalIncident = false,
): number {
  assertFiniteNonNegative(examDurationMinutes, "examDurationMinutes");
  if (technicalIncident) {
    return 0;
  }
  if (examDurationMinutes <= 10) {
    return 60 * 60 * 1_000;
  }
  if (examDurationMinutes <= 30) {
    return 6 * 60 * 60 * 1_000;
  }
  return 24 * 60 * 60 * 1_000;
}

export function nextRetakeAtMs(
  failedAtMs: number,
  examDurationMinutes: number,
  remediationComplete: boolean,
  technicalIncident = false,
): number | null {
  assertFiniteNonNegative(failedAtMs, "failedAtMs");
  if (!technicalIncident && !remediationComplete) {
    return null;
  }
  return (
    failedAtMs +
    retakeCooldownMs(examDurationMinutes, technicalIncident)
  );
}
