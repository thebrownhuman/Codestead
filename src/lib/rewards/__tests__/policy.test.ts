import { describe, expect, it } from "vitest";

import {
  CHALLENGE_POLICY_VERSION,
  COINS_ENABLED,
  COIN_POLICY_NOTE,
  REWARD_POLICY_VERSION,
  challengePeriod,
  deriveAttemptReward,
  deriveChallengeProgress,
  deriveLevel,
  deriveMasteryReward,
  levelStartXp,
  type AttemptRewardInput,
} from "../policy";

const eligibleAttempt: AttemptRewardInput = {
  kind: "quiz",
  status: "graded",
  passed: true,
  masteryAwarded: true,
  infrastructureFailure: false,
  assistanceLevel: "A0",
  solutionRevealed: false,
  activityId: "11000000-0000-4000-8000-000000000001",
  contentVersion: "python-v1",
  evidenceOccurredAt: new Date("2026-07-06T04:00:00.000Z"),
};

describe("versioned reward policy", () => {
  it.each([
    ["quiz", 20],
    ["game", 15],
    ["mastery_check", 40],
    ["exam", 100],
    ["retake", 80],
    ["project", 120],
  ] as const)("awards deterministic XP for independently graded %s evidence", (kind, xp) => {
    expect(deriveAttemptReward({ ...eligibleAttempt, kind })).toMatchObject({
      eligible: true,
      rewardCode: "attempt_completion",
      scopeKey: `activity:${eligibleAttempt.activityId}`,
      xp,
      coins: 0,
      policyVersion: REWARD_POLICY_VERSION,
    });
  });

  it.each(["practice", "diagnostic"] as const)("never rewards replayable %s attempts", (kind) => {
    expect(deriveAttemptReward({ ...eligibleAttempt, kind })).toMatchObject({
      eligible: false,
      xp: 0,
      reason: expect.stringContaining("do not earn"),
    });
  });

  it.each([
    { status: "submitted" },
    { passed: false },
    { masteryAwarded: false },
    { infrastructureFailure: true },
    { assistanceLevel: "A2" },
    { solutionRevealed: true, assistanceLevel: "A4" },
  ])("rejects non-final, failed, infrastructure, or assisted evidence %#", (override) => {
    expect(deriveAttemptReward({ ...eligibleAttempt, ...override }).eligible).toBe(false);
  });

  it("uses a correction's effective result instead of stale original fields", () => {
    expect(deriveAttemptReward({
      ...eligibleAttempt,
      passed: true,
      masteryAwarded: true,
      effectiveResult: { outcome: "FAILED", infrastructureFailure: false },
    }).eligible).toBe(false);
    expect(deriveAttemptReward({
      ...eligibleAttempt,
      passed: false,
      masteryAwarded: false,
      effectiveResult: { outcome: "MASTERED", infrastructureFailure: false },
    }).eligible).toBe(true);
    expect(deriveAttemptReward({
      ...eligibleAttempt,
      effectiveResult: { outcome: "MASTERED", infrastructureFailure: true },
    }).eligible).toBe(false);
  });

  it("uses a bounded content scope when an official attempt has no activity", () => {
    const decision = deriveAttemptReward({
      ...eligibleAttempt,
      kind: "exam",
      activityId: null,
      contentVersion: `course:v1:${"x".repeat(300)}`,
    });
    expect(decision.scopeKey).toMatch(/^content:exam:course_v1_/);
    expect(decision.scopeKey.length).toBeLessThanOrEqual(193);
  });

  it("only rewards valid, threshold-passing mastery from approved deterministic recorders", () => {
    const base = {
      enrollmentId: "21000000-0000-4000-8000-000000000001",
      conceptId: "31000000-0000-4000-8000-000000000001",
      languageContext: "c++:20",
      validity: "valid",
      score: 0.8,
      weight: 1,
      recordedBy: "verified-runner",
      sourceType: "verified_runner",
      sourceAttemptId: "41000000-0000-4000-8000-000000000001",
      sourceAttemptStatus: "graded",
      sourceAttemptPassed: true,
      sourceAttemptMasteryAwarded: true,
      sourceAttemptInfrastructureFailure: false,
      sourceAttemptAssistanceLevel: "A0",
      sourceAttemptSolutionRevealed: false,
      sourceAttemptConceptBound: true,
      sourceAttemptEffectiveResult: null,
    };
    const awarded = deriveMasteryReward(base);
    expect(awarded).toMatchObject({
      eligible: true,
      xp: 60,
      coins: 0,
    });
    expect(awarded.scopeKey.endsWith(":c++_20")).toBe(true);
    for (const override of [
      { validity: "revoked" },
      { score: 0.799 },
      { weight: 0 },
      { recordedBy: null },
      { recordedBy: "ai-tutor" },
      { sourceAttemptId: null },
      { sourceAttemptStatus: "submitted" },
      { sourceAttemptMasteryAwarded: false },
      { sourceAttemptAssistanceLevel: "A1" },
      { sourceAttemptSolutionRevealed: true },
      { sourceAttemptConceptBound: false },
    ]) expect(deriveMasteryReward({ ...base, ...override }).eligible).toBe(false);
    expect(deriveMasteryReward({
      ...base,
      sourceAttemptPassed: false,
      sourceAttemptMasteryAwarded: false,
      sourceAttemptEffectiveResult: { outcome: "MASTERED", infrastructureFailure: false },
    }).eligible).toBe(true);
    expect(deriveMasteryReward({
      ...base,
      sourceAttemptEffectiveResult: { outcome: "PASSED", infrastructureFailure: false },
    }).eligible).toBe(false);
  });

  it("keeps coins explicitly disabled rather than inventing a spend economy", () => {
    expect(COINS_ENABLED).toBe(false);
    expect(COIN_POLICY_NOTE).toContain("always awards zero");
  });
});

describe("level derivation", () => {
  it("derives stable triangular thresholds and exact progress", () => {
    expect([1, 2, 3, 4].map(levelStartXp)).toEqual([0, 100, 300, 600]);
    expect(deriveLevel(0)).toMatchObject({ level: 1, xpIntoLevel: 0, xpToNextLevel: 100 });
    expect(deriveLevel(299)).toMatchObject({ level: 2, xpIntoLevel: 199, xpToNextLevel: 1 });
    expect(deriveLevel(300)).toMatchObject({ level: 3, xpIntoLevel: 0, xpToNextLevel: 300 });
    expect(deriveLevel(levelStartXp(100) + 500)).toMatchObject({ level: 100, xpToNextLevel: 0 });
  });

  it("rejects invalid XP and level inputs", () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => deriveLevel(value)).toThrow();
    for (const value of [0, 1.5, 102]) expect(() => levelStartXp(value)).toThrow();
  });
});

describe("learner-local challenge periods", () => {
  it("uses the learner's IANA day at a UTC/local week boundary", () => {
    const now = new Date("2026-07-05T20:30:00.000Z");
    expect(challengePeriod("weekly", now, "Asia/Kolkata")).toMatchObject({
      timezone: "Asia/Kolkata",
      startLocalDate: "2026-07-06",
      endLocalDateExclusive: "2026-07-13",
      key: "weekly:2026-07-06",
    });
    expect(challengePeriod("weekly", now, "UTC").startLocalDate).toBe("2026-06-29");
  });

  it("uses calendar month keys across DST and safely falls back for an invalid zone", () => {
    const duringDst = new Date("2026-03-08T07:30:00.000Z");
    expect(challengePeriod("monthly", duringDst, "America/New_York")).toMatchObject({
      timezone: "America/New_York",
      startLocalDate: "2026-03-01",
      endLocalDateExclusive: "2026-04-01",
    });
    expect(challengePeriod("monthly", duringDst, "Not/AZone").timezone).toBe("UTC");
    expect(() => challengePeriod("weekly", new Date(Number.NaN), "UTC")).toThrow();
  });

  it("clamps challenge progress while preserving authoritative counts", () => {
    const period = challengePeriod("weekly", new Date("2026-07-07T00:00:00Z"), "UTC");
    expect(deriveChallengeProgress({ kind: "weekly", period, earnedXp: 300, qualifyingRewards: 7 })).toMatchObject({
      policyVersion: CHALLENGE_POLICY_VERSION,
      targetXp: 250,
      earnedXp: 300,
      qualifyingRewards: 7,
      completed: true,
      progressPercent: 100,
      completionReward: null,
    });
    expect(deriveChallengeProgress({ kind: "weekly", period, earnedXp: -20, qualifyingRewards: -1 })).toMatchObject({
      earnedXp: 0,
      qualifyingRewards: 0,
      completed: false,
      progressPercent: 0,
    });
  });
});
