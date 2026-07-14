import { describe, expect, it } from "vitest";

import { assembleTrophyCabinet, validIndependentMasteryTrophy } from "../trophy-cabinet";

const learnerId = "learner-1";
const mastery = {
  id: "award-1",
  title: "Mastery: Variables",
  description: "Independent mastery evidence.",
  icon: "medal",
  awarded_at: new Date("2026-07-14T09:00:00.000Z"),
  revoked_at: null,
  visibility: "private",
  evidence_id: "exam-attempt:attempt-1",
  rule_version: "exam-mastery-v1",
  event: "exam_mastery",
  course_id: "python",
  module_id: "variables",
  minimum_score_percent: "95",
  critical_requirements_required: "true",
  attempt_id: "attempt-1",
  attempt_score: 0.95,
  attempt_status: "graded",
  mastery_awarded: true,
  assistance_level: "A0",
  solution_revealed: false,
  attempt_user_id: learnerId,
  selected: false,
  portfolio_published: false,
  portfolio_slug: null,
};

describe("trophy cabinet evidence boundaries", () => {
  it("accepts only exact independent mastery evidence", () => {
    expect(validIndependentMasteryTrophy(mastery, learnerId)).toBe(true);
    expect(validIndependentMasteryTrophy({ ...mastery, assistance_level: "A1" }, learnerId)).toBe(false);
    expect(validIndependentMasteryTrophy({ ...mastery, solution_revealed: true }, learnerId)).toBe(false);
    expect(validIndependentMasteryTrophy({ ...mastery, attempt_user_id: "other" }, learnerId)).toBe(false);
    expect(validIndependentMasteryTrophy({ ...mastery, evidence_id: "exam-attempt:other" }, learnerId)).toBe(false);
    expect(validIndependentMasteryTrophy({ ...mastery, attempt_score: 0.94 }, learnerId)).toBe(false);
  });

  it("preserves revocation and explicit portfolio visibility without minting currency", () => {
    const cabinet = assembleTrophyCabinet({
      userId: learnerId,
      certificateRows: [{
        id: "certificate-1",
        course_title: "Python",
        course_version_label: "1.0.0",
        issued_at: new Date("2026-07-13T09:00:00.000Z"),
        verification_id: "abcdefghijklmnopqrstuvwxyz123456",
        revoked_at: new Date("2026-07-14T10:00:00.000Z"),
        selected: true,
        portfolio_published: true,
        portfolio_slug: "learner-one",
      }],
      masteryRows: [{ ...mastery, selected: true, portfolio_published: true }],
    });
    expect(cabinet.summary).toEqual({ earned: 1, revoked: 1, shared: 1 });
    expect(cabinet.rewards).toMatchObject({ coinsEnabled: false, coins: 0 });
    expect(cabinet.trophies.find((item) => item.kind === "course_completion")?.status).toBe("revoked");
  });

  it("drops malformed or non-independent achievement rows", () => {
    const cabinet = assembleTrophyCabinet({
      userId: learnerId,
      certificateRows: [],
      masteryRows: [
        { ...mastery, id: "invalid-1", mastery_awarded: false },
        { ...mastery, id: "invalid-2", event: "practice_completed" },
        { ...mastery, id: "invalid-3", attempt_status: "in_progress" },
      ],
    });
    expect(cabinet.trophies).toEqual([]);
  });
});
