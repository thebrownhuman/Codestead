import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

import { ExamCatalog } from "../exam-catalog";

const recheckId = "71000000-0000-4000-8000-000000000001";

function entry() {
  return {
    courseId: "python",
    courseTitle: "Python",
    moduleId: "python.loops",
    moduleTitle: "Loops",
    summary: "Reviewed loop evidence.",
    skillCount: 4,
    durationMinutes: 24,
    readiness: "passed",
    activeSessionId: null,
    latestResult: {
      schemaVersion: 1,
      gradingStatus: "graded",
      outcome: "PASSED",
      officialScorePercent: 84,
      earnedPoints: 84,
      possiblePoints: 100,
      pendingReviewItemIds: [],
      failedCriticalClusters: [],
      masteryBlockingCodingItems: [],
      compilationGatePassed: true,
      infrastructureFailure: false,
      finalizedAt: "2026-07-12T10:00:00.000Z",
      finalizedBy: "learner-submit",
      policyVersion: "formal-exam-v1",
      remediation: { required: false, targets: [] },
      masteryRecheck: { required: true, clusterIds: ["loops-edge"], codingItemIds: [] },
    },
    retake: {
      eligible: false,
      reason: "cooldown",
      nextEligibleAt: "2026-07-13T10:00:00.000Z",
      requiresRemediation: false,
    },
    masteryRecheck: {
      id: recheckId,
      status: "available",
      dueAt: "2026-07-13T10:00:00.000Z",
      targetCount: 1,
      durationMinutes: 10,
      activeSessionId: null,
      priorPassProtected: true,
    },
  } as const;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("exam catalog mastery recheck", () => {
  it("shows the protected shorter form and starts only its user-scoped endpoint", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
      if (url === "/api/exams") return json({ exams: [entry()] });
      if (url === `/api/exams/rechecks/${recheckId}/start`) {
        return json({ exam: { sessionId: "72000000-0000-4000-8000-000000000001" } }, 201);
      }
      return json({ error: "unexpected" }, 500);
    }));
    const actor = userEvent.setup();
    render(<ExamCatalog />);

    await actor.click(await screen.findByRole("button", { name: /Start targeted mastery recheck/i }));
    expect(screen.getByText(/Protected prior pass/i)).toBeInTheDocument();
    expect(screen.getByText(/10 minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot replace your prior pass/i)).toBeInTheDocument();
    const checks = screen.getAllByRole("checkbox");
    await actor.click(checks[0]!);
    await actor.click(checks[1]!);
    await actor.click(screen.getByRole("button", { name: /Start mastery recheck/i }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/exams/72000000-0000-4000-8000-000000000001"));
    const start = calls.find((call) => call.url.includes("/rechecks/"));
    expect(start?.url).toBe(`/api/exams/rechecks/${recheckId}/start`);
    expect(start?.body).toMatchObject({
      moduleId: "python.loops",
      integrityDisclosureAccepted: true,
      readinessAcknowledged: true,
    });
  });

  it("focuses, dismisses, and restores focus for the shared start dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/exams") return json({ exams: [entry()] });
      return json({ error: "unexpected" }, 500);
    }));
    const actor = userEvent.setup();
    render(<ExamCatalog />);

    const trigger = await screen.findByRole("button", { name: /Start targeted mastery recheck/i });
    await actor.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "Loops" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();

    await actor.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Loops" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    await actor.click(trigger);
    dialog = screen.getByRole("dialog", { name: "Loops" });
    fireEvent.mouseDown(dialog.parentElement!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Loops" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("does not dismiss the start dialog while the server is creating a form", async () => {
    let resolveStart!: (value: Response) => void;
    const pendingStart = new Promise<Response>((resolve) => { resolveStart = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/exams") return json({ exams: [entry()] });
      if (url === `/api/exams/rechecks/${recheckId}/start`) return pendingStart;
      return json({ error: "unexpected" }, 500);
    }));
    const actor = userEvent.setup();
    render(<ExamCatalog />);

    await actor.click(await screen.findByRole("button", { name: /Start targeted mastery recheck/i }));
    const dialog = screen.getByRole("dialog", { name: "Loops" });
    const checks = within(dialog).getAllByRole("checkbox");
    await actor.click(checks[0]!);
    await actor.click(checks[1]!);
    await actor.click(within(dialog).getByRole("button", { name: /Start mastery recheck/i }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /Creating secure form/i })).toBeDisabled());

    await actor.keyboard("{Escape}");
    fireEvent.mouseDown(dialog.parentElement!);
    expect(screen.getByRole("dialog", { name: "Loops" })).toBeInTheDocument();

    await act(async () => {
      resolveStart(json({ exam: { sessionId: "72000000-0000-4000-8000-000000000001" } }, 201));
    });
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/exams/72000000-0000-4000-8000-000000000001"));
  });
});
