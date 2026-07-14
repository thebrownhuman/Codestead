import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  loadOwn: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/social/profile-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/social/profile-service")>();
  return { ...original, loadOwnCohortSettings: mocks.loadOwn, updateCohortProfile: mocks.update };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: vi.fn(async (_input, handler: () => Promise<Response>) => handler()) }));

import { GET, PATCH } from "../route";

const settings = {
  consent: { cohortProfile: true, leaderboard: false },
  live: false,
  profile: { alias: "learner-safe", bio: "", isPublished: false, showBio: false, showStreak: false, showMasterySummary: false, rowVersion: 0 },
  badges: [], projects: [], availableAggregates: { streak: 0, masteredConcepts: 0 }, livePreview: null,
};

function request(body: unknown) {
  return new NextRequest("https://learn.test/api/community/profile", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("cohort profile API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-1" } }, response: null });
    mocks.loadOwn.mockResolvedValue(settings);
    mocks.update.mockResolvedValue({ rowVersion: 1, replayed: false, event: "published" });
    mocks.audit.mockResolvedValue({ eventHash: "hash" });
  });

  it("returns only the authenticated learner settings with no-store headers", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ settings });
    expect(mocks.loadOwn).toHaveBeenCalledWith("learner-1");
  });

  it("rejects malformed aliases and cross-owner-shaped identifiers before mutation", async () => {
    const response = await PATCH(request({ requestId: "bad", expectedVersion: 0, alias: "x", publish: true }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("records an audited explicit publication without accepting hidden fields", async () => {
    const body = {
      requestId: "b1000000-0000-4000-8000-000000000001", expectedVersion: 0,
      alias: "learner-safe", bio: null, showBio: false, showStreak: false,
      showMasterySummary: false, publish: true, selectedAchievementIds: [], selectedProjectIds: [],
    };
    const response = await PATCH(request(body));
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ actorUserId: "learner-1", ...body });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "learner-1", subjectUserId: "learner-1", action: "cohort_profile.published", outcome: "success",
    }));
    expect(JSON.stringify(await response.json())).not.toMatch(/email|score|code|chat|provider|session/i);
  });
});
