import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiOutputReport } from "../ai-output-report";
import { TutorView } from "../tutor-view";

const callId = "00000000-0000-4000-8000-000000000001";

describe("AI output reporting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lets the learner report a specific persisted tutor call for human review", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/ai/threads?")) {
        return new Response(JSON.stringify({ threads: [], nextCursor: null }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/ai/tutor") {
        return new Response(JSON.stringify({
          content: "Assignment stores a value; equality compares values.",
          provider: "nvidia_nim",
          model: "test/model",
          source: "learner",
          callId,
          threadId: "10000000-0000-4000-8000-000000000001",
          thread: {
            id: "10000000-0000-4000-8000-000000000001",
            title: "Python: Scalar values",
            status: "active",
            updatedAt: "2026-07-12T10:00:00.000Z",
          },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === "/api/ai/reports") {
        return new Response(JSON.stringify({ report: { id: "report-1", status: "pending" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<TutorView />);

    const composer = screen.getByLabelText("Message Codestead");
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, "Explain assignment versus equality.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Assignment stores a value; equality compares values.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Report this response" }));
    await user.type(
      screen.getByLabelText(/What went wrong/),
      "The answer still confuses the assignment target with the compared value.",
    );
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    expect(await screen.findByText("Reported for administrator review.")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/ai/reports",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(callId),
      }),
    ));
  });
});

describe("AI output report form resilience", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function openAndFill(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Report this response" }));
    await user.type(screen.getByLabelText(/What went wrong/), "The answer confuses assignment with equality checks.");
  }

  it("recovers from a network failure and retries with the same request id", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ report: { id: "report-1" } }), { status: 201, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AiOutputReport callId={callId} />);
    await openAndFill(user);

    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be submitted/i);
    expect(screen.getByRole("button", { name: "Submit report" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByText("Reported for administrator review.")).toBeInTheDocument();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodies[1]?.requestId).toBe(bodies[0]?.requestId);
  });

  it("uses a new request id when the report content changes", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: "Try again." }), { status: 503, headers: { "content-type": "application/json" } });
    }));
    const user = userEvent.setup();
    render(<AiOutputReport callId={callId} />);
    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await screen.findByRole("alert");
    await user.type(screen.getByLabelText(/What went wrong/), " More detail.");
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.requestId).not.toBe(bodies[0]?.requestId);
  });
});
