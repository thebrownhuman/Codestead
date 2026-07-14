import { assertFiniteNonNegative } from "./types";

export type ReviewOutcome = "CLEAN" | "ASSISTED" | "FAILED";

export interface ReviewPolicy {
  readonly intervalsDays: readonly number[];
  readonly sameSessionDelayMinutes: number;
  readonly matureGrowthFactor: number;
  readonly maxIntervalDays: number;
}

export interface ReviewSchedule {
  readonly skillId: string;
  readonly intervalIndex: number;
  readonly intervalDays: number;
  readonly dueAtMs: number;
  readonly lastReviewedAtMs?: number;
  readonly successfulReviews: number;
  readonly lapses: number;
}

export interface ReviewPriorityInput {
  readonly schedule: ReviewSchedule;
  readonly nowMs: number;
  readonly goalPriority: number;
  readonly prerequisiteCentrality: number;
}

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = Object.freeze({
  intervalsDays: Object.freeze([0, 1, 3, 7, 14, 30]),
  sameSessionDelayMinutes: 15,
  matureGrowthFactor: 2,
  maxIntervalDays: 180,
});

function validatePolicy(policy: ReviewPolicy): void {
  if (policy.intervalsDays.length === 0) {
    throw new RangeError("intervalsDays must not be empty");
  }
  let previous = -1;
  for (const interval of policy.intervalsDays) {
    assertFiniteNonNegative(interval, "review interval");
    if (interval <= previous) {
      throw new RangeError("review intervals must be strictly increasing");
    }
    previous = interval;
  }
  assertFiniteNonNegative(
    policy.sameSessionDelayMinutes,
    "sameSessionDelayMinutes",
  );
  if (
    !Number.isFinite(policy.matureGrowthFactor) ||
    policy.matureGrowthFactor < 1
  ) {
    throw new RangeError("matureGrowthFactor must be at least 1");
  }
  assertFiniteNonNegative(policy.maxIntervalDays, "maxIntervalDays");
  if (
    policy.maxIntervalDays <
    policy.intervalsDays[policy.intervalsDays.length - 1]
  ) {
    throw new RangeError(
      "maxIntervalDays cannot be below the final configured interval",
    );
  }
}

function validateNow(nowMs: number): void {
  assertFiniteNonNegative(nowMs, "nowMs");
}

function dueAtFor(
  nowMs: number,
  intervalDays: number,
  policy: ReviewPolicy,
): number {
  if (intervalDays === 0) {
    return nowMs + policy.sameSessionDelayMinutes * MINUTE_MS;
  }
  return nowMs + intervalDays * DAY_MS;
}

export function createInitialReviewSchedule(
  skillId: string,
  nowMs: number,
  policy: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): ReviewSchedule {
  validateNow(nowMs);
  validatePolicy(policy);
  if (skillId.trim() === "") {
    throw new Error("skillId must not be empty");
  }

  const firstInterval = policy.intervalsDays[0];
  return {
    skillId,
    intervalIndex: 0,
    intervalDays: firstInterval,
    dueAtMs: dueAtFor(nowMs, firstInterval, policy),
    successfulReviews: 0,
    lapses: 0,
  };
}

export function scheduleNextReview(
  current: ReviewSchedule,
  outcome: ReviewOutcome,
  nowMs: number,
  policy: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): ReviewSchedule {
  validateNow(nowMs);
  validatePolicy(policy);
  if (
    !Number.isInteger(current.intervalIndex) ||
    current.intervalIndex < 0 ||
    current.intervalIndex >= policy.intervalsDays.length
  ) {
    throw new RangeError("intervalIndex is outside the policy interval range");
  }

  if (outcome === "FAILED") {
    const resetIndex = Math.min(1, policy.intervalsDays.length - 1);
    const resetDays = policy.intervalsDays[resetIndex];
    return {
      ...current,
      intervalIndex: resetIndex,
      intervalDays: resetDays,
      dueAtMs: dueAtFor(nowMs, resetDays, policy),
      lastReviewedAtMs: nowMs,
      lapses: current.lapses + 1,
    };
  }

  if (outcome === "ASSISTED") {
    return {
      ...current,
      dueAtMs: dueAtFor(nowMs, current.intervalDays, policy),
      lastReviewedAtMs: nowMs,
    };
  }

  const lastIndex = policy.intervalsDays.length - 1;
  const nextIndex = Math.min(current.intervalIndex + 1, lastIndex);
  const nextDays =
    current.intervalIndex < lastIndex
      ? policy.intervalsDays[nextIndex]
      : Math.min(
          policy.maxIntervalDays,
          Math.max(
            policy.intervalsDays[lastIndex],
            current.intervalDays * policy.matureGrowthFactor,
          ),
        );

  return {
    ...current,
    intervalIndex: nextIndex,
    intervalDays: nextDays,
    dueAtMs: dueAtFor(nowMs, nextDays, policy),
    lastReviewedAtMs: nowMs,
    successfulReviews: current.successfulReviews + 1,
  };
}

export function isReviewDue(
  schedule: Pick<ReviewSchedule, "dueAtMs">,
  nowMs: number,
): boolean {
  validateNow(nowMs);
  assertFiniteNonNegative(schedule.dueAtMs, "dueAtMs");
  return schedule.dueAtMs <= nowMs;
}

export function computeReviewPriority(input: ReviewPriorityInput): number {
  validateNow(input.nowMs);
  assertFiniteNonNegative(input.goalPriority, "goalPriority");
  assertFiniteNonNegative(
    input.prerequisiteCentrality,
    "prerequisiteCentrality",
  );
  if (!isReviewDue(input.schedule, input.nowMs)) {
    return 0;
  }

  const overdueDays =
    Math.max(0, input.nowMs - input.schedule.dueAtMs) / DAY_MS;
  return (
    1 +
    overdueDays +
    input.goalPriority * 3 +
    input.prerequisiteCentrality * 2 +
    input.schedule.lapses
  );
}

export function orderDueReviews(
  inputs: readonly ReviewPriorityInput[],
): readonly ReviewPriorityInput[] {
  return inputs
    .filter((input) => isReviewDue(input.schedule, input.nowMs))
    .map((input) => ({
      input,
      priority: computeReviewPriority(input),
    }))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.input.schedule.skillId.localeCompare(
          right.input.schedule.skillId,
        ),
    )
    .map(({ input }) => input);
}
