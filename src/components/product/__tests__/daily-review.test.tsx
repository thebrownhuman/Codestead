import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DailyReview } from "../daily-review";

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

const attempt = {
  state: "ready",
  attempt: {
    id: "30000000-0000-4000-8000-000000000001",
    kind: "quiz",
    attemptNumber: 1,
    status: "in_progress",
    contentVersion: "1.0.0",
  },
  activity: {
    id: "40000000-0000-4000-8000-000000000001",
    slug: "variables-choice-a",
    skillId: "python.variables",
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
      help: { totalSteps: 0, hintSteps: 0, hasAlternateExplanation: false, hasWorkedExample: false, hasSolution: false },
    },
  },
  idempotent: true,
} as const;

const gradedResult = {
  state: "graded",
  attemptId: attempt.attempt.id,
  attemptStatus: "graded",
  score: 1,
  passed: true,
  officialEvidenceRecorded: true,
  masteryAwarded: false,
  progress: null,
  criticalGates: [],
  remediation: { activeTags: [], confirmingProbeTags: [] },
  feedback: {
    correct: true,
    headline: "Correct",
    why: "The reviewed assignment rule matches.",
    misconceptionTags: [],
    remediation: [],
    independent: true,
    assistanceLevel: "A0",
    solutionRevealed: false,
    solution: null,
    nextAction: "continue",
  },
  reviewDueAt: null,
} as const;

function item(position: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `20000000-0000-4000-8000-00000000000${position}`,
    position,
    skillId: position === 1 ? "python.variables" : `python.skill-${position}`,
    skillTitle: position === 1 ? "Variables" : `Skill ${position}`,
    courseTitle: "Python",
    priorityReason: position === 1 ? "confirmed_misconception" : "lowest_confidence",
    confidencePercent: position * 10,
    status: "pending",
    score: null,
    passed: null,
    href: `/courses/python/skills/skill-${position}`,
    attempt: position === 1 ? attempt : null,
    ...overrides,
  };
}

function ready() {
  return {
    state: "ready",
    localDate: "2026-07-13",
    timezone: "Asia/Kolkata",
    session: {
      id: "10000000-0000-4000-8000-000000000001",
      localDate: "2026-07-13",
      timezone: "Asia/Kolkata",
      status: "ready",
      availableItemCount: 5,
      questionCount: 5,
      completedCount: 0,
      items: [1, 2, 3, 4, 5].map((position) => item(position)),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DailyReview", () => {
  it("shows an honest unavailable state instead of filling with draft questions", async () => {
    const newlyReady = ready();
    newlyReady.session.items = newlyReady.session.items.map((entry, index) => index === 0 ? item(1, { attempt: null }) : entry);
    const fetch = vi.fn()
      .mockImplementationOnce(() => json({ state: "not_started", localDate: "2026-07-13", timezone: "Asia/Kolkata", session: null }))
      .mockImplementationOnce(() => json({
        state: "unavailable",
        localDate: "2026-07-13",
        timezone: "Asia/Kolkata",
        session: {
          id: "10000000-0000-4000-8000-000000000001",
          localDate: "2026-07-13",
          timezone: "Asia/Kolkata",
          status: "unavailable",
          availableItemCount: 2,
          questionCount: 0,
          completedCount: 0,
          items: [],
        },
      }, 201))
      .mockImplementationOnce(() => json(newlyReady, 201));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<DailyReview />);

    await user.click(await screen.findByRole("button", { name: /build today.?s review/i }));
    const unavailableHeading = await screen.findByRole("heading", { name: "Not enough reviewed questions yet" });
    expect(unavailableHeading).toBeInTheDocument();
    expect(unavailableHeading.closest('[tabindex="-1"]')).toHaveFocus();
    expect(screen.getByText(/found 2 of the 5 distinct/i)).toBeInTheDocument();
    expect(screen.getByText(/Draft or AI-only questions are never used/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /check again/i }));
    expect(await screen.findByRole("button", { name: /open question/i })).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 5").closest('[tabindex="-1"]')).toHaveFocus();
  });

  it("opens the exact reserved question once and moves keyboard focus into it", async () => {
    const reserved = ready();
    reserved.session.items = reserved.session.items.map((entry, index) => index === 0 ? item(1, { attempt: null }) : entry);
    const fetch = vi.fn()
      .mockImplementationOnce(() => json(reserved))
      .mockImplementationOnce(() => json(attempt, 201));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<DailyReview />);

    await user.click(await screen.findByRole("button", { name: /open question/i }));
    const question = await screen.findByRole("heading", { name: "Choose the assignment" });
    expect(question.closest('[tabindex="-1"]')).toHaveFocus();
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "/api/learning/daily-review/10000000-0000-4000-8000-000000000001/items/20000000-0000-4000-8000-000000000001/attempt",
    );
  });

  it("renders a 1-of-5 reviewed question and submits through the existing attempt endpoint", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => json(ready()))
      .mockImplementationOnce(() => json(gradedResult));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<DailyReview />);

    expect(await screen.findByText("Question 1 of 5")).toBeInTheDocument();
    expect(screen.getByText(/Python · Misconception check/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Daily review completion" })).toHaveAttribute("aria-valuenow", "0");
    await user.click(screen.getByLabelText("x = 4"));
    await user.click(screen.getByRole("button", { name: /check answer/i }));

    expect(await screen.findByRole("heading", { name: "Correct" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveFocus();
    const submit = fetch.mock.calls[1];
    expect(submit[0]).toBe(`/api/learning/attempts/${attempt.attempt.id}/submit`);
    expect(JSON.parse(String((submit[1] as RequestInit).body))).toMatchObject({
      itemKey: "variables-choice-a",
      answer: { value: "a" },
      assistanceLevel: "A0",
      solutionRevealed: false,
    });
  });

  it("supports reviewed fill-gap questions and submits their structured answer", async () => {
    const fillAttempt = {
      ...attempt,
      activity: {
        ...attempt.activity,
        specification: {
          ...attempt.activity.specification,
          kind: "fill-gap",
          title: "Complete the assignment",
          prompt: "Fill the missing value.",
          options: [],
          gaps: [{ id: "value", label: "Stored value" }],
        },
      },
    };
    const payload = ready();
    payload.session.items = payload.session.items.map((entry, index) => index === 0 ? item(1, { attempt: fillAttempt }) : entry);
    const fetch = vi.fn()
      .mockImplementationOnce(() => json(payload))
      .mockImplementationOnce(() => json(gradedResult));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<DailyReview />);

    await user.type(await screen.findByLabelText("Stored value"), "4");
    await user.click(screen.getByRole("button", { name: /check answer/i }));
    expect(await screen.findByRole("heading", { name: "Correct" })).toBeInTheDocument();
    expect(JSON.parse(String((fetch.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      answer: { gaps: { value: "4" } },
    });
  });

  it("moves focus to the completed summary after the fifth reviewed answer", async () => {
    const last = ready();
    last.session.completedCount = 4;
    last.session.items = last.session.items.map((entry, index) => item(index + 1, index < 4 ? {
      status: "answered",
      score: 1,
      passed: true,
      attempt: null,
    } : { attempt }));
    const completed = ready();
    completed.state = "completed";
    completed.session.status = "completed";
    completed.session.completedCount = 5;
    completed.session.items = completed.session.items.map((entry, index) => item(index + 1, {
      status: "answered",
      score: 1,
      passed: true,
      attempt: null,
    }));
    const fetch = vi.fn()
      .mockImplementationOnce(() => json(last))
      .mockImplementationOnce(() => json(gradedResult))
      .mockImplementationOnce(() => json(completed));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<DailyReview />);

    await user.click(await screen.findByLabelText("x = 4"));
    await user.click(screen.getByRole("button", { name: /check answer/i }));
    await user.click(await screen.findByRole("button", { name: /see today.?s summary/i }));
    const summary = await screen.findByText("Daily five complete");
    expect(summary.closest('[tabindex="-1"]')).toHaveFocus();
  });

  it("summarizes all five outcomes and links weak skills to targeted practice", async () => {
    const completed = ready();
    completed.state = "completed";
    completed.session.status = "completed";
    completed.session.completedCount = 5;
    completed.session.items = completed.session.items.map((entry, index) => item(index + 1, {
      status: "answered",
      score: index === 2 ? 0 : 1,
      passed: index !== 2,
      attempt: null,
    }));
    vi.stubGlobal("fetch", vi.fn(() => json(completed)));
    render(<DailyReview />);

    expect(await screen.findByText("Daily five complete")).toBeInTheDocument();
    expect(screen.getByText("4 of 5 correct. Every result is saved to your learning evidence.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /practice/i })).toHaveAttribute("href", "/courses/python/skills/skill-3");
  });
});
