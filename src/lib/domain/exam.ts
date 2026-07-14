import { assertFiniteNonNegative } from "./types";

export type ExamCriterionKind =
  | "FUNCTIONAL"
  | "CONCEPT"
  | "STYLE"
  | "EXPLANATION"
  | "PERFORMANCE";

export interface ExamCriterionResult {
  readonly itemId: string;
  readonly criterionId: string;
  readonly clusterId: string;
  readonly kind: ExamCriterionKind;
  readonly earnedPoints: number;
  readonly possiblePoints: number;
  readonly critical: boolean;
}

export interface CodingItemResult {
  readonly itemId: string;
  readonly mandatory: boolean;
  readonly compiled: boolean;
  readonly criticalTestsPassed: boolean;
}

export interface ExamSubmission {
  readonly criteria: readonly ExamCriterionResult[];
  readonly codingItems: readonly CodingItemResult[];
  readonly singleProject: boolean;
}

export interface ExamScoringPolicy {
  readonly passPercent: number;
  readonly criticalClusterPercent: number;
  readonly masteryPercent: number;
}

export interface ClusterScore {
  readonly clusterId: string;
  readonly earnedPoints: number;
  readonly possiblePoints: number;
  readonly percent: number;
  readonly critical: boolean;
}

export type ExamOutcome = "NOT_PASSED" | "PASSED" | "MASTERED";

export interface ExamScore {
  readonly outcome: ExamOutcome;
  readonly earnedPoints: number;
  readonly possiblePoints: number;
  readonly percent: number;
  readonly clusters: readonly ClusterScore[];
  readonly failedCriticalClusters: readonly string[];
  readonly masteryBlockingCodingItems: readonly string[];
  readonly compilationGatePassed: boolean;
  readonly badgeAwarded: boolean;
}

export interface MasteryRecheckTargets {
  readonly clusterIds: readonly string[];
  readonly codingItemIds: readonly string[];
}

export const DEFAULT_EXAM_SCORING_POLICY: ExamScoringPolicy =
  Object.freeze({
    passPercent: 80,
    criticalClusterPercent: 70,
    masteryPercent: 95,
  });

function validatePolicy(policy: ExamScoringPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new RangeError(`${name} must be between 0 and 100`);
    }
  }
  if (policy.masteryPercent < policy.passPercent) {
    throw new RangeError("masteryPercent cannot be below passPercent");
  }
}

function validateSubmission(submission: ExamSubmission): void {
  if (submission.criteria.length === 0) {
    throw new Error("an exam must contain at least one scored criterion");
  }

  const criterionIds = new Set<string>();
  for (const criterion of submission.criteria) {
    if (criterionIds.has(criterion.criterionId)) {
      throw new Error(
        `duplicate exam criterion ${criterion.criterionId}`,
      );
    }
    criterionIds.add(criterion.criterionId);
    assertFiniteNonNegative(
      criterion.earnedPoints,
      `${criterion.criterionId}.earnedPoints`,
    );
    if (
      !Number.isFinite(criterion.possiblePoints) ||
      criterion.possiblePoints <= 0
    ) {
      throw new RangeError(
        `${criterion.criterionId}.possiblePoints must be positive`,
      );
    }
    if (criterion.earnedPoints > criterion.possiblePoints) {
      throw new RangeError(
        `${criterion.criterionId}.earnedPoints cannot exceed possiblePoints`,
      );
    }
  }

  const codingIds = new Set<string>();
  for (const coding of submission.codingItems) {
    if (codingIds.has(coding.itemId)) {
      throw new Error(`duplicate coding item ${coding.itemId}`);
    }
    codingIds.add(coding.itemId);
  }
}

function effectiveCriterion(
  criterion: ExamCriterionResult,
  codingByItem: ReadonlyMap<string, CodingItemResult>,
): ExamCriterionResult {
  const coding = codingByItem.get(criterion.itemId);
  if (
    criterion.kind === "FUNCTIONAL" &&
    coding !== undefined &&
    !coding.compiled
  ) {
    return { ...criterion, earnedPoints: 0 };
  }
  return criterion;
}

export function scoreExam(
  submission: ExamSubmission,
  policy: ExamScoringPolicy = DEFAULT_EXAM_SCORING_POLICY,
): ExamScore {
  validatePolicy(policy);
  validateSubmission(submission);

  const codingByItem = new Map(
    submission.codingItems.map((item) => [item.itemId, item]),
  );
  const criteria = submission.criteria.map((criterion) =>
    effectiveCriterion(criterion, codingByItem),
  );
  const possiblePoints = criteria.reduce(
    (sum, criterion) => sum + criterion.possiblePoints,
    0,
  );
  const earnedPoints = criteria.reduce(
    (sum, criterion) => sum + criterion.earnedPoints,
    0,
  );
  const percent = (earnedPoints / possiblePoints) * 100;

  const clusterMap = new Map<
    string,
    {
      earnedPoints: number;
      possiblePoints: number;
      critical: boolean;
    }
  >();

  for (const criterion of criteria) {
    const cluster = clusterMap.get(criterion.clusterId) ?? {
      earnedPoints: 0,
      possiblePoints: 0,
      critical: false,
    };
    cluster.earnedPoints += criterion.earnedPoints;
    cluster.possiblePoints += criterion.possiblePoints;
    cluster.critical ||= criterion.critical;
    clusterMap.set(criterion.clusterId, cluster);
  }

  const clusters: ClusterScore[] = [...clusterMap.entries()]
    .map(([clusterId, cluster]) => ({
      clusterId,
      ...cluster,
      percent: (cluster.earnedPoints / cluster.possiblePoints) * 100,
    }))
    .sort((left, right) => left.clusterId.localeCompare(right.clusterId));

  const failedCriticalClusters = clusters
    .filter(
      (cluster) =>
        cluster.critical &&
        cluster.percent < policy.criticalClusterPercent,
    )
    .map((cluster) => cluster.clusterId);

  const mandatoryCodingItems = submission.codingItems.filter(
    (item) => item.mandatory,
  );
  const compilationGatePassed =
    !submission.singleProject ||
    mandatoryCodingItems.every((item) => item.compiled);

  const masteryBlockingCodingItems = mandatoryCodingItems
    .filter((item) => !item.compiled || !item.criticalTestsPassed)
    .map((item) => item.itemId)
    .sort();

  const passed =
    percent >= policy.passPercent &&
    failedCriticalClusters.length === 0 &&
    compilationGatePassed;
  const mastered =
    passed &&
    percent >= policy.masteryPercent &&
    masteryBlockingCodingItems.length === 0;
  const outcome: ExamOutcome = mastered
    ? "MASTERED"
    : passed
      ? "PASSED"
      : "NOT_PASSED";

  return {
    outcome,
    earnedPoints,
    possiblePoints,
    percent,
    clusters,
    failedCriticalClusters,
    masteryBlockingCodingItems,
    compilationGatePassed,
    badgeAwarded: outcome === "MASTERED",
  };
}

export function canUnlockNextTopic(
  score: Pick<ExamScore, "outcome">,
  masteryRequired = false,
): boolean {
  return masteryRequired
    ? score.outcome === "MASTERED"
    : score.outcome === "PASSED" || score.outcome === "MASTERED";
}

export function requiredMasteryRecheckTargets(
  score: ExamScore,
  policy: ExamScoringPolicy = DEFAULT_EXAM_SCORING_POLICY,
): MasteryRecheckTargets {
  validatePolicy(policy);
  if (score.outcome === "NOT_PASSED" || score.outcome === "MASTERED") {
    return { clusterIds: [], codingItemIds: [] };
  }

  const clusterIds = score.clusters
    .filter((cluster) => cluster.percent < policy.masteryPercent)
    .map((cluster) => cluster.clusterId)
    .sort();
  return {
    clusterIds,
    codingItemIds: [...score.masteryBlockingCodingItems],
  };
}
