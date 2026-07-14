import { describe, expect, it } from "vitest";

import {
  LEADERBOARD_FORMULA_PUBLIC,
  leaderboardPeriod,
  scoreLeaderboardEvidence,
  type LeaderboardEvidenceInput,
} from "../scoring";

function evidence(overrides: Partial<LeaderboardEvidenceInput> = {}): LeaderboardEvidenceInput {
  return {
    meaningfulDayKeys: [],
    newMasteryEvidenceIds: [],
    projectEvidenceIds: [],
    comebackEvidenceIds: [],
    xpEvents: [],
    ...overrides,
  };
}

function shuffle<T>(values: readonly T[], seed: number): T[] {
  const copy = [...values];
  let state = seed + 1;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [copy[index], copy[target]] = [copy[target]!, copy[index]!];
  }
  return copy;
}

describe("privacy-safe leaderboard formula", () => {
  it("is deterministic, order-independent, and duplicate-resistant", () => {
    const base = evidence({
      meaningfulDayKeys: ["2026-07-06", "2026-07-07", "2026-07-07", "invalid"],
      newMasteryEvidenceIds: ["mastery-b", "mastery-a", "mastery-a"],
      projectEvidenceIds: ["project-a", "project-a"],
      comebackEvidenceIds: ["recovery-a"],
      xpEvents: [
        { evidenceKey: "easy-a", tier: "easy", eligible: true },
        { evidenceKey: "easy-a", tier: "easy", eligible: true },
        { evidenceKey: "standard-a", tier: "standard", eligible: true },
        { evidenceKey: "standard-a", tier: "challenging", eligible: true },
        { evidenceKey: "ignored", tier: "challenging", eligible: false },
      ],
    });
    const expected = scoreLeaderboardEvidence("weekly", base);
    for (let seed = 0; seed < 100; seed += 1) {
      expect(scoreLeaderboardEvidence("weekly", {
        meaningfulDayKeys: shuffle(base.meaningfulDayKeys, seed),
        newMasteryEvidenceIds: shuffle(base.newMasteryEvidenceIds, seed),
        projectEvidenceIds: shuffle(base.projectEvidenceIds, seed),
        comebackEvidenceIds: shuffle(base.comebackEvidenceIds, seed),
        xpEvents: shuffle(base.xpEvents, seed),
      })).toEqual(expected);
    }
  });

  it("caps spam, repeated easy work, and every public component", () => {
    const spam = Array.from({ length: 2_000 }, (_, index) => `evidence-${index}`);
    const score = scoreLeaderboardEvidence("weekly", evidence({
      meaningfulDayKeys: Array.from({ length: 100 }, (_, index) => `2026-07-${String((index % 5) + 6).padStart(2, "0")}`),
      newMasteryEvidenceIds: spam,
      projectEvidenceIds: spam,
      comebackEvidenceIds: spam,
      xpEvents: spam.map((evidenceKey) => ({ evidenceKey, tier: "easy" as const, eligible: true })),
    }));
    expect(score.components).toEqual({ consistency: 60, newMastery: 500, projects: 300, comeback: 80, xp: 6 });
    expect(score.counts.easyXpEvents).toBe(3);
    expect(score.totalPoints).toBe(946);

    const challenging = scoreLeaderboardEvidence("weekly", evidence({
      xpEvents: spam.map((evidenceKey) => ({ evidenceKey, tier: "challenging" as const, eligible: true })),
    }));
    expect(challenging.components.xp).toBe(60);
    expect(challenging.totalPoints).toBe(60);
  });

  it("never uses speed, hours, submissions, hints, tokens, or replay count", () => {
    expect(Object.keys(evidence())).toEqual([
      "meaningfulDayKeys", "newMasteryEvidenceIds", "projectEvidenceIds", "comebackEvidenceIds", "xpEvents",
    ]);
    expect(LEADERBOARD_FORMULA_PUBLIC.excludedSignals).toEqual(expect.arrayContaining([
      "completion speed", "hours online", "submission count", "replayed activities", "hints or revealed solutions", "AI or token spending",
    ]));
    const once = scoreLeaderboardEvidence("weekly", evidence({
      xpEvents: [{ evidenceKey: "same-activity", tier: "easy", eligible: true }],
    }));
    const repeated = scoreLeaderboardEvidence("weekly", evidence({
      xpEvents: Array.from({ length: 10_000 }, () => ({ evidenceKey: "same-activity", tier: "easy" as const, eligible: true })),
    }));
    expect(repeated).toEqual(once);
  });

  it("uses stable UTC Monday weekly boundaries and a distinct all-time scope", () => {
    expect(leaderboardPeriod("weekly", new Date("2026-07-12T23:59:59.000Z"))).toEqual({
      kind: "weekly",
      key: "weekly:2026-07-06",
      start: new Date("2026-07-06T00:00:00.000Z"),
      end: new Date("2026-07-13T00:00:00.000Z"),
    });
    expect(leaderboardPeriod("all_time", new Date("2026-07-12T00:00:00.000Z"))).toMatchObject({ kind: "all_time", key: "all-time", end: null });
    expect(() => leaderboardPeriod("weekly", new Date(Number.NaN))).toThrow(RangeError);
  });
});
