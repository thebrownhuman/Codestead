import { describe, expect, it } from "vitest";
import {
  eligibleKnowledgeComponents,
  evaluatePrerequisites,
  findPrerequisiteCycles,
  hasAchievement,
  indexProgress,
} from "../prerequisites";
import { selectNextAction } from "../next-action";
import type { KnowledgeComponent } from "../types";
import type { ReviewSchedule } from "../review";
import { progress } from "./fixtures";

function component(
  overrides: Partial<KnowledgeComponent> = {},
): KnowledgeComponent {
  return {
    id: "skill-a",
    prerequisites: [],
    goalPriority: 1,
    prerequisiteCentrality: 1,
    ...overrides,
  };
}

function schedule(
  overrides: Partial<ReviewSchedule> = {},
): ReviewSchedule {
  return {
    skillId: "skill-a",
    intervalIndex: 1,
    intervalDays: 1,
    dueAtMs: 1_000,
    successfulReviews: 0,
    lapses: 0,
    ...overrides,
  };
}

describe("prerequisite eligibility", () => {
  it("recognizes independent and later stages", () => {
    expect(
      hasAchievement(
        progress({ stage: "INDEPENDENT_PRACTICE" }),
        "INDEPENDENT_PRACTICE",
      ),
    ).toBe(true);
    expect(
      hasAchievement(
        progress({ stage: "GUIDED_PRACTICE" }),
        "INDEPENDENT_PRACTICE",
      ),
    ).toBe(false);
  });

  it("preserves earned mastery while review is due", () => {
    expect(
      hasAchievement(
        progress({
          stage: "REVIEW_DUE",
          passedAtMs: 10,
          masteredAtMs: 20,
        }),
        "MASTERED",
      ),
    ).toBe(true);
  });

  it("uses earned timestamps during remediation", () => {
    expect(
      hasAchievement(
        progress({ stage: "REMEDIATION", passedAtMs: 10 }),
        "PASSED",
      ),
    ).toBe(true);
  });

  it("does not infer mastery from a label without mastery evidence", () => {
    expect(
      hasAchievement(progress({ stage: "MASTERED" }), "MASTERED"),
    ).toBe(false);
  });

  it("reports missing and underqualified prerequisites", () => {
    const result = evaluatePrerequisites(
      component({
        prerequisites: [
          { skillId: "missing", requiredAchievement: "PASSED" },
          {
            skillId: "weak",
            requiredAchievement: "INDEPENDENT_PRACTICE",
          },
        ],
      }),
      indexProgress([
        progress({ skillId: "weak", stage: "GUIDED_PRACTICE" }),
      ]),
    );
    expect(result.eligible).toBe(false);
    expect(result.missing).toEqual([
      {
        prerequisite: {
          skillId: "missing",
          requiredAchievement: "PASSED",
        },
        actualStage: undefined,
      },
      {
        prerequisite: {
          skillId: "weak",
          requiredAchievement: "INDEPENDENT_PRACTICE",
        },
        actualStage: "GUIDED_PRACTICE",
      },
    ]);
  });

  it("returns only unstarted components with met prerequisites", () => {
    const components = [
      component({ id: "done" }),
      component({
        id: "ready",
        prerequisites: [
          { skillId: "done", requiredAchievement: "PASSED" },
        ],
      }),
      component({
        id: "blocked",
        prerequisites: [
          { skillId: "missing", requiredAchievement: "PASSED" },
        ],
      }),
    ];
    const eligible = eligibleKnowledgeComponents(
      components,
      indexProgress([
        progress({
          skillId: "done",
          stage: "PASSED",
          passedAtMs: 1,
        }),
      ]),
    );
    expect(eligible.map((item) => item.id)).toEqual(["ready"]);
  });

  it("rejects duplicate progress records", () => {
    expect(() =>
      indexProgress([
        progress({ skillId: "same" }),
        progress({ skillId: "same" }),
      ]),
    ).toThrow(/duplicate/);
  });

  it("detects direct and indirect prerequisite cycles", () => {
    expect(
      findPrerequisiteCycles([
        component({
          id: "self",
          prerequisites: [
            { skillId: "self", requiredAchievement: "PASSED" },
          ],
        }),
      ]),
    ).toHaveLength(1);
    expect(
      findPrerequisiteCycles([
        component({
          id: "a",
          prerequisites: [
            { skillId: "b", requiredAchievement: "PASSED" },
          ],
        }),
        component({
          id: "b",
          prerequisites: [
            { skillId: "a", requiredAchievement: "PASSED" },
          ],
        }),
      ]),
    ).toHaveLength(1);
    expect(findPrerequisiteCycles([component({ id: "clean" })])).toEqual(
      [],
    );
  });
});

describe("adaptive next action selection", () => {
  const base = {
    components: [
      component({ id: "a", goalPriority: 2 }),
      component({ id: "b", goalPriority: 1 }),
    ],
    progress: [],
    reviewSchedules: [],
    currentGoalSkillIds: new Set<string>(),
    challengeAvailableSkillIds: new Set<string>(),
    nowMs: 2_000,
    session: { completedActions: 0, reviewActions: 0 },
  } as const;

  it("prioritizes remediation above due review", () => {
    const action = selectNextAction({
      ...base,
      progress: [
        progress({
          skillId: "a",
          stage: "REMEDIATION",
        }),
      ],
      reviewSchedules: [schedule({ skillId: "b" })],
    });
    expect(action.kind).toBe("REMEDIATE");
    expect(action.skillId).toBe("a");
  });

  it("selects the highest-priority due review", () => {
    const action = selectNextAction({
      ...base,
      reviewSchedules: [
        schedule({ skillId: "a", dueAtMs: 1_900 }),
        schedule({ skillId: "b", dueAtMs: 0 }),
      ],
    });
    expect(action.kind).toBe("REVIEW");
    expect(action.skillId).toBe("a");
  });

  it("enforces the review fraction after the warm-up", () => {
    const action = selectNextAction({
      ...base,
      reviewSchedules: [schedule({ skillId: "a" })],
      session: { completedActions: 1, reviewActions: 1 },
    });
    expect(action.kind).toBe("START_SKILL");
  });

  it("returns none in review-only mode when no review is due", () => {
    const action = selectNextAction({
      ...base,
      reviewSchedules: [
        schedule({ skillId: "a", dueAtMs: 10_000 }),
      ],
      session: {
        completedActions: 0,
        reviewActions: 0,
        reviewOnly: true,
      },
    });
    expect(action.kind).toBe("NONE");
  });

  it("continues the weakest eligible goal-path skill", () => {
    const action = selectNextAction({
      ...base,
      currentGoalSkillIds: new Set(["a", "b"]),
      progress: [
        progress({ skillId: "a", masteryProbability: 0.7 }),
        progress({ skillId: "b", masteryProbability: 0.2 }),
      ],
    });
    expect(action.kind).toBe("CONTINUE_SKILL");
    expect(action.skillId).toBe("b");
  });

  it("does not continue a goal skill with unmet prerequisites", () => {
    const blocked = component({
      id: "a",
      prerequisites: [
        { skillId: "prerequisite", requiredAchievement: "PASSED" },
      ],
    });
    const action = selectNextAction({
      ...base,
      components: [blocked, component({ id: "b" })],
      currentGoalSkillIds: new Set(["a"]),
      progress: [progress({ skillId: "a" })],
    });
    expect(action.kind).toBe("START_SKILL");
    expect(action.skillId).toBe("b");
  });

  it("starts the best eligible new skill and skips blocked ones", () => {
    const action = selectNextAction({
      ...base,
      components: [
        component({
          id: "blocked",
          goalPriority: 100,
          prerequisites: [
            { skillId: "missing", requiredAchievement: "PASSED" },
          ],
        }),
        component({ id: "ready", goalPriority: 1 }),
      ],
    });
    expect(action).toMatchObject({
      kind: "START_SKILL",
      skillId: "ready",
    });
  });

  it("offers a challenge only after required work is unavailable", () => {
    const action = selectNextAction({
      ...base,
      components: [],
      progress: [
        progress({
          skillId: "mastered",
          masteredAtMs: 1,
          stage: "MASTERED",
        }),
      ],
      challengeAvailableSkillIds: new Set(["mastered"]),
    });
    expect(action.kind).toBe("CHALLENGE");
  });

  it("uses skill ID as deterministic tie-breaker", () => {
    const action = selectNextAction({
      ...base,
      components: [
        component({ id: "z" }),
        component({ id: "a" }),
      ],
    });
    expect(action.skillId).toBe("a");
  });

  it("rejects inconsistent session counters", () => {
    expect(() =>
      selectNextAction({
        ...base,
        session: { completedActions: 0, reviewActions: 1 },
      }),
    ).toThrow(RangeError);
  });
});
