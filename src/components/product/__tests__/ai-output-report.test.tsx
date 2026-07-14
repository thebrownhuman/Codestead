import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
