import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  get: vi.fn(),
  initialize: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/daily-review/runtime", () => ({
  dailyReviewService: { get: mocks.get, initialize: mocks.initialize },
}));

import { GET, POST } from "../route";

const notStarted = {
  state: "not_started",
  localDate: "2026-07-13",
  timezone: "Asia/Kolkata",
  session: null,
} as const;

describe("daily review route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } } });
    mocks.get.mockResolvedValue(notStarted);
    mocks.initialize.mockResolvedValue({
      ...notStarted,
      state: "unavailable",
      session: {
        id: "10000000-0000-4000-8000-000000000001",
        localDate: notStarted.localDate,
        timezone: notStarted.timezone,
        status: "unavailable",
        availableItemCount: 3,
        questionCount: 0,
        completedCount: 0,
        items: [],
      },
    });
  });

  it("keeps learner state private and binds reads to the authenticated owner", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.get).toHaveBeenCalledWith("learner-1");
    expect(await response.json()).toEqual(notStarted);
  });

  it("initializes idempotently without accepting a client-selected learner or date", async () => {
    const response = await POST();
    expect(response.status).toBe(201);
    expect(mocks.initialize).toHaveBeenCalledWith("learner-1");
    expect(await response.json()).toMatchObject({ state: "unavailable", session: { availableItemCount: 3, items: [] } });
  });

  it("does not touch daily state when authentication fails", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
