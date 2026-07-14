import { describe, expect, it } from "vitest";

import { learnerLocalDate } from "../service";
import { selectDailyReviewCandidates } from "../selector";
import type { DailyReviewCandidate } from "../types";

function candidate(
  skillId: string,
  overrides: Partial<DailyReviewCandidate> = {},
): DailyReviewCandidate {
  return {
    skillId,
    skillTitle: skillId,
    courseSlug: "python",
    courseTitle: "Python",
    conceptId: `concept-${skillId}`,
    enrollmentId: "enrollment-1",
    confidence: 0.5,
    hasConfirmedMisconception: false,
    overdueAt: null,
    ...overrides,
  };
}

describe("daily review selector", () => {
  it("orders confirmed misconceptions, overdue reviews, then lowest confidence", () => {
    const selected = selectDailyReviewCandidates([
      candidate("confidence-high", { confidence: 0.8 }),
      candidate("overdue-newer", { confidence: 0.1, overdueAt: new Date("2026-07-12T00:00:00Z") }),
      candidate("misconception", { confidence: 0.9, hasConfirmedMisconception: true }),
      candidate("confidence-low", { confidence: 0.2 }),
      candidate("overdue-older", { confidence: 0.9, overdueAt: new Date("2026-07-10T00:00:00Z") }),
    ]);

    expect(selected.map((item) => item.skillId)).toEqual([
      "misconception",
      "overdue-older",
      "overdue-newer",
      "confidence-low",
      "confidence-high",
    ]);
    expect(selected.map((item) => item.priorityReason)).toEqual([
      "confirmed_misconception",
      "overdue_review",
      "overdue_review",
      "lowest_confidence",
      "lowest_confidence",
    ]);
  });

  it("is deterministic, clamps confidence, and never reserves a skill twice", () => {
    const input = [
      candidate("same", { confidence: 4 }),
      candidate("same", { confidence: -2, hasConfirmedMisconception: true }),
      candidate("b", { confidence: Number.NaN }),
      candidate("a", { confidence: 0 }),
      candidate("c", { confidence: 0.1 }),
      candidate("d", { confidence: 0.2 }),
      candidate("e", { confidence: 0.3 }),
    ];
    const first = selectDailyReviewCandidates(input);
    const second = selectDailyReviewCandidates([...input].reverse());

    expect(first).toEqual(second);
    expect(first).toHaveLength(5);
    expect(new Set(first.map((item) => item.skillId)).size).toBe(5);
    expect(first[0]).toMatchObject({ skillId: "same", confidence: 0, priorityReason: "confirmed_misconception" });
  });

  it("returns fewer than five rather than fabricating an unsafe question", () => {
    expect(selectDailyReviewCandidates([candidate("one"), candidate("two")])).toHaveLength(2);
  });
});

describe("learner-local daily boundary", () => {
  it("uses the stored IANA timezone and safely falls back for invalid values", () => {
    const instant = new Date("2026-07-12T20:00:00.000Z");
    expect(learnerLocalDate(instant, "Asia/Kolkata")).toBe("2026-07-13");
    expect(learnerLocalDate(instant, "America/Los_Angeles")).toBe("2026-07-12");
    expect(learnerLocalDate(instant, "not/a-zone")).toBe("2026-07-12");
  });
});
