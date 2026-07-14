import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/learning-service/runtime", () => ({
  learningService: { startSession: mocks.startSession },
}));

import { POST } from "../route";

function request(body: unknown) {
  return new Request("https://learn.example.test/api/learning/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const base = {
  idempotencyKey: "session-request-0001",
  goal: "Complete the reviewed foundations journey",
  plannedMinutes: 25,
};

describe("learning session start endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-user" }, session: { id: "auth-session" } },
    });
    mocks.startSession.mockResolvedValue({
      session: { id: "10000000-0000-4000-8000-000000000001", reviewOnly: false },
    });
  });

  it("does not parse a session choice for an unauthenticated caller", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await POST(request({ ...base, reviewOnly: true }));
    expect(response.status).toBe(401);
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("defaults normal sessions to reviewOnly false regardless of goal wording", async () => {
    const response = await POST(request(base));
    expect(response.status).toBe(201);
    expect(mocks.startSession).toHaveBeenCalledWith({
      userId: "learner-user",
      ...base,
      reviewOnly: false,
    });
  });

  it("passes an explicit review-only choice and rejects coercion", async () => {
    await expect(POST(request({ ...base, reviewOnly: true }))).resolves.toMatchObject({ status: 201 });
    expect(mocks.startSession).toHaveBeenLastCalledWith({
      userId: "learner-user",
      ...base,
      reviewOnly: true,
    });
    const invalid = await POST(request({ ...base, reviewOnly: "true" }));
    expect(invalid.status).toBe(400);
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
  });
});
