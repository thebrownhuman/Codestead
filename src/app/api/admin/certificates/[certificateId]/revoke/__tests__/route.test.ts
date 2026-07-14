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
    revoke: vi.fn(),
    audit: vi.fn(),
    authorize: vi.fn(),
    withRateLimit: vi.fn(),
  };
});
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorize }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/certificates/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/certificates/service")>();
  return { ...original, revokeCourseCertificate: mocks.revoke };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));

import { POST } from "../route";

const certificateId = "e1000000-0000-4000-8000-000000000001";
const requestId = "e2000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ certificateId }) };
function request(body: unknown) {
  return new NextRequest(`https://learn.test/api/admin/certificates/${certificateId}/revoke`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("administrator certificate revocation API", () => {
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
    mocks.revoke.mockResolvedValue({ certificateId, revokedAt: "2026-07-14T00:00:00.000Z", replayed: false });
    mocks.audit.mockResolvedValue({ eventHash: "hash" });
  });

  it("rejects a learner before mutation", async () => {
    mocks.requireAdmin.mockResolvedValue({ session: null, response: new Response("forbidden", { status: 403 }) });
    expect((await POST(request({ requestId, reason: "Verified integrity correction" }), context)).status).toBe(403);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("requires a reason before the privileged gate or mutation", async () => {
    expect((await POST(request({ requestId, reason: "short" }), context)).status).toBe(400);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("denies stale MFA, records the denial, and does not revoke", async () => {
    mocks.authorize.mockReturnValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request({ requestId, reason: "Verified integrity correction" }), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FRESH_MFA_REQUIRED" });
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "certificate.revoke", outcome: "denied", correlationId: requestId,
    }));
  });

  it("does not revoke when the rate limit blocks the request", async () => {
    mocks.withRateLimit.mockResolvedValue(NextResponse.json({ code: "RATE_LIMITED" }, { status: 429 }));
    const response = await POST(request({ requestId, reason: "Verified integrity correction" }), context);
    expect(response.status).toBe(429);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when the pre-mutation audit is unavailable", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request({ requestId, reason: "Verified integrity correction" }), context);
    expect(response.status).toBe(503);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("requires fresh MFA, revokes once, and records allowed and completed events", async () => {
    const response = await POST(request({ requestId, reason: "Verified integrity correction" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ completionAuditRecorded: true });

    expect(mocks.revoke).toHaveBeenCalledWith({
      actorUserId: "admin-1", certificateId, requestId, reason: "Verified integrity correction",
    });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "certificate.revoke", actorRole: "admin", reason: "Verified integrity correction",
    }));
    expect(mocks.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      actorUserId: "admin-1", action: "certificate.revoke", outcome: "allowed",
    }));
    expect(mocks.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      actorUserId: "admin-1", action: "certificate.revoke", reason: "Verified integrity correction",
    }));
  });

  it("returns success without inviting a duplicate revocation when completion audit fails", async () => {
    mocks.audit.mockResolvedValueOnce({ eventHash: "pre" }).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request({ requestId, reason: "Verified integrity correction" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      completionAuditRecorded: false,
      warning: expect.stringContaining("Do not repeat"),
    });
    expect(mocks.revoke).toHaveBeenCalledOnce();
  });
});
