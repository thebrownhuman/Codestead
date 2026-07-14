import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AdminPlanServiceError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  }
  return {
    AdminPlanServiceError,
    requireAdmin: vi.fn(),
    listLearnerPlanHistory: vi.fn(),
    getLearnerPlanDetail: vi.fn(),
  };
});

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-plan/service", () => ({
  AdminPlanServiceError: mocks.AdminPlanServiceError,
  adminPlanHttpStatus: (error: unknown) => error instanceof mocks.AdminPlanServiceError ? 404 : 500,
  listLearnerPlanHistory: mocks.listLearnerPlanHistory,
  getLearnerPlanDetail: mocks.getLearnerPlanDetail,
}));

import { GET as listPlans } from "../route";
import { GET as planDetail } from "../[enrollmentId]/route";

const learnerId = "10000000-0000-4000-8000-000000000001";
const enrollmentId = "20000000-0000-4000-8000-000000000001";

describe("administrator learning-plan read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" } }, account: { role: "admin" }, response: null,
    });
    mocks.listLearnerPlanHistory.mockResolvedValue({ learner: { publicId: learnerId }, enrollments: [] });
    mocks.getLearnerPlanDetail.mockResolvedValue({
      enrollment: { id: enrollmentId }, latestRevision: 3, selected: { revision: 3, plan: [] }, history: [],
    });
  });

  it("requires admin authentication and validates the public learner id", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const unauthorized = await listPlans(new Request("https://learn.test"), {
      params: Promise.resolve({ learnerId }),
    });
    expect(unauthorized.status).toBe(403);
    const invalid = await listPlans(new Request("https://learn.test"), {
      params: Promise.resolve({ learnerId: "internal-user-id" }),
    });
    expect(invalid.status).toBe(400);
    expect(mocks.listLearnerPlanHistory).not.toHaveBeenCalled();
  });

  it("returns only history bound to the learner public id with no-store caching", async () => {
    const response = await listPlans(new Request("https://learn.test"), {
      params: Promise.resolve({ learnerId }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.listLearnerPlanHistory).toHaveBeenCalledWith(learnerId);
  });

  it("binds detail and historical revision lookup to both path identifiers", async () => {
    const response = await planDetail(
      new NextRequest("https://learn.test/api/admin/plans?revision=2"),
      { params: Promise.resolve({ learnerId, enrollmentId }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.getLearnerPlanDetail).toHaveBeenCalledWith({
      learnerPublicId: learnerId,
      enrollmentId,
      revision: 2,
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects invalid detail identifiers and revision selectors", async () => {
    const badId = await planDetail(
      new NextRequest("https://learn.test/api/admin/plans"),
      { params: Promise.resolve({ learnerId, enrollmentId: "wrong" }) },
    );
    expect(badId.status).toBe(400);
    const badRevision = await planDetail(
      new NextRequest("https://learn.test/api/admin/plans?revision=0"),
      { params: Promise.resolve({ learnerId, enrollmentId }) },
    );
    expect(badRevision.status).toBe(400);
    expect(mocks.getLearnerPlanDetail).not.toHaveBeenCalled();
  });

  it("maps expected not-found errors and hides unexpected database details", async () => {
    mocks.getLearnerPlanDetail.mockRejectedValueOnce(
      new mocks.AdminPlanServiceError("REVISION_NOT_FOUND", "The requested revision was not found."),
    );
    const missing = await planDetail(
      new NextRequest("https://learn.test/api/admin/plans?revision=9"),
      { params: Promise.resolve({ learnerId, enrollmentId }) },
    );
    expect(missing.status).toBe(404);
    mocks.getLearnerPlanDetail.mockRejectedValueOnce(new Error("database password exposed"));
    const unexpected = await planDetail(
      new NextRequest("https://learn.test/api/admin/plans"),
      { params: Promise.resolve({ learnerId, enrollmentId }) },
    );
    expect(unexpected.status).toBe(500);
    expect(await unexpected.text()).not.toContain("password exposed");
  });
});
