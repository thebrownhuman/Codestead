import { render, screen, waitFor } from "@testing-library/react";
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
  afterEach(() => vi.unstubAllGlobals());

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
