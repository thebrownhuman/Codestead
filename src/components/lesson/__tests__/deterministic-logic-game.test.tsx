import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AtomicSkill, LearnerAssessmentBank } from "@/lib/content";
import { DeterministicLogicGame } from "../deterministic-logic-game";

const skill = {
  id: "pf.state.variables",
  title: "Variables and state",
  outcomes: ["Trace state changes."],
} as unknown as AtomicSkill;

const bank: LearnerAssessmentBank = {
  id: "bank.variables",
  schemaVersion: "1.0.0",
  courseId: "programming-foundations",
  moduleId: "pf.state",
  skillId: skill.id,
  title: "Variable quest",
  provenance: { stage: "draft", aiAssisted: true, reviewRequired: true },
  items: [{
    id: "variables-mcq",
    skillId: skill.id,
    title: "Restore the variable console",
    kind: "mcq",
    prompt: "Which assignment changes count from 1 to 2?",
    points: 4,
    evidenceLevel: "apply",
    examEligibility: { eligible: false, rationale: "Draft" },
    hints: ["Read the current value before storing the next value."],
    options: [
      { id: "right", text: "count = count + 1" },
      { id: "wrong", text: "count == 2" },
    ],
  }],
};

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("deterministic lesson logic game", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const correctResult = {
    correct: true, stageAdvance: true, authoritativeEvidence: false,
    feedback: "Correct deterministic feedback", hint: null, notice: "Practice only",
  };
  const threeCheckpoints: LearnerAssessmentBank = {
    ...bank,
    items: [0, 1, 2].map((index) => ({
      ...bank.items[0], id: `checkpoint-${index}`, title: `Checkpoint ${index + 1}`,
    })),
  };

  it("locks a successful checkpoint until exactly one advance completes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json(correctResult));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeterministicLogicGame bank={threeCheckpoints} skill={skill} />);
    fireEvent.click(screen.getByLabelText("count = count + 1"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Run action/i })); });
    const checking = screen.getByRole("button", { name: /Checking/i });
    expect(checking).toBeDisabled();
    fireEvent.click(checking);
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Checkpoint 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run action/i })).toBeDisabled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds manual hints to the available hints and submits a valid index", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return json({ ...correctResult, correct: false, stageAdvance: false });
    }));
    render(<DeterministicLogicGame bank={bank} skill={skill} />);
    const hintButton = screen.getByRole("button", { name: "Use a hint" });
    for (let index = 0; index < 25; index++) fireEvent.click(hintButton);
    expect(hintButton).toBeDisabled();
    fireEvent.click(screen.getByLabelText("count = count + 1"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Run action/i })); });
    expect(body?.hintIndex).toBe(1);
  });

  it("cancels pending advancement when the quest unmounts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => json(correctResult)));
    const { unmount } = render(<DeterministicLogicGame bank={threeCheckpoints} skill={skill} />);
    fireEvent.click(screen.getByLabelText("count = count + 1"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Run action/i })); });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an in-flight check and ignores its late response after changing banks", async () => {
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    const { rerender } = render(<DeterministicLogicGame bank={threeCheckpoints} skill={skill} />);
    fireEvent.click(screen.getByLabelText("count = count + 1"));
    fireEvent.click(screen.getByRole("button", { name: /Run action/i }));
    rerender(<DeterministicLogicGame bank={{ ...bank, id: "next-bank" }} skill={skill} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish(json(correctResult)); });
    expect(screen.getByText(/stage 1 of 1/i)).toBeInTheDocument();
    expect(screen.queryByText("Checkpoint restored")).not.toBeInTheDocument();
  });

  it("unlocks a failed request so the learner can retry", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(json({ ...correctResult, correct: false, stageAdvance: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeterministicLogicGame bank={bank} skill={skill} />);
    fireEvent.click(screen.getByLabelText("count = count + 1"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Run action/i })); });
    expect(screen.getByText("Connection interrupted")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run action/i })).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Run action/i })); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stays on a wrong checkpoint, advances only on server-confirmed correctness, and awards no XP", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        response: { selectedOptionIds: string[] };
      } & Record<string, unknown>;
      bodies.push(body);
      const correct = body.response.selectedOptionIds.includes("right");
      return json({
        correct,
        stageAdvance: correct,
        authoritativeEvidence: false,
        feedback: correct ? "Correct deterministic feedback" : "Trace the assignment again",
        hint: correct ? null : "Read the current value first.",
        notice: "Draft game practice never awards mastery, exam credit, badges, leaderboard points, or unlimited replay XP.",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<DeterministicLogicGame bank={bank} skill={skill} />);

    expect(screen.getByText(/stage 1 of 1/i)).toBeInTheDocument();
    expect(screen.getByText(/AI-assisted draft awaiting human review/i)).toBeInTheDocument();
    await user.click(screen.getByLabelText("count == 2"));
    await user.click(screen.getByRole("button", { name: /Run action/i }));
    expect(await screen.findByText("Not yet")).toBeInTheDocument();
    expect(screen.getByText(/stage 1 of 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Read the current value first/i)).toBeInTheDocument();

    await user.click(screen.getByLabelText("count = count + 1"));
    await user.click(screen.getByRole("button", { name: /Run action/i }));
    expect(await screen.findByText(/Logic quest complete/i, {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.getByText(/awarded no mastery, badge, exam credit, leaderboard points, or XP/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replay without XP/i })).toBeInTheDocument();

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      skillId: skill.id,
      itemId: "variables-mcq",
      response: { selectedOptionIds: ["wrong"] },
      hintIndex: 0,
    });
    expect(String(bodies[0]?.clientRequestId)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(bodies)).not.toMatch(/correctOptionIds|acceptedByGap|referenceSolution/);
  });

  it("keeps the checkpoint retryable when the checker is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Runner unavailable" }, { status: 503 })));
    const user = userEvent.setup();
    render(<DeterministicLogicGame bank={bank} skill={skill} />);
    await user.click(screen.getByLabelText("count = count + 1"));
    await user.click(screen.getByRole("button", { name: /Run action/i }));
    expect(await screen.findByText("Runner unavailable")).toBeInTheDocument();
    expect(screen.getByText(/stage 1 of 1/i)).toBeInTheDocument();
    expect(screen.queryByText(/Logic quest complete/i)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /Run action/i })).toBeEnabled());
  });
});
