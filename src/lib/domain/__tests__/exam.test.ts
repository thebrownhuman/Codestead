import { describe, expect, it } from "vitest";
import {
  canUnlockNextTopic,
  requiredMasteryRecheckTargets,
  scoreExam,
  type CodingItemResult,
  type ExamCriterionResult,
  type ExamSubmission,
} from "../exam";

function criterion(
  overrides: Partial<ExamCriterionResult> = {},
): ExamCriterionResult {
  return {
    itemId: "item-1",
    criterionId: "criterion-1",
    clusterId: "cluster-1",
    kind: "FUNCTIONAL",
    earnedPoints: 95,
    possiblePoints: 100,
    critical: true,
    ...overrides,
  };
}

function coding(
  overrides: Partial<CodingItemResult> = {},
): CodingItemResult {
  return {
    itemId: "item-1",
    mandatory: true,
    compiled: true,
    criticalTestsPassed: true,
    ...overrides,
  };
}

function submission(
  overrides: Partial<ExamSubmission> = {},
): ExamSubmission {
  return {
    criteria: [criterion()],
    codingItems: [coding()],
    singleProject: true,
    ...overrides,
  };
}

describe("exam scoring", () => {
  it("awards mastery and badge at 95 with all gates", () => {
    const score = scoreExam(submission());
    expect(score.outcome).toBe("MASTERED");
    expect(score.badgeAwarded).toBe(true);
    expect(score.percent).toBe(95);
  });

  it("passes 80–94 without awarding mastery", () => {
    const score = scoreExam(
      submission({ criteria: [criterion({ earnedPoints: 94 })] }),
    );
    expect(score.outcome).toBe("PASSED");
    expect(score.badgeAwarded).toBe(false);
  });

  it("fails below 80", () => {
    expect(
      scoreExam(
        submission({ criteria: [criterion({ earnedPoints: 79.9 })] }),
      ).outcome,
    ).toBe("NOT_PASSED");
  });

  it("honors exact pass and critical-cluster boundaries", () => {
    const score = scoreExam(
      submission({
        criteria: [
          criterion({
            criterionId: "critical",
            clusterId: "critical",
            earnedPoints: 7,
            possiblePoints: 10,
          }),
          criterion({
            itemId: "item-2",
            criterionId: "other",
            clusterId: "other",
            earnedPoints: 73,
            possiblePoints: 90,
            critical: false,
          }),
        ],
        codingItems: [],
        singleProject: false,
      }),
    );
    expect(score.percent).toBe(80);
    expect(score.failedCriticalClusters).toEqual([]);
    expect(score.outcome).toBe("PASSED");
  });

  it("fails a critical cluster even with high overall score", () => {
    const score = scoreExam(
      submission({
        criteria: [
          criterion({
            criterionId: "critical",
            clusterId: "critical",
            earnedPoints: 6,
            possiblePoints: 10,
          }),
          criterion({
            itemId: "item-2",
            criterionId: "other",
            clusterId: "other",
            earnedPoints: 89,
            possiblePoints: 90,
            critical: false,
          }),
        ],
        codingItems: [],
        singleProject: false,
      }),
    );
    expect(score.percent).toBe(95);
    expect(score.failedCriticalClusters).toEqual(["critical"]);
    expect(score.outcome).toBe("NOT_PASSED");
  });

  it("zeros functional credit for an uncompiled item", () => {
    const score = scoreExam(
      submission({
        criteria: [
          criterion({
            kind: "FUNCTIONAL",
            earnedPoints: 90,
            possiblePoints: 90,
          }),
          criterion({
            criterionId: "concept",
            kind: "CONCEPT",
            earnedPoints: 10,
            possiblePoints: 10,
          }),
        ],
        codingItems: [coding({ compiled: false })],
      }),
    );
    expect(score.earnedPoints).toBe(10);
    expect(score.compilationGatePassed).toBe(false);
    expect(score.outcome).toBe("NOT_PASSED");
  });

  it("does not invalidate unrelated items in a multi-question exam", () => {
    const score = scoreExam(
      submission({
        criteria: [
          criterion({
            itemId: "broken",
            criterionId: "broken-functional",
            clusterId: "optional",
            earnedPoints: 10,
            possiblePoints: 10,
            critical: false,
          }),
          criterion({
            itemId: "good",
            criterionId: "good-functional",
            clusterId: "core",
            earnedPoints: 90,
            possiblePoints: 90,
          }),
        ],
        codingItems: [
          coding({ itemId: "broken", compiled: false }),
          coding({ itemId: "good" }),
        ],
        singleProject: false,
      }),
    );
    expect(score.percent).toBe(90);
    expect(score.outcome).toBe("PASSED");
    expect(score.masteryBlockingCodingItems).toEqual(["broken"]);
  });

  it("withholds mastery when mandatory critical tests fail", () => {
    const score = scoreExam(
      submission({
        criteria: [criterion({ earnedPoints: 100 })],
        codingItems: [coding({ criticalTestsPassed: false })],
      }),
    );
    expect(score.percent).toBe(100);
    expect(score.outcome).toBe("PASSED");
    expect(score.badgeAwarded).toBe(false);
  });

  it("allows optional coding failures without blocking mastery", () => {
    const score = scoreExam(
      submission({
        criteria: [criterion({ earnedPoints: 100 })],
        codingItems: [
          coding({
            itemId: "optional-item",
            mandatory: false,
            compiled: false,
            criticalTestsPassed: false,
          }),
        ],
        singleProject: false,
      }),
    );
    expect(score.outcome).toBe("MASTERED");
  });

  it("separates unlock policy from mastery badge", () => {
    const passed = scoreExam(
      submission({ criteria: [criterion({ earnedPoints: 90 })] }),
    );
    expect(canUnlockNextTopic(passed)).toBe(true);
    expect(canUnlockNextTopic(passed, true)).toBe(false);
  });

  it("returns targeted recheck clusters for passed non-mastery", () => {
    const score = scoreExam(
      submission({ criteria: [criterion({ earnedPoints: 90 })] }),
    );
    expect(requiredMasteryRecheckTargets(score)).toEqual({
      clusterIds: ["cluster-1"],
      codingItemIds: [],
    });
  });

  it("returns no mastery recheck targets for failed or mastered exams", () => {
    const failed = scoreExam(
      submission({ criteria: [criterion({ earnedPoints: 70 })] }),
    );
    const mastered = scoreExam(submission());
    expect(requiredMasteryRecheckTargets(failed)).toEqual({
      clusterIds: [],
      codingItemIds: [],
    });
    expect(requiredMasteryRecheckTargets(mastered)).toEqual({
      clusterIds: [],
      codingItemIds: [],
    });
  });

  it("rejects empty, duplicate, and invalid scoring inputs", () => {
    expect(() =>
      scoreExam(submission({ criteria: [] })),
    ).toThrow(/at least one/);
    expect(() =>
      scoreExam(
        submission({
          criteria: [criterion(), criterion()],
        }),
      ),
    ).toThrow(/duplicate exam criterion/);
    expect(() =>
      scoreExam(
        submission({
          codingItems: [coding(), coding()],
        }),
      ),
    ).toThrow(/duplicate coding item/);
    expect(() =>
      scoreExam(
        submission({
          criteria: [criterion({ earnedPoints: 101 })],
        }),
      ),
    ).toThrow(RangeError);
  });

  it("rejects incoherent threshold policy", () => {
    expect(() =>
      scoreExam(submission(), {
        passPercent: 90,
        criticalClusterPercent: 70,
        masteryPercent: 80,
      }),
    ).toThrow(RangeError);
  });
});
