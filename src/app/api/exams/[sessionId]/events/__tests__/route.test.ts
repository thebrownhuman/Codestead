import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), recordExamEvent: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  withRateLimit: (_check: unknown, handler: () => Promise<Response>) => handler(),
}));
vi.mock("@/app/api/exams/_lib/service", () => {
  class ExamServiceError extends Error {
    constructor(message: string, readonly status: number, readonly code: string, readonly details = {}) {
      super(message);
    }
  }
  return { ExamServiceError, recordExamEvent: mocks.recordExamEvent };
});

import { CLIENT_EXAM_EVENT_TYPES } from "@/lib/exams/contracts";
import { POST } from "../route";

const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const EVENT_ID = "31000000-0000-4000-8000-000000000001";
const validBody = { clientEventId: EVENT_ID, type: "window_blur", metadata: { target: "window" } };

function invoke(body: unknown) {
  return POST(new NextRequest(`https://learn.example.test/api/exams/${SESSION_ID}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ sessionId: SESSION_ID }) });
}

describe("exam integrity events endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "authenticated-learner" } } });
    mocks.recordExamEvent.mockResolvedValue({ accepted: true, duplicate: false });
  });

  it.each([
    "blocked-capability:ai_tutor:29640000",
    `execution:${EVENT_ID}`,
    "server-disconnect:1783857600000:1783857660000",
    "runner-failure:item-1:1",
    "runner-capacity:item-1:1",
    `appeal:${EVENT_ID}`,
    "event-focus-00000001",
  ])("rejects a client attempt to reserve integrity event ID %s", async (clientEventId) => {
    const response = await invoke({ ...validBody, clientEventId });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Integrity event is invalid.", code: "INVALID_EXAM_EVENT" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.recordExamEvent).not.toHaveBeenCalled();
  });

  it.each(CLIENT_EXAM_EVENT_TYPES)("keeps UUID client event type %s accepted and owner-scoped", async (type) => {
    const response = await invoke({ ...validBody, type, userId: "forged-owner" });

    expect(response.status).toBe(200);
    expect(mocks.recordExamEvent).toHaveBeenCalledWith({
      userId: "authenticated-learner", sessionId: SESSION_ID, ...validBody, type,
    });
  });

  it("preserves the duplicate receipt for a retried UUID event", async () => {
    mocks.recordExamEvent.mockResolvedValue({ accepted: true, duplicate: true });
    const response = await invoke(validBody);
    expect(await response.json()).toEqual({ accepted: true, duplicate: true });
  });

  it.each([
    { ...validBody, type: "blocked_capability_attempt" },
    { ...validBody, metadata: { text: "x".repeat(4_097) } },
  ])("keeps server event types and oversized metadata rejected", async (body) => {
    const response = await invoke(body);
    expect(response.status).toBe(400);
    expect(mocks.recordExamEvent).not.toHaveBeenCalled();
  });

  it("requires authentication before accepting an event", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null, response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await invoke(validBody);
    expect(response.status).toBe(401);
    expect(mocks.recordExamEvent).not.toHaveBeenCalled();
  });
});
