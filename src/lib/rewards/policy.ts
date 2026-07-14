export const REWARD_POLICY_VERSION = "reward-ledger-2026-07.v1" as const;
export const LEVEL_POLICY_VERSION = "level-curve-2026-07.v1" as const;
export const CHALLENGE_POLICY_VERSION = "challenge-xp-2026-07.v1" as const;

export const COINS_ENABLED = false as const;
export const COIN_POLICY_NOTE =
  "Coins are reserved for a future reviewed purpose. This policy always awards zero coins and exposes no spending path." as const;

export type RewardableAttemptKind =
  | "practice"
  | "diagnostic"
  | "quiz"
  | "game"
  | "mastery_check"
  | "exam"
  | "retake"
  | "project";

export type RewardDecision = Readonly<{
  eligible: boolean;
  rewardCode: "attempt_completion" | "concept_mastery";
  scopeKey: string;
  xp: number;
  coins: 0;
  reason: string;
  policyVersion: typeof REWARD_POLICY_VERSION;
}>;

export type EffectiveAttemptResult = Readonly<{
  outcome?: unknown;
  infrastructureFailure?: unknown;
}> | null;

export type AttemptRewardInput = Readonly<{
  kind: RewardableAttemptKind;
  status: string;
  passed: boolean | null;
  masteryAwarded: boolean | null;
  infrastructureFailure: boolean;
  assistanceLevel: string;
  solutionRevealed: boolean;
  activityId: string | null;
  contentVersion: string;
  evidenceOccurredAt: Date | null;
  effectiveResult?: EffectiveAttemptResult;
}>;

export type MasteryRewardInput = Readonly<{
  enrollmentId: string;
  conceptId: string;
  languageContext: string;
  validity: string;
  score: number;
  weight: number;
  recordedBy: string | null;
  sourceType: string;
  sourceAttemptId: string | null;
  sourceAttemptStatus: string | null;
  sourceAttemptPassed: boolean | null;
  sourceAttemptMasteryAwarded: boolean | null;
  sourceAttemptInfrastructureFailure: boolean | null;
  sourceAttemptAssistanceLevel: string | null;
  sourceAttemptSolutionRevealed: boolean | null;
  sourceAttemptConceptBound: boolean;
  sourceAttemptEffectiveResult?: EffectiveAttemptResult;
}>;

const ATTEMPT_XP: Readonly<Record<RewardableAttemptKind, number>> = Object.freeze({
  practice: 0,
  diagnostic: 0,
  quiz: 20,
  game: 15,
  mastery_check: 40,
  exam: 100,
  retake: 80,
  project: 120,
});

const TRUSTED_MASTERY_RECORDERS = new Set([
  "verified-runner",
  "adaptive-deterministic-engine",
]);

const ATTEMPT_BOUND_MASTERY_SOURCES = new Set([
  "attempt",
  "deterministic_attempt",
  "verified_runner",
  "assessment_correction",
]);

function boundedScopePart(value: string) {
  return value.trim().replaceAll(":", "_").slice(0, 180);
}

export function deriveAttemptReward(input: AttemptRewardInput): RewardDecision {
  const xp = ATTEMPT_XP[input.kind];
  const effectivePass = input.effectiveResult
    ? input.effectiveResult.outcome === "MASTERED"
      && input.effectiveResult.infrastructureFailure !== true
    : input.passed === true
      && input.masteryAwarded === true
      && !input.infrastructureFailure;
  const scope = input.activityId
    ? `activity:${input.activityId}`
    : `content:${input.kind}:${boundedScopePart(input.contentVersion)}`;
  const independentlyCompleted = input.status === "graded"
    && effectivePass
    && input.evidenceOccurredAt !== null
    && Number.isFinite(input.evidenceOccurredAt.getTime())
    && input.assistanceLevel === "A0"
    && !input.solutionRevealed;
  const eligible = xp > 0 && independentlyCompleted;
  let reason = "Eligible independently graded official evidence.";
  if (xp === 0) reason = "Practice and diagnostic attempts do not earn durable rewards.";
  else if (input.status !== "graded") reason = "Only a final graded attempt can earn a reward.";
  else if (!effectivePass) reason = "The latest official result does not support completion.";
  else if (input.evidenceOccurredAt === null || !Number.isFinite(input.evidenceOccurredAt.getTime())) {
    reason = "Final evidence has no authoritative completion timestamp.";
  }
  else if (input.assistanceLevel !== "A0" || input.solutionRevealed) {
    reason = "Assisted or solution-revealed work remains useful practice but does not earn durable rewards.";
  }
  return {
    eligible,
    rewardCode: "attempt_completion",
    scopeKey: scope,
    xp: eligible ? xp : 0,
    coins: 0,
    reason,
    policyVersion: REWARD_POLICY_VERSION,
  };
}

export function deriveMasteryReward(input: MasteryRewardInput): RewardDecision {
  const sourceMasteryAwarded = input.sourceAttemptEffectiveResult
    ? input.sourceAttemptEffectiveResult.outcome === "MASTERED"
      && input.sourceAttemptEffectiveResult.infrastructureFailure !== true
    : input.sourceAttemptPassed === true
      && input.sourceAttemptMasteryAwarded === true
      && input.sourceAttemptInfrastructureFailure === false;
  const independentlySupported = input.validity === "valid"
    && Number.isFinite(input.score)
    && input.score >= 0.8
    && Number.isFinite(input.weight)
    && input.weight > 0
    && input.recordedBy !== null
    && TRUSTED_MASTERY_RECORDERS.has(input.recordedBy)
    && ATTEMPT_BOUND_MASTERY_SOURCES.has(input.sourceType)
    && input.sourceAttemptId !== null
    && input.sourceAttemptConceptBound
    && input.sourceAttemptStatus === "graded"
    && sourceMasteryAwarded
    && input.sourceAttemptAssistanceLevel === "A0"
    && input.sourceAttemptSolutionRevealed === false;
  return {
    eligible: independentlySupported,
    rewardCode: "concept_mastery",
    scopeKey: `mastery:${input.enrollmentId}:${input.conceptId}:${boundedScopePart(input.languageContext)}`,
    xp: independentlySupported ? 60 : 0,
    coins: 0,
    reason: independentlySupported
      ? "Eligible independently verified concept mastery evidence bound to an unassisted mastered attempt."
      : "Mastery evidence is invalid, below threshold, or lacks an unassisted mastered source attempt and approved deterministic recorder.",
    policyVersion: REWARD_POLICY_VERSION,
  };
}

export type LevelProgress = Readonly<{
  formulaVersion: typeof LEVEL_POLICY_VERSION;
  totalXp: number;
  level: number;
  currentLevelStartsAt: number;
  nextLevelStartsAt: number;
  xpIntoLevel: number;
  xpToNextLevel: number;
}>;

const MAX_LEVEL = 100;

/** Level N starts at 100 * (N - 1) * N / 2 XP. */
export function levelStartXp(level: number) {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL + 1) {
    throw new RangeError(`level must be an integer from 1 to ${MAX_LEVEL + 1}.`);
  }
  return 50 * (level - 1) * level;
}

export function deriveLevel(totalXp: number): LevelProgress {
  if (!Number.isSafeInteger(totalXp) || totalXp < 0) {
    throw new RangeError("totalXp must be a non-negative safe integer.");
  }
  let low = 1;
  let high = MAX_LEVEL;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (levelStartXp(middle) <= totalXp) low = middle;
    else high = middle - 1;
  }
  const level = low;
  const currentLevelStartsAt = levelStartXp(level);
  const nextLevelStartsAt = level === MAX_LEVEL ? currentLevelStartsAt : levelStartXp(level + 1);
  return {
    formulaVersion: LEVEL_POLICY_VERSION,
    totalXp,
    level,
    currentLevelStartsAt,
    nextLevelStartsAt,
    xpIntoLevel: totalXp - currentLevelStartsAt,
    xpToNextLevel: level === MAX_LEVEL ? 0 : nextLevelStartsAt - totalXp,
  };
}

export type ChallengeKind = "weekly" | "monthly";

export type ChallengePeriod = Readonly<{
  kind: ChallengeKind;
  timezone: string;
  startLocalDate: string;
  endLocalDateExclusive: string;
  key: string;
}>;

export type ChallengeProgress = Readonly<{
  id: string;
  kind: ChallengeKind;
  title: string;
  description: string;
  policyVersion: typeof CHALLENGE_POLICY_VERSION;
  period: ChallengePeriod;
  targetXp: number;
  earnedXp: number;
  qualifyingRewards: number;
  completed: boolean;
  progressPercent: number;
  completionReward: null;
}>;

const CHALLENGE_XP_TARGET: Readonly<Record<ChallengeKind, number>> = Object.freeze({
  weekly: 250,
  monthly: 1_000,
});

function validTimezone(candidate: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "UTC";
  }
}

function localDateParts(now: Date, timezone: string) {
  if (!Number.isFinite(now.getTime())) throw new RangeError("A valid challenge timestamp is required.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function challengePeriod(kind: ChallengeKind, now: Date, timezone: string): ChallengePeriod {
  const safeTimezone = validTimezone(timezone);
  const parts = localDateParts(now, safeTimezone);
  const localCalendarDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  let start: Date;
  let end: Date;
  if (kind === "weekly") {
    const mondayOffset = (localCalendarDate.getUTCDay() + 6) % 7;
    start = new Date(localCalendarDate);
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
  } else {
    start = new Date(Date.UTC(parts.year, parts.month - 1, 1));
    end = new Date(Date.UTC(parts.year, parts.month, 1));
  }
  const startLocalDate = dateKey(start);
  const endLocalDateExclusive = dateKey(end);
  return {
    kind,
    timezone: safeTimezone,
    startLocalDate,
    endLocalDateExclusive,
    key: `${kind}:${startLocalDate}`,
  };
}

export function deriveChallengeProgress(input: {
  kind: ChallengeKind;
  period: ChallengePeriod;
  earnedXp: number;
  qualifyingRewards: number;
}): ChallengeProgress {
  const earnedXp = Math.max(0, Math.trunc(input.earnedXp));
  const qualifyingRewards = Math.max(0, Math.trunc(input.qualifyingRewards));
  const targetXp = CHALLENGE_XP_TARGET[input.kind];
  return {
    id: `${CHALLENGE_POLICY_VERSION}:${input.period.key}`,
    kind: input.kind,
    title: input.kind === "weekly" ? "Weekly evidence challenge" : "Monthly evidence challenge",
    description: `Earn ${targetXp} XP from unreversed, authoritative learning evidence during this ${input.kind} period.`,
    policyVersion: CHALLENGE_POLICY_VERSION,
    period: input.period,
    targetXp,
    earnedXp,
    qualifyingRewards,
    completed: earnedXp >= targetXp,
    progressPercent: Math.min(100, Math.floor((earnedXp / targetXp) * 100)),
    // Challenge completion is deliberately not a recursive reward source in v1.
    completionReward: null,
  };
}
