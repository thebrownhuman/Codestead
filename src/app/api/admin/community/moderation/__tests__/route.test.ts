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
    moderate: vi.fn(),
    listReports: vi.fn(),
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
vi.mock("@/lib/community/service", () => ({
  CommunityError: class CommunityError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  listCommunityReports: mocks.listReports,
  moderateCommunityContent: mocks.moderate,
}));

import { POST } from "../route";

const targetId = "cc000000-0000-4000-8000-000000000001";
const body = {
  requestId: "cc000000-0000-4000-8000-000000000002",
  reportId: null,
  target: "post" as const,
  targetId,
  action: "delete" as const,
  reason: "Remove content after confirmed privacy and safety review.",
};

function request(value: unknown = body) {
  return new NextRequest("https://learn.example.test/api/admin/community/moderation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("administrator community moderation endpoint", () => {
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
    mocks.moderate.mockResolvedValue({ priorState: "active", resultingState: "deleted" });
    mocks.listReports.mockResolvedValue([]);
  });

  it("requires administrator authentication before rate limiting or mutation", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.moderate).not.toHaveBeenCalled();
  });

  it("does not delete when the rate limit blocks the request", async () => {
    mocks.withRateLimit.mockResolvedValue(NextResponse.json({ code: "RATE_LIMITED" }, { status: 429 }));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.moderate).not.toHaveBeenCalled();
  });

  it("denies stale MFA, audits the denial, and leaves content unchanged", async () => {
    mocks.authorize.mockReturnValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FRESH_MFA_REQUIRED" });
    expect(mocks.moderate).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "community.moderate.delete", outcome: "denied", resourceId: targetId,
    }));
  });

  it("fails closed before deletion when the pre-mutation audit is unavailable", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.moderate).not.toHaveBeenCalled();
  });

  it("deletes only after fresh MFA and records allowed and completed events", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      report: { priorState: "active", resultingState: "deleted" },
      completionAuditRecorded: true,
    });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      actorRole: "admin", action: "community.moderate.delete", reason: body.reason,
    }));
    expect(mocks.moderate).toHaveBeenCalledWith({ actorUserId: "admin-1", ...body });
    expect(mocks.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "community.moderate.delete", outcome: "allowed",
      metadata: expect.objectContaining({ phase: "pre_mutation" }),
    }));
    expect(mocks.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "community.moderate.delete", outcome: "success",
    }));
  });

  it("does not report a false failure or invite a duplicate when completion audit fails", async () => {
    mocks.audit.mockResolvedValueOnce({ eventHash: "pre" }).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      completionAuditRecorded: false,
      warning: expect.stringContaining("Do not repeat"),
    });
    expect(mocks.moderate).toHaveBeenCalledOnce();
  });

  it("keeps reversible hide moderation available without a fresh-MFA query", async () => {
    mocks.moderate.mockResolvedValue({ priorState: "active", resultingState: "hidden" });
    const response = await POST(request({ ...body, action: "hide" }));
    expect(response.status).toBe(200);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.moderate).toHaveBeenCalledWith(expect.objectContaining({ action: "hide" }));
  });
});
