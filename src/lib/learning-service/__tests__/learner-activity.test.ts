import { describe, expect, it } from "vitest";

import {
  practiceFeedbackFor,
  practiceHelpAt,
  toLearnerActivityForAttemptKind,
  toLearnerAttemptCreationPayload,
  toLearnerPracticeActivity,
} from "../learner-activity";
import type { ActivityContext, AttemptCreationResult, DeterministicEvaluation } from "../types";

function activity(overrides: Record<string, unknown> = {}): ActivityContext {
  return {
    activityId: "20000000-0000-4000-8000-000000000001",
    activitySlug: "variables-choice-a",
    activityType: "practice-mcq",
    specification: {
      kind: "mcq",
      itemKey: "variables-choice-a",
      title: "Choose the reassignment",
      prompt: "Which statement changes x to 4?",
      options: [{ id: "a", text: "x = 4" }, { id: "b", text: "4 = x" }],
      hints: ["The variable name belongs on the left."],
      alternateExplanation: "Assignment stores the right-side value in the left-side name.",
      workedExample: "count = 2 stores two in count.",
      grading: {
        kind: "choice",
        acceptedAnswers: ["a"],
        misconceptions: [{ tag: "assignment.direction", answers: ["b"] }],
      },
      feedback: { correct: "The assignment direction is valid.", incorrect: "The destination belongs on the left." },
      remediation: [{ tag: "assignment.direction", explanation: "Read assignment right to left.", retryPrompt: "Name the destination first." }],
      solutionReveal: { answer: "x = 4", explanation: "The right-side value is stored in x." },
      hiddenTests: [{ input: "secret", expected: "never" }],
      referenceSolution: "private reference",
      privateAuthorNotes: ["private note"],
      ...overrides,
    },
    skillId: "python.variables.assignment",
    conceptId: "30000000-0000-4000-8000-000000000001",
    enrollmentId: "40000000-0000-4000-8000-000000000001",
    courseVersion: "1.0.0",
    trackId: "python",
    implementationLanguage: null,
    languageContext: "conceptual",
  };
}

const evaluation: DeterministicEvaluation = {
  state: "graded",
  origin: "deterministic_spec",
  score: 0,
  passed: false,
  correct: false,
  misconceptionTags: ["assignment.direction"],
};

describe("learner practice activity boundary", () => {
  it("allowlists prompt fields and never serializes graders, answers, notes, or hidden tests", () => {
    const learner = toLearnerPracticeActivity(activity());
    expect(learner).toMatchObject({
      slug: "variables-choice-a",
      specification: {
        kind: "mcq",
        prompt: "Which statement changes x to 4?",
        help: { totalSteps: 4, hintSteps: 1, hasSolution: true },
      },
    });
    const serialized = JSON.stringify(learner);
    expect(serialized).not.toMatch(/acceptedAnswers|grading|hiddenTests|expected|referenceSolution|privateAuthorNotes|The right-side value is stored in x|The variable name belongs on the left|Assignment stores|count = 2/);
  });

  it("fails closed for an unsupported or incomplete learner prompt", () => {
    expect(toLearnerPracticeActivity(activity({ prompt: undefined }))).toBeNull();
    expect(toLearnerPracticeActivity(activity({ kind: "mcq", options: [{ id: "a", text: "Only one" }] }))).toBeNull();
    expect(toLearnerPracticeActivity(activity({ kind: "essay" }))).toBeNull();
  });

  it("permits mixed reviewed formats for practice but only MCQ for an official quiz checkpoint", () => {
    const trace = activity({
      kind: "trace",
      prompt: "What value is displayed?",
      artifact: ["x = 4", "print(x)"],
      grading: { kind: "exact", acceptedAnswers: ["4"] },
    });
    expect(toLearnerActivityForAttemptKind(trace, "practice")?.specification.kind).toBe("trace");
    expect(toLearnerActivityForAttemptKind(trace, "quiz")).toBeNull();
    expect(toLearnerActivityForAttemptKind(activity(), "quiz")?.specification.kind).toBe("mcq");
  });

  it("fails closed when an MCQ grader and response shape do not agree", () => {
    expect(toLearnerActivityForAttemptKind(activity({
      multiple: false,
      grading: { kind: "set", correctOptionIds: ["a", "b"] },
    }), "quiz")).toBeNull();
    expect(toLearnerActivityForAttemptKind(activity({
      multiple: true,
      grading: { kind: "choice", acceptedAnswers: ["a"] },
    }), "quiz")).toBeNull();
    expect(toLearnerActivityForAttemptKind(activity({
      multiple: true,
      grading: { kind: "set", correctOptionIds: ["a", "missing"] },
    }), "quiz")).toBeNull();
    expect(toLearnerActivityForAttemptKind(activity({
      multiple: true,
      grading: { kind: "set", correctOptionIds: ["a", "b"] },
    }), "quiz")?.specification.multiple).toBe(true);
  });

  it("returns a minimal creation payload without user, enrollment, concept, or private specification fields", () => {
    const internal: AttemptCreationResult = {
      state: "ready",
      attempt: {
        id: "50000000-0000-4000-8000-000000000001",
        userId: "private-user",
        activityId: activity().activityId,
        enrollmentId: activity().enrollmentId,
        kind: "practice",
        attemptNumber: 2,
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
        startedAt: new Date(),
        submittedAt: null,
        gradedAt: null,
      },
      activity: activity(),
      idempotent: false,
    };
    const payload = toLearnerAttemptCreationPayload(internal);
    expect(payload.state).toBe("ready");
    expect(JSON.stringify(payload)).not.toMatch(/private-user|enrollmentId|conceptId|acceptedAnswers/);
  });

  it("fails the learner payload closed if a quiz attempt is bound to a non-MCQ activity", () => {
    const trace = activity({
      kind: "trace",
      prompt: "What value is displayed?",
      artifact: ["print(4)"],
      grading: { kind: "exact", acceptedAnswers: ["4"] },
    });
    const internal: AttemptCreationResult = {
      state: "ready",
      attempt: {
        id: "50000000-0000-4000-8000-000000000002",
        userId: "private-user",
        activityId: trace.activityId,
        enrollmentId: trace.enrollmentId,
        kind: "quiz",
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
        startedAt: new Date(),
        submittedAt: null,
        gradedAt: null,
      },
      activity: trace,
      idempotent: false,
    };
    expect(toLearnerAttemptCreationPayload(internal)).toEqual({
      state: "degraded",
      attempt: null,
      activity: null,
      idempotent: false,
      reason: "activity_unsupported",
    });
  });

  it("reveals dedicated solution text only after a persisted reveal and returns targeted remediation", () => {
    const before = practiceFeedbackFor(activity(), evaluation, { assistanceLevel: "A1", solutionRevealed: false });
    expect(before).toMatchObject({
      correct: false,
      independent: false,
      solution: null,
      nextAction: "retry_fresh",
      remediation: [{ tag: "assignment.direction", retryPrompt: "Name the destination first." }],
    });
    expect(JSON.stringify(before)).not.toContain("The right-side value is stored in x");

    const revealed = practiceFeedbackFor(activity(), evaluation, { assistanceLevel: "A4", solutionRevealed: true });
    expect(revealed.solution).toEqual({ answer: "x = 4", explanation: "The right-side value is stored in x." });
    expect(revealed.independent).toBe(false);
  });

  it("resolves one private help step at a time while the creation payload carries only counts", () => {
    const learner = toLearnerPracticeActivity(activity())!;
    expect(learner.specification.help).toEqual({
      totalSteps: 4,
      hintSteps: 1,
      hasAlternateExplanation: true,
      hasWorkedExample: true,
      hasSolution: true,
    });
    expect(practiceHelpAt(activity(), 1)).toMatchObject({ kind: "hint", assistanceLevel: "A1", content: "The variable name belongs on the left." });
    expect(practiceHelpAt(activity(), 4)).toMatchObject({ kind: "solution", assistanceLevel: "A4", answer: "x = 4", solutionRevealed: true });
    expect(practiceHelpAt(activity(), 5)).toBeNull();
  });
});
