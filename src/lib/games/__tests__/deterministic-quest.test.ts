import { describe, expect, it } from "vitest";

import type {
  FillGapAssessmentItem,
  McqAssessmentItem,
  TraceAssessmentItem,
} from "@/lib/content";
import { evaluateDraftQuest } from "../deterministic-quest";

const base = {
  id: "item-1",
  skillId: "pf.state.variables",
  title: "Variable checkpoint",
  prompt: "Choose.",
  points: 4,
  evidenceLevel: "apply" as const,
  examEligibility: { eligible: false, rationale: "Draft" },
  hints: ["First hint", "Second hint"],
  feedback: { correct: "Correct feedback", incorrect: "Try again" },
  rubric: { passPoints: 4, criteria: [{ id: "c", description: "Correct", points: 4, critical: true }] },
  privateAuthorNotes: [],
};

describe("deterministic draft quest evaluation", () => {
  it("compares MCQ sets exactly and never creates authoritative evidence", () => {
    const item: McqAssessmentItem = {
      ...base,
      kind: "mcq",
      options: [{ id: "a", text: "A" }, { id: "b", text: "B" }],
      answer: { correctOptionIds: ["b", "a"], explanation: "Both" },
    };
    expect(evaluateDraftQuest(item, { selectedOptionIds: ["a", "b", "a"] })).toMatchObject({
      correct: true,
      stageAdvance: true,
      authoritativeEvidence: false,
      hint: null,
    });
    expect(evaluateDraftQuest(item, { selectedOptionIds: ["a"] }, 1)).toMatchObject({
      correct: false,
      stageAdvance: false,
      hint: "Second hint",
      feedback: "Try again",
    });
  });

  it("grades every fill gap with bounded whitespace and case handling", () => {
    const item: FillGapAssessmentItem = {
      ...base,
      kind: "fill-gap",
      template: "[[left]] + [[right]]",
      gaps: [{ id: "left", label: "Left" }, { id: "right", label: "Right" }],
      answer: {
        acceptedByGap: { left: ["Hello world"], right: ["Python"] },
        caseSensitive: false,
        explanation: "Both",
      },
    };
    expect(evaluateDraftQuest(item, { gaps: { left: " hello   WORLD ", right: "PYTHON" } }).correct).toBe(true);
    expect(evaluateDraftQuest(item, { gaps: { left: "Hello world" } }).correct).toBe(false);
    expect(evaluateDraftQuest(item, { trace: "wrong response shape" }).correct).toBe(false);
  });

  it("honors case-sensitive trace answers and clamps hint indexes", () => {
    const item: TraceAssessmentItem = {
      ...base,
      kind: "trace",
      artifact: ["print('Ready')"],
      answer: { acceptedTraces: ["Ready"], caseSensitive: true, explanation: "Exact" },
    };
    expect(evaluateDraftQuest(item, { trace: "Ready" }).correct).toBe(true);
    expect(evaluateDraftQuest(item, { trace: "ready" }, 999)).toMatchObject({
      correct: false,
      hint: "Second hint",
    });
  });
});
