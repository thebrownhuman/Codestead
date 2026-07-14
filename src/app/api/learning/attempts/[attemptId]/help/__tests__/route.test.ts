import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), revealNextPracticeHelp: vi.fn() }));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/learning-service/runtime", () => ({
  learningService: { revealNextPracticeHelp: mocks.revealNextPracticeHelp },
}));

import { POST } from "../route";

const ATTEMPT_ID = "50000000-0000-4000-8000-000000000001";
const REQUEST_ID = "60000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({
    session: { user: { id: "learner-1" }, session: { id: "session-1" } },
    response: null,
  });
});

function request(body: unknown) {
  return new Request(`https://learn.test/api/learning/attempts/${ATTEMPT_ID}/help`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("owner-bound practice help route", () => {
  it("requires authentication", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const response = await POST(request({ requestId: REQUEST_ID }), { params: Promise.resolve({ attemptId: ATTEMPT_ID }) });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("derives the owner from the authenticated session and returns only the persisted next step", async () => {
    mocks.revealNextPracticeHelp.mockResolvedValue({
      state: "ready",
      attemptId: ATTEMPT_ID,
      helpStep: 1,
      assistanceLevel: "A1",
      solutionRevealed: false,
      help: { kind: "hint", content: "One persisted hint.", answer: null },
      requiresFreshAttempt: false,
      idempotent: false,
    });
    const response = await POST(request({ requestId: REQUEST_ID }), { params: Promise.resolve({ attemptId: ATTEMPT_ID }) });
    expect(response.status).toBe(200);
    expect(mocks.revealNextPracticeHelp).toHaveBeenCalledWith({
      userId: "learner-1",
      attemptId: ATTEMPT_ID,
      requestId: REQUEST_ID,
    });
    expect(await response.json()).toMatchObject({ helpStep: 1, help: { content: "One persisted hint." } });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects malformed ids before calling the service", async () => {
    expect((await POST(request({ requestId: "bad" }), { params: Promise.resolve({ attemptId: ATTEMPT_ID }) })).status).toBe(400);
    expect((await POST(request({ requestId: REQUEST_ID }), { params: Promise.resolve({ attemptId: "bad" }) })).status).toBe(400);
    expect(mocks.revealNextPracticeHelp).not.toHaveBeenCalled();
  });
});
