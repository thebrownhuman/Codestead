import { describe, expect, it } from "vitest";
import {
  applyEvidence,
  evaluateExamReadiness,
  isQualifyingIndependentEvidence,
  summarizeMasteryEvidence,
  updateMasteryProbability,
  type MasteryPolicy,
} from "../mastery";
import { evidence, progress } from "./fixtures";

describe("updateMasteryProbability", () => {
  it("raises probability after a clean correct observation", () => {
    const updated = updateMasteryProbability(0.2, evidence());
    expect(updated).toBeGreaterThan(0.2);
    expect(updated).toBeLessThanOrEqual(1);
  });

  it("lowers a high probability after an independent error", () => {
    const updated = updateMasteryProbability(
      0.8,
      evidence({ correct: false, learningOpportunity: false }),
    );
    expect(updated).toBeLessThan(0.8);
  });

  it("treats assisted success as learning, not a correct observation", () => {
    const updated = updateMasteryProbability(
      0.2,
      evidence({ assistanceLevel: "A2" }),
    );
    expect(updated).toBeCloseTo(0.32);
  });

  it("does not use a revealed solution as positive observation", () => {
    const updated = updateMasteryProbability(
      0.2,
      evidence({ solutionRevealed: true }),
    );
    expect(updated).toBeCloseTo(0.32);
  });

  it("allows E0 instruction to create only a learning transition", () => {
    const updated = updateMasteryProbability(
      0.2,
      evidence({ evidenceLevel: "E0" }),
    );
    expect(updated).toBeCloseTo(0.32);
  });

  it("does not move without observation or learning opportunity", () => {
    const updated = updateMasteryProbability(
      0.4,
      evidence({
        evidenceLevel: "E0",
        learningOpportunity: false,
      }),
    );
    expect(updated).toBe(0.4);
  });

  it("handles impossible-evidence zero denominators without NaN", () => {
    expect(
      updateMasteryProbability(
        0,
        evidence({ learningOpportunity: false }),
        { learn: 0, slip: 0, guess: 0 },
      ),
    ).toBe(0);
    expect(
      updateMasteryProbability(
        1,
        evidence({ correct: false, learningOpportunity: false }),
        { learn: 0, slip: 0, guess: 1 },
      ),
    ).toBe(1);
  });

  it("rejects invalid probabilities and BKT parameters", () => {
    expect(() =>
      updateMasteryProbability(-0.1, evidence()),
    ).toThrow(RangeError);
    expect(() =>
      updateMasteryProbability(0.5, evidence(), {
        learn: 1.1,
        slip: 0.1,
        guess: 0.2,
      }),
    ).toThrow(RangeError);
  });
});

describe("mastery evidence gates", () => {
  it("qualifies only clean, unrevealed, sufficiently strong evidence", () => {
    expect(isQualifyingIndependentEvidence(evidence())).toBe(true);
    expect(
      isQualifyingIndependentEvidence(
        evidence({ assistanceLevel: "A1" }),
      ),
    ).toBe(false);
    expect(
      isQualifyingIndependentEvidence(
        evidence({ solutionRevealed: true }),
      ),
    ).toBe(false);
    expect(
      isQualifyingIndependentEvidence(evidence({ evidenceLevel: "E2" })),
    ).toBe(false);
    expect(
      isQualifyingIndependentEvidence(evidence({ correct: false })),
    ).toBe(false);
  });

  it("deduplicates repeated variants", () => {
    const summary = summarizeMasteryEvidence(
      progress({
        evidence: [
          evidence({ id: "1", itemVariantId: "same" }),
          evidence({ id: "2", itemVariantId: "same" }),
        ],
      }),
    );
    expect(summary.distinctApplicationVariants).toBe(1);
    expect(summary.independentImplementations).toBe(2);
  });

  it("recognizes a complete exam-readiness evidence set", () => {
    const result = evaluateExamReadiness(
      progress({
        masteryProbability: 0.95,
        evidence: [
          evidence({ id: "1", itemVariantId: "implementation" }),
          evidence({
            id: "2",
            itemVariantId: "transfer",
            evidenceLevel: "E5",
          }),
          evidence({
            id: "3",
            itemVariantId: "delayed",
            evidenceLevel: "E6",
          }),
        ],
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.unmet).toEqual([]);
  });

  it("reports each unmet hard gate", () => {
    const result = evaluateExamReadiness(progress());
    expect(result.eligible).toBe(false);
    expect(result.unmet).toEqual([
      "mastery_probability",
      "distinct_applications",
      "independent_implementation",
      "delayed_check",
      "transfer_check",
    ]);
  });

  it("blocks readiness for an active blocking misconception", () => {
    const result = evaluateExamReadiness(
      progress({
        masteryProbability: 1,
        activeMisconceptions: [
          { tag: "aliasing", blocking: true, confirmedAtMs: 1 },
        ],
        evidence: [
          evidence({ id: "1", itemVariantId: "a", evidenceLevel: "E5" }),
          evidence({ id: "2", itemVariantId: "b", evidenceLevel: "E6" }),
        ],
      }),
      {
        guidedThreshold: 0.55,
        independentThreshold: 0.75,
        examReadyThreshold: 0.9,
        minimumDistinctApplications: 2,
        minimumIndependentImplementations: 1,
        minimumDelayedChecks: 1,
        minimumTransferChecks: 1,
      },
    );
    expect(result.unmet).toContain("blocking_misconception");
  });

  it("rejects unordered policy thresholds", () => {
    const invalid: MasteryPolicy = {
      guidedThreshold: 0.8,
      independentThreshold: 0.7,
      examReadyThreshold: 0.9,
      minimumDistinctApplications: 1,
      minimumIndependentImplementations: 1,
      minimumDelayedChecks: 0,
      minimumTransferChecks: 0,
    };
    expect(() => evaluateExamReadiness(progress(), invalid)).toThrow(
      RangeError,
    );
  });
});

describe("applyEvidence", () => {
  it("is immutable and appends the observation", () => {
    const initial = progress();
    const observation = evidence();
    const updated = applyEvidence(initial, observation);
    expect(updated).not.toBe(initial);
    expect(updated.evidence).toEqual([observation]);
    expect(initial.evidence).toEqual([]);
  });

  it("rejects evidence for another skill", () => {
    expect(() =>
      applyEvidence(
        progress({ skillId: "a" }),
        evidence({ skillId: "b" }),
      ),
    ).toThrow(/cannot update/);
  });

  it("rejects invalid timestamps", () => {
    expect(() =>
      applyEvidence(progress(), evidence({ occurredAtMs: -1 })),
    ).toThrow(RangeError);
  });

  it("preserves an earned mastery after assisted failure", () => {
    const updated = applyEvidence(
      progress({
        stage: "MASTERED",
        masteryProbability: 0.99,
        masteredAtMs: 1,
      }),
      evidence({ correct: false, assistanceLevel: "A2" }),
    );
    expect(updated.stage).toBe("MASTERED");
  });

  it("moves mastered skill to review due after independent failure", () => {
    const updated = applyEvidence(
      progress({
        stage: "MASTERED",
        masteryProbability: 0.99,
        masteredAtMs: 1,
      }),
      evidence({ correct: false }),
    );
    expect(updated.stage).toBe("REVIEW_DUE");
    expect(updated.masteredAtMs).toBe(1);
  });

  it("moves a passed skill to review due after independent failure without erasing the pass", () => {
    const updated = applyEvidence(
      progress({
        stage: "PASSED",
        masteryProbability: 0.88,
        passedAtMs: 1,
      }),
      evidence({ correct: false }),
    );
    expect(updated.stage).toBe("REVIEW_DUE");
    expect(updated.passedAtMs).toBe(1);
  });

  it("preserves a passed stage after assisted failure", () => {
    const updated = applyEvidence(
      progress({
        stage: "PASSED",
        masteryProbability: 0.88,
        passedAtMs: 1,
      }),
      evidence({ correct: false, assistanceLevel: "A1" }),
    );
    expect(updated.stage).toBe("PASSED");
    expect(updated.passedAtMs).toBe(1);
  });

  it.each([
    { label: "E0 instruction", observation: evidence({ evidenceLevel: "E0", correct: true }) },
    { label: "assisted success", observation: evidence({ assistanceLevel: "A2", correct: true }) },
    { label: "solution reveal", observation: evidence({ solutionRevealed: true, correct: true }) },
  ])("does not clear review due with $label", ({ observation }) => {
    const updated = applyEvidence(
      progress({
        stage: "REVIEW_DUE",
        masteryProbability: 0.82,
        passedAtMs: 1,
      }),
      observation,
    );
    expect(updated.stage).toBe("REVIEW_DUE");
    expect(updated.passedAtMs).toBe(1);
  });

  it("clears review due only after qualifying clean independent evidence", () => {
    const passed = applyEvidence(
      progress({ stage: "REVIEW_DUE", masteryProbability: 0.82, passedAtMs: 1 }),
      evidence({ evidenceLevel: "E3", assistanceLevel: "A0", correct: true }),
    );
    const mastered = applyEvidence(
      progress({ stage: "REVIEW_DUE", masteryProbability: 0.95, masteredAtMs: 1 }),
      evidence({ evidenceLevel: "E5", assistanceLevel: "A0", correct: true }),
    );
    expect(passed.stage).toBe("PASSED");
    expect(mastered.stage).toBe("MASTERED");
  });

  it("routes a blocking misconception to remediation", () => {
    const updated = applyEvidence(
      progress({
        activeMisconceptions: [
          { tag: "scope", blocking: true, confirmedAtMs: 1 },
        ],
      }),
      evidence(),
    );
    expect(updated.stage).toBe("REMEDIATION");
  });
});
