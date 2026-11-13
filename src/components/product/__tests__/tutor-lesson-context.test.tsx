import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TutorView } from "../tutor-view";

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    const body = url === "/api/credentials" ? { credentials: [] }
      : url === "/api/ai/tutor" ? { content: "Answer", threadId: "thread-1" }
      : { threads: [], nextCursor: null };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function sendMessage(fetchMock: ReturnType<typeof stubFetch>) {
  const input = await screen.findByRole("textbox", { name: "Message Codestead" });
  fireEvent.change(input, { target: { value: "Explain this" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/ai/tutor")).toBe(true));
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/ai/tutor")!;
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

describe("TutorView lesson context", () => {
  it("sends the learner's real course and skill and names it in the welcome", async () => {
    const fetchMock = stubFetch();
    render(<TutorView lesson={{ courseId: "java", skillId: "java.loops.for", title: "Java for loops" }} />);
    expect(screen.getByText(/working on Java for loops/)).toBeInTheDocument();
    expect(screen.queryByText(/Python scalar values/)).not.toBeInTheDocument();
    const body = await sendMessage(fetchMock);
    expect(body.courseId).toBe("java");
    expect(body.skillId).toBe("java.loops.for");
  });

  it("sends no lesson context and makes no skill claim when none is known", async () => {
    const fetchMock = stubFetch();
    render(<TutorView />);
    expect(screen.queryByText(/Python scalar values/)).not.toBeInTheDocument();
    const body = await sendMessage(fetchMock);
    expect(body).not.toHaveProperty("courseId");
    expect(body).not.toHaveProperty("skillId");
  });
});
