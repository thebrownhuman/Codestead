import { describe, expect, it } from "vitest";

import { selectNextAction } from "@/lib/domain";
import { countSessionActions } from "../session-action-counts";

describe("countSessionActions", () => {
  it("never reports more review actions than completed actions", () => {
    // review_completed is browser telemetry and is never stored as meaningful;
    // only lesson_completed is. A session with reviews but no lesson completion
    // must still produce counts the recommender accepts.
    const counts = countSessionActions([
      { type: "review_completed", metadata: { meaningful: false } },
      { type: "review_completed", metadata: {} },
      { type: "lesson_started", metadata: { meaningful: false } },
    ]);

    expect(counts).toEqual({ completedActions: 2, reviewActions: 2 });
    expect(() =>
      selectNextAction({
        components: [],
        progress: [],
        reviewSchedules: [],
        currentGoalSkillIds: new Set(),
        challengeAvailableSkillIds: new Set(),
        nowMs: 0,
        session: counts,
      }),
    ).not.toThrow();
  });

  it("counts meaningful events and reviews together as completed actions", () => {
    expect(
      countSessionActions([
        { type: "lesson_completed", metadata: { meaningful: true } },
        { type: "review_completed", metadata: { meaningful: false } },
        { type: "heartbeat", metadata: { meaningful: false } },
      ]),
    ).toEqual({ completedActions: 2, reviewActions: 1 });
  });
});
