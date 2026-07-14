import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  listOwnedChatThreads: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/ai/chat-lifecycle", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/chat-lifecycle")>();
  return { ...original, listOwnedChatThreads: mocks.listOwnedChatThreads };
});

import { ChatThreadLifecycleError } from "@/lib/ai/chat-lifecycle";
import { GET } from "../route";

function request(query = "") {
  return new NextRequest(`https://learn.test/api/ai/threads${query}`);
}

describe("owned tutor thread list API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" } },
      response: null,
    });
    mocks.listOwnedChatThreads.mockResolvedValue({ threads: [], nextCursor: null });
  });

  it("returns the authorization response without accessing thread history", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.listOwnedChatThreads).not.toHaveBeenCalled();
  });

  it("derives ownership from the session and returns only no-store JSON", async () => {
    mocks.listOwnedChatThreads.mockResolvedValueOnce({
      threads: [{ id: "10000000-0000-4000-8000-000000000001", status: "active" }],
      nextCursor: "next",
    });
    const response = await GET(request("?limit=10&includeArchived=true&cursor=opaque"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.requireAuth).toHaveBeenCalledWith({ closedBookCapability: "ai_tutor" });
    expect(mocks.listOwnedChatThreads).toHaveBeenCalledWith({
      userId: "learner-1",
      limit: 10,
      includeArchived: true,
      cursor: "opaque",
    });
  });

  it("rejects duplicate/unknown query fields and maps cursor failures without leaking internals", async () => {
    const malformed = await GET(request("?limit=2&extra=true"));
    expect(malformed.status).toBe(400);
    expect(mocks.listOwnedChatThreads).not.toHaveBeenCalled();

    mocks.listOwnedChatThreads.mockRejectedValueOnce(new ChatThreadLifecycleError("INVALID_CURSOR"));
    const invalidCursor = await GET(request("?cursor=forged"));
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("fails closed with a generic response when storage is unavailable", async () => {
    mocks.listOwnedChatThreads.mockRejectedValueOnce(new Error("postgres password should never escape"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("password");
  });
});
