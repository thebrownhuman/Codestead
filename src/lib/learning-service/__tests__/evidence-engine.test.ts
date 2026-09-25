import { describe, expect, it } from "vitest";

import {
  buildMasteryTransition,
  decodeEvidenceEnvelope,
  encodeEvidenceEnvelope,
  evaluateAuthoredActivity,
  evidenceEnvelopeFor,
  progressFromMasteryBundle,
  validateRunnerEvaluation,
} from "../evidence-engine";
import { decodeReviewSchedule, encodeReviewReason } from "../review-codec";
import type {
  ActivityContext,
  AttemptContext,
  EvidenceEnvelopeV1,
  StoredEvidence,
  StoredMastery,
  StoredReview,
} from "../types";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function activity(specification: Record<string, unknown>, slug = "variant-a"): ActivityContext {
  return {
    activityId: "10000000-0000-4000-8000-000000000001",
    activitySlug: slug,
    activityType: "quiz",
    specification,
    skillId: "python.variables.assignment",
    conceptId: "20000000-0000-4000-8000-000000000001",
    enrollmentId: "30000000-0000-4000-8000-000000000001",
    courseVersion: "1.0.0",
    trackId: "python",
    implementationLanguage: null,
    languageContext: "conceptual",
  };
}

function context(
  specification: Record<string, unknown>,
  kind: AttemptContext["attempt"]["kind"] = "practice",
  slug?: string,
): AttemptContext {
  const activityContext = activity(specification, slug);
  return {
    activity: activityContext,
    attempt: {
      id: "40000000-0000-4000-8000-000000000001",
      userId: "learner-1",
      activityId: activityContext.activityId,
      enrollmentId: activityContext.enrollmentId,
      kind,
      attemptNumber: 1,
      status: "in_progress",
      policyVersion: "adaptive-learning-v1",
      contentVersion: "1.0.0",
      score: null,
      passed: null,
      masteryAwarded: false,
      infrastructureFailure: false,
      assistanceLevel: "A0",
      solutionRevealed: false,
      helpStep: 0,
      startedAt: NOW,
      submittedAt: null,
      gradedAt: null,
    },
  };
}

function mastery(overrides: Partial<StoredMastery> = {}): StoredMastery {
  return {
    userId: "learner-1",
    enrollmentId: "30000000-0000-4000-8000-000000000001",
    conceptId: "20000000-0000-4000-8000-000000000001",
    skillId: "python.variables.assignment",
    languageContext: "conceptual",
    score: 0,
    confidence: 0,
    status: "learning",
    criticalRequirementsMet: false,
    lastEvidenceAt: null,
    lastPracticedAt: null,
    nextReviewAt: null,
    rowVersion: 1,
    ...overrides,
  };
}

function evidence(
  id: string,
  envelope: EvidenceEnvelopeV1,
  recordedAt: Date,
  overrides: Partial<StoredEvidence> = {},
): StoredEvidence {
  return {
    id,
    skillId: envelope.skillId,
    enrollmentId: "30000000-0000-4000-8000-000000000001",
    conceptId: "20000000-0000-4000-8000-000000000001",
    languageContext: envelope.languageContext,
    sourceType: "deterministic_attempt",
    sourceId: id,
    evidenceType: encodeEvidenceEnvelope(envelope),
    score: envelope.correct ? 1 : 0,
    weight: 1,
    criticalCriterion: "core",
    validity: "valid",
    recordedBy: "adaptive-deterministic-engine",
    recordedAt,
    ...overrides,
  };
}

function envelope(
  level: EvidenceEnvelopeV1["evidenceLevel"],
  variant: string,
  overrides: Partial<EvidenceEnvelopeV1> = {},
): EvidenceEnvelopeV1 {
  return {
    version: 1,
    origin: "deterministic_spec",
    skillId: "python.variables.assignment",
    itemVariantId: variant,
    evidenceLevel: level,
    assistanceLevel: "A0",
    correct: true,
    learningOpportunity: false,
    solutionRevealed: false,
    misconceptionTags: [],
    languageContext: "conceptual",
    ...overrides,
  };
}

function activeReview(dueAt: Date): StoredReview {
  return {
    id: "review-1",
    userId: "learner-1",
    enrollmentId: "30000000-0000-4000-8000-000000000001",
    conceptId: "20000000-0000-4000-8000-000000000001",
    skillId: "python.variables.assignment",
    languageContext: "conceptual",
    dueAt,
    intervalDays: 3,
    reason: "e30",
    status: "scheduled",
  };
}

const response = {
  itemKey: "main",
  responseRevision: 1,
  answer: { value: "42" },
  assistanceLevel: "A0" as const,
  solutionRevealed: false,
  submittedAt: NOW,
};

describe("authored deterministic evaluator", () => {
  it("grades exact, numeric, set, and multi-gap specifications", () => {
    expect(evaluateAuthoredActivity(activity({ grading: { kind: "exact", acceptedAnswers: ["42"] } }), { value: " 42 " }))
      .toMatchObject({ state: "graded", passed: true, origin: "deterministic_spec" });
    expect(evaluateAuthoredActivity(activity({ grading: { kind: "numeric", expected: 3.14, tolerance: 0.01 } }), { value: 3.145 }))
      .toMatchObject({ state: "graded", passed: true });
    expect(evaluateAuthoredActivity(activity({ grading: { kind: "set", correctOptionIds: ["b", "a"] } }), { selectedOptionIds: ["a", "b"] }))
      .toMatchObject({ state: "graded", passed: true });
    expect(evaluateAuthoredActivity(activity({
      grading: {
        kind: "gaps",
        acceptedByGap: { declaration: ["let"], name: ["count", "counter"] },
        caseSensitive: false,
      },
    }), { gaps: { declaration: "LET", name: "counter" } }))
      .toMatchObject({ state: "graded", passed: true, score: 1 });
    expect(evaluateAuthoredActivity(activity({
      grading: { kind: "gaps", acceptedByGap: { first: ["a"], second: ["b"] }, passThreshold: 1 },
    }), { gaps: { first: "a", second: "wrong" } }))
      .toMatchObject({ state: "graded", passed: false, score: 0.5 });
  });

  it("maps authored wrong-answer patterns to bounded misconception tags", () => {
    const result = evaluateAuthoredActivity(
      activity({ grading: { kind: "exact", acceptedAnswers: ["42"], misconceptions: [{ tag: "assignment.equality", answers: ["41"] }] } }),
      { value: "41" },
    );
    expect(result).toMatchObject({ state: "graded", passed: false, misconceptionTags: ["assignment.equality"] });
  });

  it("never accepts LLM grading as official evidence", () => {
    expect(evaluateAuthoredActivity(activity({ grading: { kind: "llm" } }), { value: "answer" }))
      .toEqual({ state: "unavailable", reason: "unsupported_grader" });
    const row = evidence("e1", envelope("E4", "v1"), NOW, {
      sourceType: "model_call",
      recordedBy: "llm-grader",
    });
    expect(decodeEvidenceEnvelope(row)).toBeNull();
    expect(progressFromMasteryBundle(row.skillId, { mastery: mastery(), evidence: [row], activeReview: null }).evidence)
      .toEqual([]);
  });

  it("accepts only completed, bounded runner results", () => {
    expect(validateRunnerEvaluation({ passed: true, score: 0.92 })).toMatchObject({
      state: "graded",
      origin: "verified_runner",
      passed: true,
    });
    expect(validateRunnerEvaluation({ status: "running" })).toEqual({
      state: "unavailable",
      reason: "runner_not_complete",
    });
    expect(validateRunnerEvaluation({ passed: true, score: Number.NaN })).toEqual({
      state: "unavailable",
      reason: "runner_not_complete",
    });
    expect(validateRunnerEvaluation({
      passed: false,
      score: 0.2,
      misconceptionTags: ["assignment.equality", "Not_Valid!", 42],
    })).toMatchObject({
      state: "graded",
      passed: false,
      misconceptionTags: ["assignment.equality"],
    });
    expect(validateRunnerEvaluation({ passed: true, score: 1, misconceptionTags: ["ignored.tag"] }))
      .toMatchObject({ misconceptionTags: [] });
  });

  it("marks the runner grader as not-yet-complete and rejects an unrecognized grader kind", () => {
    expect(evaluateAuthoredActivity(activity({ grading: { kind: "runner" } }), { value: "x" }))
      .toEqual({ state: "unavailable", reason: "runner_not_complete" });
    expect(evaluateAuthoredActivity(activity({ grading: { kind: "essay" } }), { value: "x" }))
      .toEqual({ state: "unavailable", reason: "unsupported_grader" });
    expect(evaluateAuthoredActivity(activity({ grading: {} }), { value: "x" }))
      .toEqual({ state: "unavailable", reason: "grader_not_configured" });
  });

  it("accepts a choice grader via correctOptionIds and rejects one with no accepted answers", () => {
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "choice", correctOptionIds: ["b"] } }),
      { value: "b" },
    )).toMatchObject({ state: "graded", passed: true });
    expect(evaluateAuthoredActivity(activity({ grading: { kind: "exact" } }), { value: "x" }))
      .toEqual({ state: "unavailable", reason: "invalid_grader_specification" });
  });

  it("respects case-sensitive, untrimmed exact grading", () => {
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "exact", acceptedAnswers: ["Answer"], caseSensitive: true, trim: false } }),
      { value: " Answer " },
    )).toMatchObject({ passed: false });
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "exact", acceptedAnswers: ["Answer"], caseSensitive: true } }),
      { value: "Answer" },
    )).toMatchObject({ passed: true });
  });

  it("rejects a set grader with missing correctOptionIds or a non-array answer", () => {
    expect(evaluateAuthoredActivity(activity({ grading: { kind: "set" } }), { selectedOptionIds: ["a"] }))
      .toEqual({ state: "unavailable", reason: "invalid_grader_specification" });
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "set", correctOptionIds: ["a"] } }),
      { selectedOptionIds: "not-an-array" },
    )).toEqual({ state: "unavailable", reason: "invalid_grader_specification" });
  });

  it("rejects a numeric grader with non-finite values or negative tolerance", () => {
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "numeric", expected: "not-a-number", tolerance: 0 } }),
      { value: 1 },
    )).toEqual({ state: "unavailable", reason: "invalid_grader_specification" });
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "numeric", expected: 1, tolerance: -1 } }),
      { value: 1 },
    )).toEqual({ state: "unavailable", reason: "invalid_grader_specification" });
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "numeric", expected: 1 } }),
      { value: "1" },
    )).toMatchObject({ state: "graded", passed: true });
  });

  it("rejects a gaps grader with an empty gap answer set", () => {
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "gaps", acceptedByGap: { a: ["1"] } } }),
      { value: "no gaps object" },
    )).toEqual({ state: "unavailable", reason: "invalid_grader_specification" });
    expect(evaluateAuthoredActivity(
      activity({ grading: { kind: "gaps", acceptedByGap: {} } }),
      { gaps: { a: "1" } },
    )).toEqual({ state: "unavailable", reason: "invalid_grader_specification" });
  });
});

describe("evidence envelope decoding", () => {
  it("rejects malformed JSON, wrong version, unsupported origin, and missing fields", () => {
    const base = evidence("e1", envelope("E3", "v1"), NOW);
    expect(decodeEvidenceEnvelope({ ...base, evidenceType: "not json" })).toBeNull();
    expect(decodeEvidenceEnvelope({ ...base, evidenceType: JSON.stringify({ version: 2 }) })).toBeNull();
    expect(decodeEvidenceEnvelope({
      ...base,
      evidenceType: JSON.stringify({ ...JSON.parse(base.evidenceType) as object, origin: "manual_override" }),
    })).toBeNull();
    expect(decodeEvidenceEnvelope({
      ...base,
      evidenceType: JSON.stringify({ ...JSON.parse(base.evidenceType) as object, evidenceLevel: "E9" }),
    })).toBeNull();
    expect(decodeEvidenceEnvelope({ ...base, validity: "revoked" })).toBeNull();
  });
});

describe("mastery transition", () => {
  it("records diagnostic evidence without granting placement from self-report or hard mastery", () => {
    const attemptContext = context({ grading: { kind: "exact", acceptedAnswers: ["42"] } }, "diagnostic");
    const evaluation = evaluateAuthoredActivity(attemptContext.activity, response.answer);
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    const transition = buildMasteryTransition(
      attemptContext,
      { mastery: null, evidence: [], activeReview: null },
      response,
      evaluation,
      NOW,
    );

    expect(transition.observation.evidenceLevel).toBe("E2");
    expect(transition.masteryAwarded).toBe(false);
    expect(transition.unmetCriticalGates).toContain("independent_implementation");
    expect(transition.unmetCriticalGates).toContain("delayed_check");
  });

  it("activates remediation only after distinct deterministic failure variants", () => {
    const prior = evidence(
      "e1",
      envelope("E3", "variant-a", {
        correct: false,
        misconceptionTags: ["assignment.equality"],
      }),
      new Date(NOW.getTime() - 1_000),
    );
    const attemptContext = context(
      { grading: { kind: "exact", acceptedAnswers: ["42"], misconceptions: [{ tag: "assignment.equality", answers: ["41"] }] } },
      "practice",
      "variant-b",
    );
    const evaluation = evaluateAuthoredActivity(attemptContext.activity, { value: "41" });
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    const transition = buildMasteryTransition(
      attemptContext,
      { mastery: mastery({ score: 0.5 }), evidence: [prior], activeReview: null },
      { ...response, answer: { value: "41" } },
      evaluation,
      NOW,
    );

    expect(transition.activeMisconceptionTags).toEqual(["assignment.equality"]);
    expect(transition.progress.stage).toBe("REMEDIATION");
  });

  it("awards mastery only after probability, independent, transfer and delayed gates", () => {
    const rows = [
      evidence("e1", envelope("E3", "v1"), new Date(NOW.getTime() - 4_000)),
      evidence("e2", envelope("E4", "v2"), new Date(NOW.getTime() - 3_000)),
      evidence("e3", envelope("E5", "v3"), new Date(NOW.getTime() - 2_000)),
      evidence("e4", envelope("E6", "v4"), new Date(NOW.getTime() - 1_000)),
    ];
    const attemptContext = context({ grading: { kind: "exact", acceptedAnswers: ["42"] } }, "mastery_check", "v5");
    const evaluation = evaluateAuthoredActivity(attemptContext.activity, response.answer);
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    const transition = buildMasteryTransition(
      attemptContext,
      { mastery: mastery({ score: 0.95, status: "practicing" }), evidence: rows, activeReview: null },
      response,
      evaluation,
      NOW,
    );

    expect(transition.unmetCriticalGates).toEqual([]);
    expect(transition.masteryAwarded).toBe(true);
    expect(transition.progress.stage).toBe("MASTERED");
    expect(transition.databaseStatus).toBe("mastered");
  });

  it("prevents assisted or revealed responses from satisfying mastery", () => {
    const attemptContext = context({ grading: { kind: "exact", acceptedAnswers: ["42"] } }, "mastery_check");
    const evaluation = evaluateAuthoredActivity(attemptContext.activity, response.answer);
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    const transition = buildMasteryTransition(
      attemptContext,
      { mastery: mastery({ score: 0.95 }), evidence: [], activeReview: null },
      { ...response, assistanceLevel: "A3", solutionRevealed: true },
      evaluation,
      NOW,
    );
    expect(transition.masteryAwarded).toBe(false);
    expect(transition.unmetCriticalGates.length).toBeGreaterThan(0);
  });

  it("encodes source-safe evidence and review metadata round trips", () => {
    const attemptContext = context({ grading: { kind: "exact", acceptedAnswers: ["42"] } });
    const evaluation = evaluateAuthoredActivity(attemptContext.activity, response.answer);
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    const transition = buildMasteryTransition(
      attemptContext,
      { mastery: null, evidence: [], activeReview: null },
      response,
      evaluation,
      NOW,
    );
    const packed = evidenceEnvelopeFor(attemptContext, transition, evaluation);
    expect(decodeEvidenceEnvelope(evidence("new", packed, NOW))).toEqual(packed);

    const schedule = {
      skillId: packed.skillId,
      intervalIndex: 2,
      intervalDays: 3,
      dueAtMs: NOW.getTime(),
      successfulReviews: 2,
      lapses: 1,
    };
    const review: StoredReview = {
      id: "r1",
      userId: "learner-1",
      enrollmentId: "enrollment-1",
      conceptId: "concept-1",
      skillId: packed.skillId,
      languageContext: "conceptual",
      dueAt: NOW,
      intervalDays: 3,
      reason: encodeReviewReason(schedule, "conceptual"),
      status: "scheduled",
    };
    expect(decodeReviewSchedule(review)).toMatchObject(schedule);
  });

  it("levels a code-type activity higher than a plain quiz question", () => {
    const codeActivity: ActivityContext = { ...activity({ grading: { kind: "exact", acceptedAnswers: ["42"] } }), activityType: "code_exercise" };
    const attemptContext: AttemptContext = { ...context({ grading: { kind: "exact", acceptedAnswers: ["42"] } }), activity: codeActivity };
    const evaluation = evaluateAuthoredActivity(codeActivity, response.answer);
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    const transition = buildMasteryTransition(
      attemptContext,
      { mastery: null, evidence: [], activeReview: null },
      response,
      evaluation,
      NOW,
    );
    expect(transition.observation.evidenceLevel).toBe("E4");
  });

  it("levels a due mastery check higher than a fresh one", () => {
    const attemptContext = context({ grading: { kind: "exact", acceptedAnswers: ["42"] } }, "mastery_check");
    const evaluation = evaluateAuthoredActivity(attemptContext.activity, response.answer);
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    const dueTransition = buildMasteryTransition(
      attemptContext,
      { mastery: mastery({ score: 0.5 }), evidence: [], activeReview: activeReview(new Date(NOW.getTime() - 1_000)) },
      response,
      evaluation,
      NOW,
    );
    expect(dueTransition.observation.evidenceLevel).toBe("E6");
  });

  it("classifies a due-review outcome as failed, clean, or assisted", () => {
    const attemptContext = context({ grading: { kind: "exact", acceptedAnswers: ["42"] } }, "practice");
    const due = activeReview(new Date(NOW.getTime() - 1_000));
    const passEvaluation = evaluateAuthoredActivity(attemptContext.activity, response.answer);
    if (passEvaluation.state !== "graded") throw new Error("Expected a grade.");
    const failEvaluation = evaluateAuthoredActivity(attemptContext.activity, { value: "wrong" });
    if (failEvaluation.state !== "graded") throw new Error("Expected a grade.");

    const failed = buildMasteryTransition(
      attemptContext,
      { mastery: mastery(), evidence: [], activeReview: due },
      { ...response, answer: { value: "wrong" } },
      failEvaluation,
      NOW,
    );
    expect(failed.reviewOutcome).toBe("FAILED");

    const clean = buildMasteryTransition(
      attemptContext,
      { mastery: mastery(), evidence: [], activeReview: due },
      response,
      passEvaluation,
      NOW,
    );
    expect(clean.reviewOutcome).toBe("CLEAN");

    const assisted = buildMasteryTransition(
      attemptContext,
      { mastery: mastery(), evidence: [], activeReview: due },
      { ...response, assistanceLevel: "A2" },
      passEvaluation,
      NOW,
    );
    expect(assisted.reviewOutcome).toBe("ASSISTED");
  });

  it("maps every stored mastery status to its database status", () => {
    const attemptContext = context({ grading: { kind: "exact", acceptedAnswers: ["42"] } }, "practice");
    const evaluation = evaluateAuthoredActivity(attemptContext.activity, response.answer);
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    for (const status of ["needs_review", "proficient", "practicing", "unseen"] as const) {
      const transition = buildMasteryTransition(
        attemptContext,
        { mastery: mastery({ status }), evidence: [], activeReview: null },
        response,
        evaluation,
        NOW,
      );
      expect(typeof transition.databaseStatus).toBe("string");
    }
  });

  it("requests an initial review only once evidence reaches the E3 qualifying bar", () => {
    const attemptContext = context({ grading: { kind: "exact", acceptedAnswers: ["42"] } }, "diagnostic");
    const evaluation = evaluateAuthoredActivity(attemptContext.activity, response.answer);
    if (evaluation.state !== "graded") throw new Error("Expected a grade.");
    const transition = buildMasteryTransition(
      attemptContext,
      { mastery: null, evidence: [], activeReview: null },
      response,
      evaluation,
      NOW,
    );
    expect(transition.createInitialReview).toBe(false);
  });
});
