import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    limit,
    select,
    requireAdmin: vi.fn(),
    mutate: vi.fn(),
    listCards: vi.fn(),
    listCourses: vi.fn(),
    audit: vi.fn(),
    authorize: vi.fn(),
    withRateLimit: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorize }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/career/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/career/service")>();
  return {
    ...original,
    mutateCareerCard: mocks.mutate,
    listCareerAdminCards: mocks.listCards,
    listCareerPrerequisiteCourses: mocks.listCourses,
  };
});

import { CareerGuidanceError } from "@/lib/career/service";
import { POST } from "../route";

const cardId = "ca000000-0000-4000-8000-000000000001";
const requestId = "ca000000-0000-4000-8000-000000000002";
const baseBody = {
  requestId,
  cardId,
  expectedVersion: 2,
  action: "publish" as const,
  slug: "spring-boot",
  path: "Backend development",
  technology: "Spring Boot",
  title: "Build production Spring Boot services",
  summary: "A reviewed route from Java fundamentals into production backend services.",
  futureScope: "Continue into distributed systems, observability, and independently deployed services.",
  prerequisites: [],
  market: null,
  reason: "Publish after independent editorial and prerequisite review.",
};

function request(body: unknown = baseBody) {
  return new NextRequest("https://learn.example.test/api/admin/career", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("administrator career guidance mutation endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "session-1" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date() }]);
    mocks.authorize.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
    mocks.audit.mockResolvedValue({ eventHash: "hash" });
    mocks.mutate.mockResolvedValue({ cardId, rowVersion: 3, event: "published", replayed: false });
    mocks.listCards.mockResolvedValue([{ id: cardId, status: "published" }]);
    mocks.listCourses.mockResolvedValue([]);
  });

  it("requires administrator authentication before parsing or mutation", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("does not mutate when the rate limit blocks the request", async () => {
    mocks.withRateLimit.mockResolvedValue(NextResponse.json({ code: "RATE_LIMITED" }, { status: 429 }));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ["publish", "career.publish"],
    ["retire", "career.retire"],
  ] as const)("requires fresh MFA for %s", async (action, privilegedAction) => {
    mocks.authorize.mockReturnValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request({ ...baseBody, action }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FRESH_MFA_REQUIRED" });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: privilegedAction }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("fails closed before publication when the pre-mutation audit is unavailable", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("publishes only after fresh MFA and a durable pre-mutation audit", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { cardId, rowVersion: 3, event: "published" },
      completionAuditRecorded: true,
    });
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1", requestId, cardId, action: "publish", reason: baseBody.reason,
    }));
    expect(mocks.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "career_card.publish", outcome: "allowed", correlationId: requestId,
      metadata: expect.objectContaining({ phase: "pre_mutation", expectedVersion: 2 }),
    }));
    expect(mocks.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "career_card.published", outcome: "success", correlationId: requestId,
    }));
  });

  it("retires published guidance only after its dedicated fresh-MFA gate", async () => {
    mocks.mutate.mockResolvedValueOnce({ cardId, rowVersion: 3, event: "retired", replayed: false });
    const response = await POST(request({ ...baseBody, action: "retire" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { cardId, rowVersion: 3, event: "retired" },
      completionAuditRecorded: true,
    });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "career.retire" }));
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: "retire" }));
    expect(mocks.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "career_card.retire", outcome: "allowed",
    }));
    expect(mocks.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "career_card.retired", outcome: "success",
    }));
  });

  it("does not allow save to implicitly withdraw a published card", async () => {
    mocks.mutate.mockRejectedValueOnce(new CareerGuidanceError("INVALID_STAGE_TRANSITION"));
    const response = await POST(request({ ...baseBody, action: "save" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "INVALID_STAGE_TRANSITION" });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ action: "save" }));
  });

  it("does not report a false failure or invite a duplicate when completion audit fails", async () => {
    mocks.audit.mockResolvedValueOnce({ eventHash: "pre" }).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      completionAuditRecorded: false,
      warning: expect.stringContaining("Do not repeat"),
    });
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  it("does not turn a committed publication into an error when the refreshed list is unavailable", async () => {
    mocks.listCards.mockRejectedValueOnce(new Error("read unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cards: null,
      warning: expect.stringContaining("refreshed card list"),
    });
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });
});
