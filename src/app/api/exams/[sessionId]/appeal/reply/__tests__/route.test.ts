import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  submitExamAppealReply: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/app/api/exams/_lib/service", () => ({
  submitExamAppealReply: mocks.submitExamAppealReply,
}));

import { POST } from "../route";

const sessionId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";

function request(body: unknown) {
  return new NextRequest(`https://learn.example.test/api/exams/${sessionId}/appeal/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("learner appeal reply endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-user" }, session: { id: "auth-session" } },
    });
    mocks.submitExamAppealReply.mockResolvedValue({
      accepted: true,
      duplicate: false,
      appealId: "30000000-0000-4000-8000-000000000001",
      rowVersion: 3,
    });
  });

  it("does not accept or parse a reply from an unauthenticated caller", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await POST(request({ clientRequestId: requestId, message: "A useful learner reply with enough context." }), { params: Promise.resolve({ sessionId }) });
    expect(response.status).toBe(401);
    expect(mocks.submitExamAppealReply).not.toHaveBeenCalled();
  });

  it.each([
    { clientRequestId: "not-a-uuid", message: "A useful learner reply with enough context." },
    { clientRequestId: requestId, message: "too short" },
    { clientRequestId: requestId, message: "A useful learner reply with enough context.", userId: "attacker" },
  ])("rejects invalid or target-injecting input", async (body) => {
    const response = await POST(request(body), { params: Promise.resolve({ sessionId }) });
    expect(response.status).toBe(400);
    expect(mocks.submitExamAppealReply).not.toHaveBeenCalled();
  });

  it("binds the authenticated learner and path session to the idempotent service call", async () => {
    const message = "Here is the additional evidence requested by the reviewer.";
    const response = await POST(request({ clientRequestId: requestId, message }), { params: Promise.resolve({ sessionId }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, rowVersion: 3 });
    expect(mocks.submitExamAppealReply).toHaveBeenCalledWith({
      userId: "learner-user",
      sessionId,
      clientRequestId: requestId,
      message,
    });
  });
});
