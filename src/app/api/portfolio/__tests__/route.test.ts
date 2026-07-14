import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), load: vi.fn(), update: vi.fn(), audit: vi.fn(), withRateLimit: vi.fn(),
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/portfolio/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/portfolio/service")>();
  return { ...original, loadOwnPublicPortfolioSettings: mocks.load, updatePublicPortfolio: mocks.update };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { GET, PATCH } from "../route";

const requestId = "d2000000-0000-4000-8000-000000000001";
const validBody = {
  requestId,
  expectedVersion: 0,
  slug: "learner-safe",
  displayName: "Safe Learner",
  headline: "Building verified programming projects",
  about: null,
  publish: true,
  confirmPublicDisclosure: true,
  selectedProjectIds: [],
  selectedAchievementIds: [],
  selectedCertificateIds: [],
};

function request(body: unknown) {
  return new NextRequest("https://learn.test/api/portfolio", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("public portfolio owner API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "learner-owner" } }, response: null });
    mocks.load.mockResolvedValue({ profile: { rowVersion: 0 }, projects: [], achievements: [], certificates: [] });
    mocks.update.mockResolvedValue({ rowVersion: 1, event: "published", replayed: false });
    mocks.audit.mockResolvedValue({ eventHash: "hash" });
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
  });

  it("loads settings only for the session owner", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith("learner-owner");
  });

  it("rejects a body owner override and binds every selection to the session owner", async () => {
    const denied = await PATCH(request({ ...validBody, userId: "victim" }));
    expect(denied.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();

    const accepted = await PATCH(request(validBody));
    expect(accepted.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ userId: "learner-owner", ...validBody });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({
      actorUserId: "learner-owner", subjectUserId: "learner-owner", action: "public_portfolio.published",
    }));
  });

  it("does not mutate when the per-user rate limit blocks the request", async () => {
    mocks.withRateLimit.mockResolvedValue(NextResponse.json({ code: "RATE_LIMITED" }, { status: 429 }));
    const response = await PATCH(request(validBody));
    expect(response.status).toBe(429);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "portfolio_mutation_user", identity: { kind: "user", value: "learner-owner" } },
      expect.any(Function),
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when the pre-mutation audit is unavailable", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await PATCH(request(validBody));
    expect(response.status).toBe(503);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns committed truth without inviting a retry when completion audit fails", async () => {
    mocks.audit.mockResolvedValueOnce({ eventHash: "pre" }).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await PATCH(request(validBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { event: "published", rowVersion: 1 },
      completionAuditRecorded: false,
      warning: expect.stringContaining("Do not repeat"),
    });
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("returns committed truth when the post-mutation settings refresh fails", async () => {
    mocks.load.mockRejectedValueOnce(new Error("read unavailable"));
    const response = await PATCH(request(validBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { event: "published", rowVersion: 1 },
      settings: null,
      warning: expect.stringContaining("refreshed private settings"),
    });
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("fails closed without a session", async () => {
    mocks.requireAuth.mockResolvedValue({ session: null, response: new Response("unauthorized", { status: 401 }) });
    expect((await PATCH(request(validBody))).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
