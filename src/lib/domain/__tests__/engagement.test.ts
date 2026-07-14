import { describe, expect, it } from "vitest";
import {
  awardXp,
  isMeaningfulStreakEvent,
  updateStreak,
  type EngagementEvent,
  type StreakState,
  type XpLedger,
} from "../engagement";

function event(
  overrides: Partial<EngagementEvent> = {},
): EngagementEvent {
  return {
    id: "event-1",
    evidenceKey: "user:java:variables:E4:variant-1:2026-07-12",
    dayKey: "2026-07-12",
    kind: "INDEPENDENT_SUCCESS",
    meaningful: true,
    exactReplay: false,
    solutionRevealed: false,
    assistanceLevel: "A0",
    ...overrides,
  };
}

function ledger(overrides: Partial<XpLedger> = {}): XpLedger {
  return {
    awardedByEvidenceKey: {},
    dailyTotals: {},
    ...overrides,
  };
}

function streak(overrides: Partial<StreakState> = {}): StreakState {
  return {
    current: 0,
    best: 0,
    freezesRemaining: 0,
    ...overrides,
  };
}

describe("XP anti-farming", () => {
  it("awards server-policy points for first meaningful evidence", () => {
    const result = awardXp(ledger(), event());
    expect(result.awarded).toBe(15);
    expect(result.leaderboardEligible).toBe(15);
    expect(result.reason).toBe("AWARDED");
    expect(result.ledger.dailyTotals["2026-07-12"]).toBe(15);
  });

  it("is immutable", () => {
    const initial = ledger();
    const result = awardXp(initial, event());
    expect(result.ledger).not.toBe(initial);
    expect(initial).toEqual({
      awardedByEvidenceKey: {},
      dailyTotals: {},
    });
  });

  it("does not award the same evidence key twice", () => {
    const first = awardXp(ledger(), event());
    const second = awardXp(first.ledger, event());
    expect(second.awarded).toBe(0);
    expect(second.reason).toBe("DUPLICATE");
    expect(second.ledger).toBe(first.ledger);
  });

  it.each([
    [{ meaningful: false }, "NOT_MEANINGFUL"],
    [{ exactReplay: true }, "REPLAY"],
    [{ kind: "REPLAY" as const }, "REPLAY"],
    [{ solutionRevealed: true }, "REVEALED"],
    [
      { assistanceLevel: "A2" as const },
      "ASSISTED_INDEPENDENT_CLAIM",
    ],
  ])("blocks non-qualifying activity %#", (overrides, reason) => {
    const result = awardXp(ledger(), event(overrides));
    expect(result.awarded).toBe(0);
    expect(result.reason).toBe(reason);
    expect(
      Object.prototype.hasOwnProperty.call(
        result.ledger.awardedByEvidenceKey,
        event(overrides).evidenceKey,
      ),
    ).toBe(true);
  });

  it("allows assisted XP for a new learning step", () => {
    const result = awardXp(
      ledger(),
      event({ kind: "NEW_STEP", assistanceLevel: "A2" }),
    );
    expect(result.awarded).toBe(5);
  });

  it("partially awards at the daily cap", () => {
    const result = awardXp(
      ledger({ dailyTotals: { "2026-07-12": 95 } }),
      event(),
    );
    expect(result.awarded).toBe(5);
    expect(result.ledger.dailyTotals["2026-07-12"]).toBe(100);
  });

  it("consumes evidence without backfill when cap is already reached", () => {
    const first = awardXp(
      ledger({ dailyTotals: { "2026-07-12": 100 } }),
      event(),
    );
    expect(first.reason).toBe("DAILY_CAP");
    const retry = awardXp(first.ledger, event());
    expect(retry.reason).toBe("DUPLICATE");
  });

  it("rejects malformed evidence keys and dates", () => {
    expect(() =>
      awardXp(ledger(), event({ evidenceKey: " " })),
    ).toThrow(/evidenceKey/);
    expect(() =>
      awardXp(ledger(), event({ dayKey: "2026-02-30" })),
    ).toThrow(/real calendar date/);
  });
});

describe("streaks", () => {
  it("starts a streak on the first meaningful day", () => {
    const result = updateStreak(streak(), event());
    expect(result).toEqual({
      counted: true,
      reason: "COUNTED",
      state: {
        current: 1,
        best: 1,
        freezesRemaining: 0,
        lastActiveDayKey: "2026-07-12",
      },
    });
  });

  it("counts at most once per day", () => {
    const current = streak({
      current: 3,
      best: 3,
      lastActiveDayKey: "2026-07-12",
    });
    const result = updateStreak(current, event());
    expect(result.counted).toBe(false);
    expect(result.reason).toBe("SAME_DAY");
    expect(result.state).toBe(current);
  });

  it("increments on a consecutive day", () => {
    const result = updateStreak(
      streak({
        current: 3,
        best: 5,
        lastActiveDayKey: "2026-07-12",
      }),
      event({ dayKey: "2026-07-13" }),
    );
    expect(result.state.current).toBe(4);
    expect(result.state.best).toBe(5);
  });

  it("uses freezes to cover missed days", () => {
    const result = updateStreak(
      streak({
        current: 3,
        best: 3,
        freezesRemaining: 2,
        lastActiveDayKey: "2026-07-12",
      }),
      event({ dayKey: "2026-07-15" }),
    );
    expect(result.state.current).toBe(4);
    expect(result.state.freezesRemaining).toBe(0);
    expect(result.state.best).toBe(4);
  });

  it("resets current streak without deleting the best streak", () => {
    const result = updateStreak(
      streak({
        current: 5,
        best: 8,
        freezesRemaining: 1,
        lastActiveDayKey: "2026-07-12",
      }),
      event({ dayKey: "2026-07-15" }),
    );
    expect(result.state.current).toBe(1);
    expect(result.state.best).toBe(8);
    expect(result.state.freezesRemaining).toBe(1);
  });

  it("ignores out-of-order activity", () => {
    const current = streak({
      current: 2,
      best: 2,
      lastActiveDayKey: "2026-07-12",
    });
    const result = updateStreak(
      current,
      event({ dayKey: "2026-07-11" }),
    );
    expect(result.reason).toBe("OUT_OF_ORDER");
    expect(result.state).toBe(current);
  });

  it("does not count replay or revealed activity", () => {
    expect(isMeaningfulStreakEvent(event({ exactReplay: true }))).toBe(
      false,
    );
    const current = streak();
    const result = updateStreak(
      current,
      event({ solutionRevealed: true }),
    );
    expect(result.reason).toBe("NOT_MEANINGFUL");
    expect(result.state).toBe(current);
  });

  it("rejects non-ISO and impossible day keys", () => {
    expect(() =>
      updateStreak(streak(), event({ dayKey: "12-07-2026" })),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      updateStreak(streak(), event({ dayKey: "2026-13-01" })),
    ).toThrow(/real calendar date/);
  });
});
