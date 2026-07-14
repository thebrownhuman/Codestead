import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/achievements/trophy-cabinet", () => ({ listOwnTrophyCabinet: mocks.list }));

import { GET } from "../route";

describe("trophy route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } }, response: null });
    mocks.list.mockResolvedValue({ summary: { earned: 1, revoked: 0, shared: 0 }, trophies: [] });
  });

  it("projects only the authenticated learner cabinet", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("learner-1");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("fails before evidence access without a session", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await GET()).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
