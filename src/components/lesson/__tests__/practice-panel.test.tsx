import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PracticePanel } from "../practice-panel";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

const creation = {
  state: "ready",
  attempt: {
    id: "50000000-0000-4000-8000-000000000001",
    kind: "practice",
    attemptNumber: 1,
    status: "in_progress",
    contentVersion: "1.0.0",
  },
  activity: {
    id: "20000000-0000-4000-8000-000000000001",
    slug: "variables-choice-a",
    skillId: "python.variables.assignment",
    courseVersion: "1.0.0",
    languageContext: "conceptual",
    specification: {
      kind: "mcq",
      itemKey: "variables-choice-a",
      title: "Choose the assignment",
      prompt: "Which statement stores four in x?",
      options: [{ id: "a", text: "x = 4" }, { id: "b", text: "4 = x" }],
      multiple: false,
      artifact: [],
      template: null,
      gaps: [],
      starterCode: null,
      language: null,
      help: {
        totalSteps: 5,
        hintSteps: 2,
        hasAlternateExplanation: true,
        hasWorkedExample: true,
        hasSolution: true,
      },
    },
  },
  idempotent: false,
} as const;

function graded(options: { correct?: boolean; revealed?: boolean } = {}) {
  const correct = options.correct ?? false;
  const revealed = options.revealed ?? false;
  return {
    state: "graded",
    attemptId: creation.attempt.id,
    attemptStatus: "graded",
    score: correct ? 1 : 0,
    passed: correct,
    officialEvidenceRecorded: true,
    masteryAwarded: false,
    progress: null,
    criticalGates: ["independent_implementation"],
    remediation: { activeTags: [], confirmingProbeTags: ["assignment.direction"] },
    feedback: {
      correct,
      headline: correct ? "Correct" : "Not yet",
      why: correct ? "That direction is valid." : "The destination belongs on the left.",
      misconceptionTags: correct ? [] : ["assignment.direction"],
      remediation: correct ? [] : [{
        tag: "assignment.direction",
        explanation: "Read assignment right to left.",
        retryPrompt: "Name the destination before the value.",
      }],
      independent: correct && !revealed,
      assistanceLevel: revealed ? "A4" : "A1",
      solutionRevealed: revealed,
      solution: revealed ? { answer: "x = 4", explanation: "Four is stored in x." } : null,
      nextAction: correct && !revealed ? "continue" : "retry_fresh",
    },
    reviewDueAt: null,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("learner persisted practice panel", () => {
  it("creates an idempotent owner-bound attempt, records hint assistance, and shows targeted retry feedback", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => jsonResponse(creation, 201))
      .mockImplementationOnce(() => jsonResponse({
        state: "ready", attemptId: creation.attempt.id, helpStep: 1, assistanceLevel: "A1",
        solutionRevealed: false, help: { kind: "hint", content: "The destination name is on the left.", answer: null },
        requiresFreshAttempt: false, idempotent: false,
      }))
      .mockImplementationOnce(() => jsonResponse(graded()));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<PracticePanel skillId="python.variables.assignment" draftPreviewCount={3} />);

    expect(screen.getByText(/3 draft preview items are intentionally excluded/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start practice" }));
    expect(await screen.findByRole("heading", { name: "Choose the assignment" })).toBeInTheDocument();
    const createBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(createBody).toMatchObject({ skillId: "python.variables.assignment", kind: "practice" });
    expect(createBody.idempotencyKey).toMatch(/^practice-/);

    expect(document.body.textContent).not.toContain("The destination name is on the left.");
    await user.click(screen.getByRole("button", { name: "Show next help" }));
    expect(screen.getByText("The destination name is on the left.")).toBeInTheDocument();
    await user.click(screen.getByLabelText("4 = x"));
    await user.click(screen.getByRole("button", { name: "Check answer" }));

    expect(await screen.findByRole("heading", { name: "Not yet" })).toBeInTheDocument();
    expect(screen.getByText("Read assignment right to left.")).toBeInTheDocument();
    expect(screen.getByText(/Assisted practice evidence saved; it cannot prove mastery/i)).toBeInTheDocument();
    const helpBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(helpBody.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const submitBody = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    expect(submitBody).toEqual({
      itemKey: "variables-choice-a",
      responseRevision: 1,
      answer: { value: "b" },
      assistanceLevel: "A0",
      solutionRevealed: false,
    });
  });

  it("records I-don't-know without inventing an answer", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => jsonResponse(creation, 201))
      .mockImplementationOnce(() => jsonResponse(graded()));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<PracticePanel skillId="python.variables.assignment" />);
    await user.click(screen.getByRole("button", { name: "Start practice" }));
    await screen.findByRole("heading", { name: "Choose the assignment" });
    await user.click(screen.getByRole("button", { name: "I don’t know" }));
    await screen.findByRole("heading", { name: "Not yet" });
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({ answer: { value: "" }, assistanceLevel: "A0", solutionRevealed: false });
  });

  it("records solution reveal as A4 non-mastery work", async () => {
    const solutionCreation = {
      ...creation,
      activity: {
        ...creation.activity,
        specification: {
          ...creation.activity.specification,
          help: { totalSteps: 1, hintSteps: 0, hasAlternateExplanation: false, hasWorkedExample: false, hasSolution: true },
        },
      },
    };
    const fetch = vi.fn()
      .mockImplementationOnce(() => jsonResponse(solutionCreation, 201))
      .mockImplementationOnce(() => jsonResponse({
        state: "ready", attemptId: creation.attempt.id, helpStep: 1, assistanceLevel: "A4",
        solutionRevealed: true, help: { kind: "solution", content: "Four is stored in x.", answer: "x = 4" },
        requiresFreshAttempt: true, idempotent: false,
      }))
      .mockImplementationOnce(() => jsonResponse(graded({ revealed: true })));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<PracticePanel skillId="python.variables.assignment" />);
    await user.click(screen.getByRole("button", { name: "Start practice" }));
    await screen.findByRole("heading", { name: "Choose the assignment" });
    await user.click(screen.getByRole("button", { name: "Reveal solution and record help" }));
    expect(await screen.findByText("Four is stored in x.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I don’t know" }));
    expect(await screen.findByText("Recorded solution reveal")).toBeInTheDocument();
    expect(screen.getAllByText("x = 4")).toHaveLength(2);
    const body = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    expect(body).toMatchObject({ assistanceLevel: "A0", solutionRevealed: false });
  });

  it("renders an explicit no-published-activity state and safely retries the same request key", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => jsonResponse({
        state: "degraded", attempt: null, activity: null, idempotent: false, reason: "activity_unavailable",
      }, 201))
      .mockImplementationOnce(() => jsonResponse({
        state: "degraded", attempt: null, activity: null, idempotent: true, reason: "activity_unavailable",
      }, 201));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<PracticePanel skillId="python.variables.assignment" />);
    await user.click(screen.getByRole("button", { name: "Start practice" }));
    expect(await screen.findByRole("heading", { name: "Practice is not available yet" })).toBeInTheDocument();
    expect(screen.getByText(/No reviewed, published practice activity/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry safely" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const first = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const second = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(screen.getByRole("link", { name: "Report a content problem" })).toHaveAttribute("href", expect.stringContaining("skillId=python.variables.assignment"));
  });

  it("runs a strict official MCQ checkpoint, manages async focus, and starts unlimited fresh attempts", async () => {
    const checkpointCreation = {
      ...creation,
      attempt: { ...creation.attempt, kind: "quiz", attemptNumber: 1 },
    };
    const secondCheckpoint = {
      ...checkpointCreation,
      attempt: {
        ...checkpointCreation.attempt,
        id: "50000000-0000-4000-8000-000000000002",
        attemptNumber: 2,
      },
    };
    const fetch = vi.fn()
      .mockImplementationOnce(() => jsonResponse(checkpointCreation, 201))
      .mockImplementationOnce(() => jsonResponse(graded({ correct: true })))
      .mockImplementationOnce(() => jsonResponse(secondCheckpoint, 201));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<PracticePanel purpose="checkpoint" skillId="python.variables.assignment" draftPreviewCount={2} />);

    expect(screen.getByRole("heading", { name: "One reviewed MCQ for this topic" })).toBeInTheDocument();
    expect(screen.getByText(/2 draft preview items are intentionally excluded until independent human review and publication/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start checkpoint" }));
    const questionHeading = await screen.findByRole("heading", { name: "Choose the assignment" });
    await waitFor(() => expect(questionHeading).toHaveFocus());
    expect(screen.getByText("official MCQ")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show next help" })).not.toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      kind: "quiz",
      skillId: "python.variables.assignment",
    });

    await user.click(screen.getByLabelText("x = 4"));
    await user.click(screen.getByRole("button", { name: "Check answer" }));
    const resultHeading = await screen.findByRole("heading", { name: "Correct" });
    await waitFor(() => expect(resultHeading).toHaveFocus());
    expect(screen.getByText(/checkpoint response was saved as deterministic official evidence/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: "Try another checkpoint" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const firstCreate = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const secondCreate = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    expect(firstCreate.idempotencyKey).toMatch(/^checkpoint-/);
    expect(secondCreate.idempotencyKey).toMatch(/^checkpoint-/);
    expect(secondCreate.idempotencyKey).not.toBe(firstCreate.idempotencyKey);
    expect(secondCreate.kind).toBe("quiz");
  });

  it("shows and focuses an honest checkpoint-unavailable state without falling back to drafts", async () => {
    const fetch = vi.fn().mockImplementationOnce(() => jsonResponse({
      state: "degraded",
      attempt: null,
      activity: null,
      idempotent: false,
      reason: "activity_unavailable",
    }, 201));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<PracticePanel purpose="checkpoint" skillId="python.variables.assignment" draftPreviewCount={7} />);
    await user.click(screen.getByRole("button", { name: "Start checkpoint" }));
    const heading = await screen.findByRole("heading", { name: "Checkpoint is not available yet" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/No independently human-reviewed MCQ from the current publication/i)).toBeInTheDocument();
    expect(screen.getByText(/Draft and AI-only questions remain excluded/i)).toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ kind: "quiz" });
  });
});
