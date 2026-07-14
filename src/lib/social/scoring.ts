export const LEADERBOARD_FORMULA_VERSION = "cohort-score-2026-07.v1";

export type LeaderboardPeriodKind = "weekly" | "all_time";
export type XpEvidenceTier = "easy" | "standard" | "challenging";

export interface LeaderboardEvidenceInput {
  readonly meaningfulDayKeys: readonly string[];
  readonly newMasteryEvidenceIds: readonly string[];
  readonly projectEvidenceIds: readonly string[];
  readonly comebackEvidenceIds: readonly string[];
  readonly xpEvents: readonly {
    readonly evidenceKey: string;
    readonly tier: XpEvidenceTier;
    readonly eligible: boolean;
  }[];
}

export interface LeaderboardScore {
  readonly formulaVersion: typeof LEADERBOARD_FORMULA_VERSION;
  readonly periodKind: LeaderboardPeriodKind;
  readonly totalPoints: number;
  readonly components: {
    readonly consistency: number;
    readonly newMastery: number;
    readonly projects: number;
    readonly comeback: number;
    readonly xp: number;
  };
  readonly counts: {
    readonly consistencyDays: number;
    readonly newMasteries: number;
    readonly projectMilestones: number;
    readonly comebacks: number;
    readonly xpEvents: number;
    readonly easyXpEvents: number;
  };
  readonly acceptedEvidence: {
    readonly meaningfulDayKeys: readonly string[];
    readonly newMasteryEvidenceIds: readonly string[];
    readonly projectEvidenceIds: readonly string[];
    readonly comebackEvidenceIds: readonly string[];
    readonly xpEvidenceKeys: readonly string[];
  };
}

const POLICY = Object.freeze({
  weekly: {
    consistencyDays: 5,
    newMasteries: 5,
    projects: 2,
    comebacks: 2,
    xpPoints: 60,
    easyXpEvents: 3,
  },
  all_time: {
    consistencyDays: 30,
    newMasteries: 50,
    projects: 10,
    comebacks: 10,
    xpPoints: 500,
    easyXpEvents: 20,
  },
} as const);

export const LEADERBOARD_FORMULA_PUBLIC = Object.freeze({
  version: LEADERBOARD_FORMULA_VERSION,
  components: {
    consistency: "12 points per distinct meaningful learning day, capped by period.",
    newMastery: "100 points per first independently supported concept mastery, capped by period.",
    projects: "150 points per first reviewed project milestone, capped by period.",
    comeback: "40 points per distinct remediation recovery, capped by period.",
    xp: "2/4/6 points for unique eligible easy/standard/challenging evidence; easy and total XP are capped.",
  },
  excludedSignals: [
    "completion speed",
    "hours online",
    "submission count",
    "replayed activities",
    "hints or revealed solutions",
    "AI or token spending",
  ],
});

const XP_POINTS: Readonly<Record<XpEvidenceTier, number>> = Object.freeze({
  easy: 2,
  standard: 4,
  challenging: 6,
});

function uniqueBounded(values: readonly string[], maximum: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort().slice(0, maximum);
}

function validDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const normalized = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10);
  return normalized === value;
}

/** Pure, order-independent, duplicate-resistant scoring function. */
export function scoreLeaderboardEvidence(
  periodKind: LeaderboardPeriodKind,
  input: LeaderboardEvidenceInput,
): LeaderboardScore {
  const policy = POLICY[periodKind];
  const meaningfulDayKeys = uniqueBounded(input.meaningfulDayKeys.filter(validDay), policy.consistencyDays);
  const mastery = uniqueBounded(input.newMasteryEvidenceIds, policy.newMasteries);
  const projects = uniqueBounded(input.projectEvidenceIds, policy.projects);
  const comeback = uniqueBounded(input.comebackEvidenceIds, policy.comebacks);

  // Resolve duplicate keys to the highest independently eligible tier, then
  // select stronger evidence first. This prevents order from changing a score.
  const tierByKey = new Map<string, XpEvidenceTier>();
  const tierRank: Readonly<Record<XpEvidenceTier, number>> = { easy: 0, standard: 1, challenging: 2 };
  for (const event of input.xpEvents) {
    const key = event.evidenceKey.trim();
    if (!event.eligible || !key) continue;
    const prior = tierByKey.get(key);
    if (!prior || tierRank[event.tier] > tierRank[prior]) tierByKey.set(key, event.tier);
  }
  const orderedXp = [...tierByKey.entries()].sort((left, right) =>
    tierRank[right[1]] - tierRank[left[1]] || left[0].localeCompare(right[0]));
  let easyCount = 0;
  let xpPoints = 0;
  const xpEvidenceKeys: string[] = [];
  for (const [key, tier] of orderedXp) {
    if (tier === "easy" && easyCount >= policy.easyXpEvents) continue;
    const points = XP_POINTS[tier];
    if (xpPoints + points > policy.xpPoints) continue;
    if (tier === "easy") easyCount += 1;
    xpPoints += points;
    xpEvidenceKeys.push(key);
  }

  const components = {
    consistency: meaningfulDayKeys.length * 12,
    newMastery: mastery.length * 100,
    projects: projects.length * 150,
    comeback: comeback.length * 40,
    xp: xpPoints,
  };
  return {
    formulaVersion: LEADERBOARD_FORMULA_VERSION,
    periodKind,
    totalPoints: Object.values(components).reduce((sum, value) => sum + value, 0),
    components,
    counts: {
      consistencyDays: meaningfulDayKeys.length,
      newMasteries: mastery.length,
      projectMilestones: projects.length,
      comebacks: comeback.length,
      xpEvents: xpEvidenceKeys.length,
      easyXpEvents: easyCount,
    },
    acceptedEvidence: {
      meaningfulDayKeys,
      newMasteryEvidenceIds: mastery,
      projectEvidenceIds: projects,
      comebackEvidenceIds: comeback,
      xpEvidenceKeys,
    },
  };
}

export function leaderboardPeriod(kind: LeaderboardPeriodKind, now: Date) {
  if (!Number.isFinite(now.getTime())) throw new RangeError("A valid scoring time is required.");
  if (kind === "all_time") {
    return { kind, key: "all-time", start: new Date("2000-01-01T00:00:00.000Z"), end: null } as const;
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const mondayOffset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  return { kind, key: `weekly:${start.toISOString().slice(0, 10)}`, start, end } as const;
}
