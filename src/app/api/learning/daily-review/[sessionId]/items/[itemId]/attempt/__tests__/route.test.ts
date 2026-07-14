import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  startItem: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/daily-review/runtime", () => ({ dailyReviewService: { startItem: mocks.startItem } }));

import { POST } from "../route";

const sessionId = "10000000-0000-4000-8000-000000000001";
const itemId = "20000000-0000-4000-8000-000000000001";

function call(params = { sessionId, itemId }) {
  return POST(new Request("https://learn.test/api/learning/daily-review/item", { method: "POST" }), {
    params: Promise.resolve(params),
  });
}

describe("daily review item attempt route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } } });
    mocks.startItem.mockResolvedValue({ state: "degraded", attempt: null, activity: null, idempotent: true, reason: "activity_unavailable" });
  });

  it("binds session and item ownership to the authenticated learner", async () => {
    const response = await call();
    expect(response.status).toBe(201);
    expect(mocks.startItem).toHaveBeenCalledWith("learner-1", sessionId, itemId);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects malformed identifiers before calling the service", async () => {
    const response = await call({ sessionId: "other-user", itemId });
    expect(response.status).toBe(400);
    expect(mocks.startItem).not.toHaveBeenCalled();
  });

  it("does not parse identifiers when authentication fails", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const response = await call({ sessionId: "bad", itemId: "bad" });
    expect(response.status).toBe(401);
    expect(mocks.startItem).not.toHaveBeenCalled();
  });
});
