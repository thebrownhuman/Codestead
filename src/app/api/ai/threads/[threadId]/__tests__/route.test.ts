import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  withRateLimit: vi.fn(),
  readOwnedChatThread: vi.fn(),
  setOwnedChatThreadStatus: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/ai/chat-lifecycle", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/chat-lifecycle")>();
  return {
    ...original,
    readOwnedChatThread: mocks.readOwnedChatThread,
    setOwnedChatThreadStatus: mocks.setOwnedChatThreadStatus,
  };
});

import { ChatThreadLifecycleError } from "@/lib/ai/chat-lifecycle";
import { GET, PATCH } from "../route";

const THREAD = "10000000-0000-4000-8000-000000000001";
const UPDATED = "2026-07-12T09:00:00.000Z";
const context = (threadId = THREAD) => ({ params: Promise.resolve({ threadId }) });
const getRequest = (query = "") => new NextRequest(`https://learn.test/api/ai/threads/${THREAD}${query}`);
const patchRequest = (body: unknown) => new NextRequest(`https://learn.test/api/ai/threads/${THREAD}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("owned tutor thread detail API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } }, response: null });
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
    mocks.readOwnedChatThread.mockResolvedValue({
      thread: { id: THREAD, title: "Loop help", status: "active", createdAt: UPDATED, updatedAt: UPDATED },
      messages: [],
      nextCursor: null,
    });
    mocks.setOwnedChatThreadStatus.mockResolvedValue({ status: "archived", updatedAt: UPDATED, replayed: false });
  });

  it("returns the auth response before resolving path data", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(401);
    expect(mocks.readOwnedChatThread).not.toHaveBeenCalled();
  });

  it("binds reads to the session owner with bounded pagination and no-store headers", async () => {
    const response = await GET(getRequest("?limit=25&cursor=opaque"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.readOwnedChatThread).toHaveBeenCalledWith({
      userId: "learner-1",
      threadId: THREAD,
      limit: 25,
      cursor: "opaque",
    });
  });

  it("does not distinguish another owner's UUID from a missing thread", async () => {
    mocks.readOwnedChatThread.mockRejectedValueOnce(new ChatThreadLifecycleError("NOT_FOUND"));
    const response = await GET(getRequest(), context());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Tutor thread not found." });
  });

  it("rejects malformed identifiers and queries before reading storage", async () => {
    expect((await GET(getRequest(), context("not-a-uuid"))).status).toBe(400);
    expect((await GET(getRequest("?unknown=true"), context())).status).toBe(400);
    expect(mocks.readOwnedChatThread).not.toHaveBeenCalled();
  });

  it("rate-limits archive/reopen and passes the session owner plus optimistic version", async () => {
    const response = await PATCH(patchRequest({ status: "archived", expectedUpdatedAt: UPDATED }), context());
    expect(response.status).toBe(200);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "learning_request_user", identity: { kind: "user", value: "learner-1" } },
      expect.any(Function),
    );
    expect(mocks.setOwnedChatThreadStatus).toHaveBeenCalledWith({
      userId: "learner-1",
      threadId: THREAD,
      status: "archived",
      expectedUpdatedAt: UPDATED,
    });
  });

  it("returns the authoritative current state on a concurrent mutation conflict", async () => {
    mocks.setOwnedChatThreadStatus.mockRejectedValueOnce(new ChatThreadLifecycleError("VERSION_CONFLICT", {
      status: "archived",
      updatedAt: "2026-07-12T10:00:00.000Z",
    }));
    const response = await PATCH(patchRequest({ status: "active", expectedUpdatedAt: UPDATED }), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      current: { status: "archived", updatedAt: "2026-07-12T10:00:00.000Z" },
    });
  });

  it("rejects malformed bodies without invoking a status mutation", async () => {
    const response = await PATCH(patchRequest({ status: "deleted", expectedUpdatedAt: UPDATED, extra: true }), context());
    expect(response.status).toBe(400);
    expect(mocks.setOwnedChatThreadStatus).not.toHaveBeenCalled();
  });
});
