import { describe, expect, it } from "vitest";

import {
  MENTOR_POLICY_LIMITS,
  recommendDailyMentorChallenge,
  type MentorAttemptSignal,
  type MentorMasterySignal,
} from "../mentor-policy";

const USER = "mentor-owner";
const NOW = new Date("2026-07-14T12:00:00.000Z");

function mastery(overrides: Partial<MentorMasterySignal> = {}): MentorMasterySignal {
  return {
    ownerUserId: USER,
    skillId: "python.loops.trace",
    skillTitle: "Trace loops",
    mastery: 0.48,
    confidence: 0.42,
    status: "practicing",
    nextReviewAt: "2026-07-13T12:00:00.000Z",
    lastPracticedAt: "2026-07-13T09:00:00.000Z",
    activeMisconceptionTags: [],
    verifiedEvidenceCount: 3,
    ...overrides,
  };
}

function attempt(overrides: Partial<MentorAttemptSignal> = {}): MentorAttemptSignal {
  return {
    ownerUserId: USER,
    skillId: "python.loops.trace",
    occurredAt: "2026-07-13T10:00:00.000Z",
    score: 0.5,
    passed: false,
    assistanceLevel: "A1",
    solutionRevealed: false,
    sourceType: "deterministic_attempt",
    validity: "valid",
    ...overrides,
  };
}

describe("deterministic personalized mentor policy", () => {
  it("prioritizes a confirmed misconception over an overdue review and never changes the official plan", () => {
    const officialPlan = Object.freeze({
      ownerUserId: USER,
      revisionId: "plan-revision-7",
      nextSkillId: "python.functions",
    });
    const result = recommendDailyMentorChallenge({
      authenticatedUserId: USER,
      now: NOW,
      officialPlan,
      masterySignals: [
        mastery({ skillId: "python.arrays", skillTitle: "Arrays", nextReviewAt: "2026-06-01T00:00:00.000Z" }),
        mastery({
          skillId: "python.loops.trace",
          activeMisconceptionTags: ["loop_boundary"],
          nextReviewAt: null,
        }),
      ],
      recentAttempts: [],
    });
    expect(result).toMatchObject({
      state: "ready",
      dailyChallenge: {
        skillId: "python.loops.trace",
        reason: "confirmed_misconception",
        source: "stored_verified_evidence",
      },
      authority: {
        officialPlanChanged: false,
        officialPlanRevisionId: "plan-revision-7",
      },
    });
    expect(result.state === "ready" && result.dailyChallenge.instruction).toContain("loop boundary");
    expect(officialPlan.nextSkillId).toBe("python.functions");
  });

  it("derives pace, confidence, and an admin-only plan suggestion from stored verified evidence", () => {
    const recentAttempts = [
      attempt({ occurredAt: "2026-07-14T09:00:00.000Z", score: 0.3 }),
      attempt({ occurredAt: "2026-07-13T09:00:00.000Z", score: 0.4 }),
      attempt({ occurredAt: "2026-07-12T09:00:00.000Z", score: 0.8, passed: true, assistanceLevel: "A0" }),
      attempt({ occurredAt: "2026-07-11T09:00:00.000Z", score: 0.9, passed: true, assistanceLevel: "A0" }),
    ];
    const result = recommendDailyMentorChallenge({
      authenticatedUserId: USER,
      now: NOW,
      officialPlan: null,
      masterySignals: [mastery({ confidence: 0.3, nextReviewAt: null })],
      recentAttempts,
    });
    expect(result).toMatchObject({
      state: "ready",
      learningSignal: {
        pace: "needs_support",
        confidence: "low",
        evidence: { verifiedMasteryRows: 1, verifiedRecentAttempts: 4 },
      },
      planSuggestion: { kind: "request_admin_plan_review", skillId: "python.loops.trace" },
      authority: { officialPlanChanged: false },
    });
  });

  it("fails closed when any evidence or plan row belongs to another learner", () => {
    const result = recommendDailyMentorChallenge({
      authenticatedUserId: USER,
      now: NOW,
      officialPlan: null,
      masterySignals: [mastery(), mastery({ ownerUserId: "another-learner", skillId: "private.skill", skillTitle: "Private" })],
      recentAttempts: [],
    });
    expect(result).toEqual({
      state: "unavailable",
      policyVersion: "personalized-mentor-v1",
      reason: "owner_scope_mismatch",
      message: "A personalized challenge is unavailable because its evidence boundary could not be verified.",
      authority: { officialPlanChanged: false, officialPlanRevisionId: null },
    });
    expect(JSON.stringify(result)).not.toContain("private.skill");
  });

  it("redacts learner-controlled titles and excludes keys, hidden tests, invalid sources, and unsafe misconception tags", () => {
    const key = "nvapi-fake-secret-material-1234567890";
    const result = recommendDailyMentorChallenge({
      authenticatedUserId: USER,
      now: NOW,
      officialPlan: null,
      masterySignals: [mastery({
        skillTitle: `Loops api_key='${key}' hiddenTests=private-answer`,
        activeMisconceptionTags: [key, "loop_boundary"],
      })],
      recentAttempts: [
        attempt({ sourceType: "model_opinion", score: 1, passed: true }),
        attempt({ validity: "invalid", score: 1, passed: true }),
      ],
    });
    expect(result.state).toBe("ready");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain("private-answer");
    expect(result.state === "ready" && result.learningSignal.evidence.verifiedRecentAttempts).toBe(0);
    expect(result.state === "ready" && result.contextPolicy.explicitlyExcluded).toEqual(expect.arrayContaining([
      "provider keys", "hidden tests", "other learners", "unverified self-report",
    ]));
  });

  it("returns an honest unavailable state until verified evidence exists", () => {
    expect(recommendDailyMentorChallenge({
      authenticatedUserId: USER,
      now: NOW,
      officialPlan: null,
      masterySignals: [],
      recentAttempts: [attempt({ sourceType: "self_report" })],
    })).toMatchObject({
      state: "unavailable",
      reason: "insufficient_verified_evidence",
      authority: { officialPlanChanged: false },
    });
  });

  it("caps evidence windows deterministically", () => {
    const masterySignals = Array.from({ length: 55 }, (_, index) => mastery({
      skillId: `python.skill.${String(index).padStart(2, "0")}`,
      skillTitle: `Skill ${index}`,
      confidence: 0.8,
      nextReviewAt: null,
    }));
    const recentAttempts = Array.from({ length: 35 }, (_, index) => attempt({
      skillId: `python.skill.${String(index % 10).padStart(2, "0")}`,
      occurredAt: new Date(NOW.getTime() - index * 60_000).toISOString(),
      score: 0.8,
      passed: true,
      assistanceLevel: "A0",
    }));
    const result = recommendDailyMentorChallenge({ authenticatedUserId: USER, now: NOW, officialPlan: null, masterySignals, recentAttempts });
    expect(result).toMatchObject({
      state: "ready",
      learningSignal: { evidence: {
        verifiedMasteryRows: MENTOR_POLICY_LIMITS.masteryRows,
        verifiedRecentAttempts: MENTOR_POLICY_LIMITS.recentAttempts,
      } },
    });
  });
});
