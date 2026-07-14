import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  MINUTE_MS,
  computeReviewPriority,
  createInitialReviewSchedule,
  isReviewDue,
  orderDueReviews,
  scheduleNextReview,
  type ReviewSchedule,
} from "../review";
import {
  advanceHintLevel,
  evaluateRemediation,
  isRemediationResolved,
  nextRetakeAtMs,
  retakeCooldownMs,
  type MisconceptionProbe,
} from "../remediation";

describe("spaced review scheduling", () => {
  it("starts with a same-session review", () => {
    const schedule = createInitialReviewSchedule("variables", 1_000);
    expect(schedule.intervalDays).toBe(0);
    expect(schedule.dueAtMs).toBe(1_000 + 15 * MINUTE_MS);
  });

  it("advances through configured intervals after clean recall", () => {
    const initial = createInitialReviewSchedule("variables", 0);
    const dayOne = scheduleNextReview(initial, "CLEAN", 1_000);
    const dayThree = scheduleNextReview(dayOne, "CLEAN", 2_000);
    expect(dayOne.intervalDays).toBe(1);
    expect(dayOne.dueAtMs).toBe(1_000 + DAY_MS);
    expect(dayThree.intervalDays).toBe(3);
    expect(dayThree.successfulReviews).toBe(2);
  });

  it("keeps the interval after assisted success", () => {
    const current: ReviewSchedule = {
      skillId: "variables",
      intervalIndex: 2,
      intervalDays: 3,
      dueAtMs: 0,
      successfulReviews: 2,
      lapses: 0,
    };
    const next = scheduleNextReview(current, "ASSISTED", 1_000);
    expect(next.intervalDays).toBe(3);
    expect(next.successfulReviews).toBe(2);
    expect(next.dueAtMs).toBe(1_000 + 3 * DAY_MS);
  });

  it("resets a failure to one day and records a lapse", () => {
    const current: ReviewSchedule = {
      skillId: "variables",
      intervalIndex: 4,
      intervalDays: 14,
      dueAtMs: 0,
      successfulReviews: 4,
      lapses: 1,
    };
    const next = scheduleNextReview(current, "FAILED", 1_000);
    expect(next.intervalIndex).toBe(1);
    expect(next.intervalDays).toBe(1);
    expect(next.lapses).toBe(2);
  });

  it("doubles mature intervals and caps them", () => {
    const current: ReviewSchedule = {
      skillId: "variables",
      intervalIndex: 5,
      intervalDays: 120,
      dueAtMs: 0,
      successfulReviews: 10,
      lapses: 0,
    };
    const next = scheduleNextReview(current, "CLEAN", 0);
    expect(next.intervalDays).toBe(180);
    const capped = scheduleNextReview(next, "CLEAN", 0);
    expect(capped.intervalDays).toBe(180);
  });

  it("treats the exact due instant as due", () => {
    expect(isReviewDue({ dueAtMs: 10 }, 10)).toBe(true);
    expect(isReviewDue({ dueAtMs: 11 }, 10)).toBe(false);
  });

  it("prioritizes goal relevance and overdue risk", () => {
    const base: ReviewSchedule = {
      skillId: "a",
      intervalIndex: 1,
      intervalDays: 1,
      dueAtMs: 0,
      successfulReviews: 0,
      lapses: 0,
    };
    const goal = computeReviewPriority({
      schedule: base,
      nowMs: DAY_MS,
      goalPriority: 2,
      prerequisiteCentrality: 0,
    });
    const unrelated = computeReviewPriority({
      schedule: { ...base, skillId: "b" },
      nowMs: DAY_MS,
      goalPriority: 0,
      prerequisiteCentrality: 0,
    });
    expect(goal).toBeGreaterThan(unrelated);
    expect(
      computeReviewPriority({
        schedule: { ...base, dueAtMs: DAY_MS * 2 },
        nowMs: DAY_MS,
        goalPriority: 100,
        prerequisiteCentrality: 100,
      }),
    ).toBe(0);
  });

  it("orders ties deterministically by skill ID", () => {
    const make = (skillId: string) => ({
      schedule: {
        skillId,
        intervalIndex: 1,
        intervalDays: 1,
        dueAtMs: 0,
        successfulReviews: 0,
        lapses: 0,
      },
      nowMs: 1,
      goalPriority: 0,
      prerequisiteCentrality: 0,
    });
    expect(
      orderDueReviews([make("z"), make("a")]).map(
        (item) => item.schedule.skillId,
      ),
    ).toEqual(["a", "z"]);
  });

  it("rejects malformed review policies", () => {
    expect(() =>
      createInitialReviewSchedule("x", 0, {
        intervalsDays: [0, 1, 1],
        sameSessionDelayMinutes: 15,
        matureGrowthFactor: 2,
        maxIntervalDays: 30,
      }),
    ).toThrow(RangeError);
  });
});

function probe(
  overrides: Partial<MisconceptionProbe> = {},
): MisconceptionProbe {
  return {
    id: "p1",
    misconceptionTag: "assignment",
    itemVariantId: "v1",
    correct: false,
    assistanceLevel: "A0",
    confidence: 0.5,
    occurredAtMs: 1,
    ...overrides,
  };
}

describe("remediation and hint policy", () => {
  it("requests confirmation after one failure", () => {
    const result = evaluateRemediation("assignment", [probe()]);
    expect(result.activateRemediation).toBe(false);
    expect(result.requestConfirmingProbe).toBe(true);
  });

  it("prioritizes a high-confidence wrong answer", () => {
    const result = evaluateRemediation("assignment", [
      probe({ confidence: 0.9 }),
    ]);
    expect(result.priority).toBe("HIGH");
  });

  it("requires distinct variants to confirm a misconception", () => {
    const sameVariant = evaluateRemediation("assignment", [
      probe({ id: "1" }),
      probe({ id: "2" }),
    ]);
    expect(sameVariant.activateRemediation).toBe(false);

    const distinct = evaluateRemediation("assignment", [
      probe({ id: "1", itemVariantId: "v1" }),
      probe({ id: "2", itemVariantId: "v2" }),
    ]);
    expect(distinct.activateRemediation).toBe(true);
  });

  it("does not use assisted errors as confirmation", () => {
    const result = evaluateRemediation("assignment", [
      probe({ itemVariantId: "v1" }),
      probe({ itemVariantId: "v2", assistanceLevel: "A2" }),
    ]);
    expect(result.distinctConfirmingFailures).toBe(1);
  });

  it("requires two clean distinct successes to resolve remediation", () => {
    expect(
      isRemediationResolved("assignment", [
        probe({ correct: true, itemVariantId: "v1" }),
        probe({ correct: true, itemVariantId: "v1" }),
      ]),
    ).toBe(false);
    expect(
      isRemediationResolved("assignment", [
        probe({ correct: true, itemVariantId: "v1" }),
        probe({ correct: true, itemVariantId: "v2" }),
      ]),
    ).toBe(true);
  });

  it("does not resolve with hinted successes", () => {
    expect(
      isRemediationResolved("assignment", [
        probe({ correct: true, itemVariantId: "v1" }),
        probe({
          correct: true,
          itemVariantId: "v2",
          assistanceLevel: "A1",
        }),
      ]),
    ).toBe(false);
  });

  it("progresses hints and marks full reveal requirements", () => {
    expect(advanceHintLevel(0)).toEqual({
      nextLevel: 1,
      solutionRevealed: false,
      requiresSelfExplanation: false,
      requiresFreshVariant: false,
    });
    expect(advanceHintLevel(5)).toEqual({
      nextLevel: 6,
      solutionRevealed: true,
      requiresSelfExplanation: true,
      requiresFreshVariant: true,
    });
    expect(advanceHintLevel(6).nextLevel).toBe(6);
  });

  it("uses size-dependent cooldowns and waives incidents", () => {
    expect(retakeCooldownMs(10)).toBe(60 * 60 * 1_000);
    expect(retakeCooldownMs(11)).toBe(6 * 60 * 60 * 1_000);
    expect(retakeCooldownMs(31)).toBe(24 * 60 * 60 * 1_000);
    expect(retakeCooldownMs(120, true)).toBe(0);
  });

  it("requires remediation before a normal retake", () => {
    expect(nextRetakeAtMs(1_000, 10, false)).toBeNull();
    expect(nextRetakeAtMs(1_000, 10, true)).toBe(
      1_000 + 60 * 60 * 1_000,
    );
    expect(nextRetakeAtMs(1_000, 10, false, true)).toBe(1_000);
  });
});
