import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LearningRequestsView } from "../learning-requests-view";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const existingRequest = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "topic-extension",
  subject: "Advanced Python typing",
  details: "Protocols, generics, and practical static analysis boundaries.",
  status: "pending",
  decisionReason: null,
  createdAt: "2026-07-13T10:00:00.000Z",
  decidedAt: null,
};

async function completeForm(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Request type"), "new-subject");
  await user.type(screen.getByLabelText("Subject or topic"), "  Distributed systems  ");
  await user.type(screen.getByLabelText("What should the course cover?"), "  Consensus, failure models, and an evidence-based project.  ");
}

describe("learner curriculum request view", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a validated semantic request list with clear status and details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ requests: [existingRequest] }));
    vi.stubGlobal("fetch", fetchMock);

    render(<LearningRequestsView />);

    expect(screen.getByText("Loading requests…")).toBeInTheDocument();
    expect(await screen.findByText(existingRequest.subject)).toBeInTheDocument();
    expect(screen.getByText(existingRequest.details)).toBeInTheDocument();
    expect(screen.getByText("pending", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent(existingRequest.subject);
    expect(screen.getAllByText("Required")).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/learning-requests",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ["non-JSON", () => new Response("<html>upstream failure</html>", { status: 200 })],
    ["an invalid requests shape", () => json({ requests: { subject: "not-an-array" } })],
    ["an invalid request record", () => json({ requests: [{ ...existingRequest, createdAt: "not-a-date" }] })],
  ])("shows one stable recoverable error for %s GET data", async (_name, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    render(<LearningRequestsView />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your requests could not be read safely. Try again.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.queryByText("No requests yet")).not.toBeInTheDocument();
  });

  it("uses the POST result optimistically and releases the form before refresh completes", async () => {
    let resolveRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
    let getCount = 0;
    const created = {
      ...existingRequest,
      id: "10000000-0000-4000-8000-000000000002",
      kind: "new-subject",
      subject: "Distributed systems",
      details: "Consensus, failure models, and an evidence-based project.",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
      });
      if (method === "POST") return json({ request: created }, { status: 201 });
      getCount += 1;
      return getCount === 1 ? json({ requests: [] }) : refresh;
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<LearningRequestsView />);
    await screen.findByText("No requests yet");
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Send for review" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Request sent to the administrator");
    expect(screen.getByText(created.subject)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send for review" })).toBeEnabled();
    expect(screen.getByText("Refreshing requests…")).toBeInTheDocument();
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      kind: "new-subject",
      subject: "Distributed systems",
      details: "Consensus, failure models, and an evidence-based project.",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });

    resolveRefresh(new Response("not json", { status: 200 }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "saved request remains shown below",
    );
    expect(screen.getByText(created.subject)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it.each([
    [400, "Choose a request type and provide a clear subject and description."],
    [429, "Too many requests. Please wait before trying again."],
  ])("recovers from a POST %s without clearing or disabling the form", async (status, message) => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ error: message }, { status });
      }
      return json({ requests: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<LearningRequestsView />);
    await screen.findByText("No requests yet");
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Send for review" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Send for review" })).toBeEnabled();
    expect(screen.getByLabelText("Subject or topic")).toHaveValue("  Distributed systems  ");
    expect(bodies[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(screen.queryByText(existingRequest.subject)).not.toBeInTheDocument();
  });

  it("reuses the same request id after response loss and renders the replay once", async () => {
    const requestIds: string[] = [];
    let postCount = 0;
    const replay = {
      ...existingRequest,
      id: "10000000-0000-4000-8000-000000000003",
      kind: "new-subject",
      subject: "Distributed systems",
      details: "Consensus, failure models, and an evidence-based project.",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCount += 1;
        const body = JSON.parse(String(init.body)) as { requestId: string };
        requestIds.push(body.requestId);
        if (postCount === 1) throw new TypeError("response lost after commit");
        return json({ request: replay, replayed: true }, { status: 200 });
      }
      return json({ requests: postCount > 1 ? [replay] : [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<LearningRequestsView />);
    await screen.findByText("No requests yet");
    await completeForm(user);
    await user.click(screen.getByRole("button", { name: "Send for review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send for review" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Send for review" }));
    expect(await screen.findByText(replay.subject)).toBeInTheDocument();
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(screen.getAllByText(replay.subject)).toHaveLength(1);
  });
});
