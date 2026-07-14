import { redactSensitiveText } from "@/lib/security/sensitive-text";

export const MENTOR_POLICY_VERSION = "personalized-mentor-v1";

export const MENTOR_POLICY_LIMITS = Object.freeze({
  masteryRows: 40,
  recentAttempts: 20,
  misconceptionTagsPerSkill: 8,
  skillIdChars: 180,
  skillTitleChars: 180,
  lookbackDays: 30,
} as const);

const SAFE_SKILL_ID = /^[a-z0-9][a-z0-9_.:-]{0,179}$/i;
const SAFE_TAG = /^[a-z][a-z0-9_.-]{1,63}$/;
const VALID_MASTERY_STATUSES = new Set(["unseen", "learning", "practicing", "proficient", "mastered", "needs_review"]);
const VALID_ATTEMPT_SOURCES = new Set(["deterministic_attempt", "verified_runner"]);

export type MentorMasterySignal = Readonly<{
  ownerUserId: string;
  skillId: string;
  skillTitle: string;
  mastery: number;
  confidence: number;
  status: string;
  nextReviewAt: string | null;
  lastPracticedAt: string | null;
  activeMisconceptionTags: readonly string[];
  verifiedEvidenceCount: number;
}>;

export type MentorAttemptSignal = Readonly<{
  ownerUserId: string;
  skillId: string;
  occurredAt: string;
  score: number | null;
  passed: boolean | null;
  assistanceLevel: "A0" | "A1" | "A2" | "A3" | "A4";
  solutionRevealed: boolean;
  sourceType: string;
  validity: string;
}>;

export type MentorPolicyInput = Readonly<{
  authenticatedUserId: string;
  now: Date;
  masterySignals: readonly MentorMasterySignal[];
  recentAttempts: readonly MentorAttemptSignal[];
  officialPlan: null | {
    ownerUserId: string;
    revisionId: string;
    nextSkillId: string | null;
  };
}>;

type Pace = "accelerating" | "steady" | "needs_support" | "insufficient_evidence";
type Confidence = "high" | "developing" | "low" | "insufficient_evidence";
type ChallengeReason = "confirmed_misconception" | "overdue_review" | "recent_struggle" | "lowest_confidence";

type SafeMastery = Omit<MentorMasterySignal, "ownerUserId" | "activeMisconceptionTags"> & {
  activeMisconceptionTags: string[];
};
type SafeAttempt = Omit<MentorAttemptSignal, "ownerUserId"> & { occurredAtMs: number };

export type MentorRecommendation = Readonly<{
  state: "ready";
  policyVersion: typeof MENTOR_POLICY_VERSION;
  dailyChallenge: {
    skillId: string;
    skillTitle: string;
    reason: ChallengeReason;
    reasonText: string;
    instruction: string;
    targetMinutes: number;
    source: "stored_verified_evidence";
  };
  learningSignal: {
    pace: Pace;
    confidence: Confidence;
    evidence: {
      verifiedMasteryRows: number;
      verifiedRecentAttempts: number;
      lookbackDays: number;
    };
  };
  encouragement: string;
  planSuggestion: null | {
    kind: "request_admin_plan_review";
    skillId: string;
    reason: string;
  };
  authority: {
    officialPlanChanged: false;
    officialPlanRevisionId: string | null;
    statement: string;
  };
  contextPolicy: {
    ownerBound: true;
    included: readonly string[];
    explicitlyExcluded: readonly string[];
    caps: typeof MENTOR_POLICY_LIMITS;
  };
}> | Readonly<{
  state: "unavailable";
  policyVersion: typeof MENTOR_POLICY_VERSION;
  reason: "owner_scope_mismatch" | "invalid_clock" | "insufficient_verified_evidence";
  message: string;
  authority: {
    officialPlanChanged: false;
    officialPlanRevisionId: null;
  };
}>;

function probability(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function time(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function safeMastery(row: MentorMasterySignal): SafeMastery | null {
  const mastery = probability(row.mastery);
  const confidence = probability(row.confidence);
  const safeSkillId = redactSensitiveText(row.skillId, MENTOR_POLICY_LIMITS.skillIdChars);
  if (
    !SAFE_SKILL_ID.test(row.skillId)
    || safeSkillId.redacted
    || mastery === null
    || confidence === null
    || !VALID_MASTERY_STATUSES.has(row.status)
    || !Number.isSafeInteger(row.verifiedEvidenceCount)
    || row.verifiedEvidenceCount < 1
  ) return null;
  return {
    skillId: safeSkillId.text,
    skillTitle: redactSensitiveText(row.skillTitle, MENTOR_POLICY_LIMITS.skillTitleChars).text,
    mastery,
    confidence,
    status: row.status,
    nextReviewAt: time(row.nextReviewAt) === null ? null : new Date(time(row.nextReviewAt)!).toISOString(),
    lastPracticedAt: time(row.lastPracticedAt) === null ? null : new Date(time(row.lastPracticedAt)!).toISOString(),
    activeMisconceptionTags: [...new Set(row.activeMisconceptionTags)]
      .flatMap((tag) => {
        const safe = redactSensitiveText(tag, 64);
        return !safe.redacted && SAFE_TAG.test(safe.text) ? [safe.text] : [];
      })
      .slice(0, MENTOR_POLICY_LIMITS.misconceptionTagsPerSkill),
    verifiedEvidenceCount: row.verifiedEvidenceCount,
  };
}

function safeAttempt(row: MentorAttemptSignal, earliest: number): SafeAttempt | null {
  const occurredAtMs = time(row.occurredAt);
  const score = row.score === null ? null : probability(row.score);
  const safeSkillId = redactSensitiveText(row.skillId, MENTOR_POLICY_LIMITS.skillIdChars);
  if (
    !SAFE_SKILL_ID.test(row.skillId)
    || safeSkillId.redacted
    || occurredAtMs === null
    || occurredAtMs < earliest
    || (row.score !== null && score === null)
    || !VALID_ATTEMPT_SOURCES.has(row.sourceType)
    || row.validity !== "valid"
  ) return null;
  return { ...row, skillId: safeSkillId.text, score, occurredAtMs };
}

function measuredAttempt(row: SafeAttempt) {
  const base = row.score ?? (row.passed === null ? 0.5 : row.passed ? 1 : 0);
  const assistancePenalty = Number(row.assistanceLevel.slice(1)) * 0.05;
  return Math.max(0, Math.min(1, base - assistancePenalty - (row.solutionRevealed ? 0.2 : 0)));
}

function paceFor(attempts: readonly SafeAttempt[]): Pace {
  if (attempts.length < 4) return "insufficient_evidence";
  const half = Math.floor(attempts.length / 2);
  const newest = attempts.slice(0, half);
  const older = attempts.slice(half, half * 2);
  const average = (rows: readonly SafeAttempt[]) => rows.reduce((sum, row) => sum + measuredAttempt(row), 0) / rows.length;
  const delta = average(newest) - average(older);
  return delta >= 0.12 ? "accelerating" : delta <= -0.12 ? "needs_support" : "steady";
}

function confidenceFor(masteries: readonly SafeMastery[]): Confidence {
  if (masteries.length === 0) return "insufficient_evidence";
  const weighted = masteries.reduce(
    (state, row) => ({ total: state.total + row.confidence * row.verifiedEvidenceCount, weight: state.weight + row.verifiedEvidenceCount }),
    { total: 0, weight: 0 },
  );
  const confidence = weighted.total / weighted.weight;
  return confidence >= 0.75 ? "high" : confidence >= 0.45 ? "developing" : "low";
}

function unavailable(reason: "owner_scope_mismatch" | "invalid_clock" | "insufficient_verified_evidence"): MentorRecommendation {
  return {
    state: "unavailable",
    policyVersion: MENTOR_POLICY_VERSION,
    reason,
    message: reason === "insufficient_verified_evidence"
      ? "Complete a deterministic practice or review activity before Codestead recommends a personalized daily challenge."
      : "A personalized challenge is unavailable because its evidence boundary could not be verified.",
    authority: { officialPlanChanged: false, officialPlanRevisionId: null },
  };
}

export function recommendDailyMentorChallenge(input: MentorPolicyInput): MentorRecommendation {
  const now = input.now.getTime();
  if (!Number.isFinite(now)) return unavailable("invalid_clock");
  const allOwners = [
    ...input.masterySignals.map((row) => row.ownerUserId),
    ...input.recentAttempts.map((row) => row.ownerUserId),
    ...(input.officialPlan ? [input.officialPlan.ownerUserId] : []),
  ];
  if (!input.authenticatedUserId || allOwners.some((owner) => owner !== input.authenticatedUserId)) {
    return unavailable("owner_scope_mismatch");
  }

  const earliest = now - MENTOR_POLICY_LIMITS.lookbackDays * 86_400_000;
  const masteries = input.masterySignals
    .map(safeMastery)
    .filter((row): row is SafeMastery => row !== null)
    .sort((left, right) => left.skillId.localeCompare(right.skillId))
    .slice(0, MENTOR_POLICY_LIMITS.masteryRows);
  const attempts = input.recentAttempts
    .map((row) => safeAttempt(row, earliest))
    .filter((row): row is SafeAttempt => row !== null)
    .sort((left, right) => right.occurredAtMs - left.occurredAtMs || left.skillId.localeCompare(right.skillId))
    .slice(0, MENTOR_POLICY_LIMITS.recentAttempts);
  if (masteries.length === 0 && attempts.length === 0) return unavailable("insufficient_verified_evidence");

  const attemptsBySkill = new Map<string, SafeAttempt[]>();
  for (const row of attempts) attemptsBySkill.set(row.skillId, [...(attemptsBySkill.get(row.skillId) ?? []), row]);
  const candidates = masteries.map((row) => {
    const skillAttempts = attemptsBySkill.get(row.skillId) ?? [];
    const failed = skillAttempts.filter((attempt) => attempt.passed === false || (attempt.score !== null && attempt.score < 0.7));
    const dueAt = time(row.nextReviewAt);
    const overdueDays = dueAt !== null && dueAt <= now ? Math.min(90, Math.floor((now - dueAt) / 86_400_000) + 1) : 0;
    const reason: ChallengeReason = row.activeMisconceptionTags.length > 0
      ? "confirmed_misconception"
      : overdueDays > 0
        ? "overdue_review"
        : failed.length > 0
          ? "recent_struggle"
          : "lowest_confidence";
    const priority = reason === "confirmed_misconception"
      ? 400 + row.activeMisconceptionTags.length * 5 + (1 - row.confidence) * 20
      : reason === "overdue_review"
        ? 300 + overdueDays
        : reason === "recent_struggle"
          ? 200 + failed.length * 10 + (1 - row.confidence) * 20
          : 100 + (1 - row.confidence) * 50;
    return { row, reason, priority, failedCount: failed.length };
  });

  if (candidates.length === 0) return unavailable("insufficient_verified_evidence");
  candidates.sort((left, right) => right.priority - left.priority || left.row.skillId.localeCompare(right.row.skillId));
  const selected = candidates[0];
  const misconception = selected.row.activeMisconceptionTags[0] ?? null;
  const reasonText = selected.reason === "confirmed_misconception"
    ? `Verified work still shows the ${misconception} misconception.`
    : selected.reason === "overdue_review"
      ? "A stored spaced-retrieval review is overdue."
      : selected.reason === "recent_struggle"
        ? "Recent deterministic attempts show that this skill needs another short pass."
        : "This is the lowest-confidence skill in the bounded verified evidence window.";
  const instruction = misconception
    ? `In 10 minutes, explain ${misconception.replaceAll("_", " ")} in your own words, trace one small example, then solve one fresh practice item for ${selected.row.skillTitle}.`
    : `In 10 minutes, recall the core rule for ${selected.row.skillTitle}, trace one small example, then solve one fresh practice item without opening a solution.`;
  const repeatedStruggle = selected.failedCount >= 3
    || (selected.row.confidence < 0.35 && selected.row.verifiedEvidenceCount >= 3);

  return {
    state: "ready",
    policyVersion: MENTOR_POLICY_VERSION,
    dailyChallenge: {
      skillId: selected.row.skillId,
      skillTitle: selected.row.skillTitle,
      reason: selected.reason,
      reasonText,
      instruction,
      targetMinutes: 10,
      source: "stored_verified_evidence",
    },
    learningSignal: {
      pace: paceFor(attempts),
      confidence: confidenceFor(masteries),
      evidence: {
        verifiedMasteryRows: masteries.length,
        verifiedRecentAttempts: attempts.length,
        lookbackDays: MENTOR_POLICY_LIMITS.lookbackDays,
      },
    },
    encouragement: "One focused, evidence-based rep is enough for today; consistency matters more than rushing.",
    planSuggestion: repeatedStruggle ? {
      kind: "request_admin_plan_review",
      skillId: selected.row.skillId,
      reason: "Repeated verified struggle suggests that an administrator should review pacing or remediation depth.",
    } : null,
    authority: {
      officialPlanChanged: false,
      officialPlanRevisionId: input.officialPlan?.revisionId ?? null,
      statement: "Codestead may adapt this daily challenge, but only an administrator or the authoritative planning service can change the official roadmap.",
    },
    contextPolicy: {
      ownerBound: true,
      included: ["verified concept mastery", "active deterministic misconceptions", "overdue review dates", "recent deterministic or verified-runner attempts"],
      explicitlyExcluded: ["provider keys", "hidden tests", "reference answers", "other learners", "raw chat history", "unverified self-report"],
      caps: MENTOR_POLICY_LIMITS,
    },
  };
}
