import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/career/service", () => ({ listLearnerCareerRecommendations: mocks.list }));

import { GET } from "../route";

describe("career recommendation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } }, response: null });
    mocks.list.mockResolvedValue({ available: false, recommendations: [] });
  });

  it("uses only the authenticated learner's verified evidence", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.list).toHaveBeenCalledWith("learner-1");
  });

  it("fails closed without a learner session", async () => {
    mocks.requireAuth.mockResolvedValue({ session: null, response: new Response("unauthorized", { status: 401 }) });
    expect((await GET()).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
