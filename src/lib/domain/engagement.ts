import type { AssistanceLevel } from "./types";

export type EngagementActivityKind =
  | "NEW_STEP"
  | "INDEPENDENT_SUCCESS"
  | "DUE_REVIEW"
  | "REMEDIATION_RECOVERY"
  | "PROJECT_MILESTONE"
  | "EXAM"
  | "REPLAY";

export interface EngagementEvent {
  readonly id: string;
  readonly evidenceKey: string;
  readonly dayKey: string;
  readonly kind: EngagementActivityKind;
  readonly meaningful: boolean;
  readonly exactReplay: boolean;
  readonly solutionRevealed: boolean;
  readonly assistanceLevel: AssistanceLevel;
}

export interface XpPolicy {
  readonly points: Readonly<Record<EngagementActivityKind, number>>;
  readonly dailyCap: number;
}

export interface XpLedger {
  readonly awardedByEvidenceKey: Readonly<Record<string, number>>;
  readonly dailyTotals: Readonly<Record<string, number>>;
}

export interface XpAwardResult {
  readonly awarded: number;
  readonly leaderboardEligible: number;
  readonly reason:
    | "AWARDED"
    | "DUPLICATE"
    | "NOT_MEANINGFUL"
    | "REPLAY"
    | "REVEALED"
    | "ASSISTED_INDEPENDENT_CLAIM"
    | "DAILY_CAP";
  readonly ledger: XpLedger;
}

export interface StreakState {
  readonly current: number;
  readonly best: number;
  readonly lastActiveDayKey?: string;
  readonly freezesRemaining: number;
}

export interface StreakUpdate {
  readonly state: StreakState;
  readonly counted: boolean;
  readonly reason:
    | "COUNTED"
    | "SAME_DAY"
    | "NOT_MEANINGFUL"
    | "OUT_OF_ORDER";
}

export const DEFAULT_XP_POLICY: XpPolicy = Object.freeze({
  points: Object.freeze({
    NEW_STEP: 5,
    INDEPENDENT_SUCCESS: 15,
    DUE_REVIEW: 5,
    REMEDIATION_RECOVERY: 10,
    PROJECT_MILESTONE: 20,
    EXAM: 20,
    REPLAY: 0,
  }),
  dailyCap: 100,
});

function parseDayKey(dayKey: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (match === null) {
    throw new Error("dayKey must use YYYY-MM-DD");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epoch = Date.UTC(year, month - 1, day);
  const normalized = new Date(epoch).toISOString().slice(0, 10);
  if (normalized !== dayKey) {
    throw new Error("dayKey must be a real calendar date");
  }
  return epoch;
}

function validateXpPolicy(policy: XpPolicy): void {
  if (!Number.isFinite(policy.dailyCap) || policy.dailyCap < 0) {
    throw new RangeError("dailyCap must be a finite non-negative number");
  }
  for (const [kind, points] of Object.entries(policy.points)) {
    if (!Number.isFinite(points) || points < 0) {
      throw new RangeError(
        `XP points for ${kind} must be a finite non-negative number`,
      );
    }
  }
}

function hasOwn(record: Readonly<Record<string, number>>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function awardXp(
  ledger: XpLedger,
  event: EngagementEvent,
  policy: XpPolicy = DEFAULT_XP_POLICY,
): XpAwardResult {
  validateXpPolicy(policy);
  parseDayKey(event.dayKey);
  if (event.evidenceKey.trim() === "") {
    throw new Error("evidenceKey must not be empty");
  }

  const withConsumedKey = (awarded: number): XpLedger => ({
    awardedByEvidenceKey: {
      ...ledger.awardedByEvidenceKey,
      [event.evidenceKey]: awarded,
    },
    dailyTotals: {
      ...ledger.dailyTotals,
      [event.dayKey]:
        (ledger.dailyTotals[event.dayKey] ?? 0) + awarded,
    },
  });
  const noAward = (
    reason: Exclude<XpAwardResult["reason"], "AWARDED" | "DUPLICATE">,
  ): XpAwardResult => ({
    awarded: 0,
    leaderboardEligible: 0,
    reason,
    ledger: withConsumedKey(0),
  });

  if (hasOwn(ledger.awardedByEvidenceKey, event.evidenceKey)) {
    return {
      awarded: 0,
      leaderboardEligible: 0,
      reason: "DUPLICATE",
      ledger,
    };
  }
  if (!event.meaningful) {
    return noAward("NOT_MEANINGFUL");
  }
  if (event.kind === "REPLAY" || event.exactReplay) {
    return noAward("REPLAY");
  }
  if (event.solutionRevealed) {
    return noAward("REVEALED");
  }
  if (
    event.kind === "INDEPENDENT_SUCCESS" &&
    event.assistanceLevel !== "A0"
  ) {
    return noAward("ASSISTED_INDEPENDENT_CLAIM");
  }

  const desired = policy.points[event.kind];
  const alreadyToday = ledger.dailyTotals[event.dayKey] ?? 0;
  const awarded = Math.max(
    0,
    Math.min(desired, policy.dailyCap - alreadyToday),
  );
  if (awarded === 0) {
    return noAward("DAILY_CAP");
  }

  return {
    awarded,
    leaderboardEligible: awarded,
    reason: "AWARDED",
    ledger: withConsumedKey(awarded),
  };
}

export function isMeaningfulStreakEvent(event: EngagementEvent): boolean {
  return (
    event.meaningful &&
    !event.exactReplay &&
    !event.solutionRevealed &&
    event.kind !== "REPLAY"
  );
}

export function updateStreak(
  current: StreakState,
  event: EngagementEvent,
): StreakUpdate {
  const eventDay = parseDayKey(event.dayKey);
  if (!isMeaningfulStreakEvent(event)) {
    return {
      state: current,
      counted: false,
      reason: "NOT_MEANINGFUL",
    };
  }

  if (current.lastActiveDayKey === undefined) {
    const next = { ...current, current: 1, best: Math.max(1, current.best), lastActiveDayKey: event.dayKey };
    return { state: next, counted: true, reason: "COUNTED" };
  }

  const previousDay = parseDayKey(current.lastActiveDayKey);
  const differenceDays = (eventDay - previousDay) / 86_400_000;
  if (differenceDays < 0) {
    return {
      state: current,
      counted: false,
      reason: "OUT_OF_ORDER",
    };
  }
  if (differenceDays === 0) {
    return { state: current, counted: false, reason: "SAME_DAY" };
  }

  const missedDays = differenceDays - 1;
  const coveredByFreeze = missedDays <= current.freezesRemaining;
  const nextCurrent =
    differenceDays === 1 || coveredByFreeze ? current.current + 1 : 1;
  const freezesRemaining =
    differenceDays > 1 && coveredByFreeze
      ? current.freezesRemaining - missedDays
      : current.freezesRemaining;
  const next: StreakState = {
    current: nextCurrent,
    best: Math.max(current.best, nextCurrent),
    lastActiveDayKey: event.dayKey,
    freezesRemaining,
  };
  return { state: next, counted: true, reason: "COUNTED" };
}
