import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
  decode: vi.fn(),
  rateLimit: vi.fn(async (_input: unknown, callback: () => Promise<Response>) => callback()),
}));

vi.mock("@/lib/http/authz", () => ({
  requireAuth: vi.fn(async () => ({ session: { user: { id: "learner-1" } }, response: NextResponse.json({ error: "AUTH" }, { status: 401 }) })),
}));
vi.mock("@/lib/notifications/center", () => ({
  decodeNotificationCursor: mocks.decode,
  listNotifications: mocks.list,
  setNotificationsRead: mocks.update,
}));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.rateLimit }));

import { GET, PATCH } from "../route";

describe("notification center route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decode.mockReturnValue(null);
    mocks.list.mockResolvedValue({ notifications: [], unreadCount: 0, nextCursor: null });
    mocks.update.mockResolvedValue({ updated: 1 });
  });

  it("lists only through the owner-bound service and validates limits", async () => {
    const response = await GET(new NextRequest("https://learn.test/api/notifications?limit=20"));
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ userId: "learner-1", cursor: null, limit: 20 });
    expect(response.headers.get("cache-control")).toContain("no-store");

    const invalid = await GET(new NextRequest("https://learn.test/api/notifications?limit=500"));
    expect(invalid.status).toBe(400);
  });

  it("rejects malformed cursors before reading data", async () => {
    const response = await GET(new NextRequest("https://learn.test/api/notifications?cursor=bad"));
    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("marks only bounded notification IDs for the authenticated owner", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const response = await PATCH(new NextRequest("https://learn.test/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id], read: true }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ userId: "learner-1", ids: [id], read: true });
  });

  it("rejects an unscoped update", async () => {
    const response = await PATCH(new NextRequest("https://learn.test/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [], read: true }),
    }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
