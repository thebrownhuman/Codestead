import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getInactivityPreference: vi.fn(),
  setInactivityPause: vi.fn(),
  authorizePrivilegedAction: vi.fn(),
  writeAuditEvent: vi.fn(),
  withRateLimit: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/notifications/preferences", () => ({
  NotificationPreferenceError: class NotificationPreferenceError extends Error {
    constructor(public readonly code: string, public readonly status: number) { super(code); }
  },
  getInactivityPreference: mocks.getInactivityPreference,
  setInactivityPause: mocks.setInactivityPause,
}));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorizePrivilegedAction }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));

import { GET, PATCH } from "../route";

const learnerId = "b1000000-0000-4000-8000-000000000001";
const validBody = {
  expectedVersion: 1,
  pausedUntil: "2026-07-20T12:00:00.000+00:00",
  reason: "Learner requested a short examination pause.",
};

function request(body: unknown) {
  return new NextRequest(`https://learn.example.test/api/admin/learners/${learnerId}/inactivity-preference`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(id = learnerId) {
  return { params: Promise.resolve({ learnerId: id }) };
}

describe("administrator inactivity preference endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-user" }, session: { id: "admin-session" } },
      account: { role: "admin" },
    });
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date() }]);
    mocks.where.mockReturnValue({ limit: mocks.limit });
    mocks.from.mockReturnValue({ where: mocks.where });
    mocks.select.mockReturnValue({ from: mocks.from });
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.writeAuditEvent.mockResolvedValue(undefined);
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
    mocks.getInactivityPreference.mockResolvedValue({ learnerId, rowVersion: 1 });
    mocks.setInactivityPause.mockResolvedValue({
      learnerId,
      quietHoursEnabled: true,
      quietStartMinute: 1_320,
      quietEndMinute: 480,
      inactivityPausedUntil: new Date(validBody.pausedUntil),
      rowVersion: 2,
    });
  });

  it("fails closed for a non-administrator", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await PATCH(request(validBody), context());
    expect(response.status).toBe(403);
    expect(mocks.setInactivityPause).not.toHaveBeenCalled();
  });

  it("rejects malformed identifiers and strict bodies before mutation", async () => {
    expect((await PATCH(request(validBody), context("not-a-uuid"))).status).toBe(400);
    expect((await PATCH(request({ ...validBody, unexpected: true }), context())).status).toBe(400);
    expect(mocks.setInactivityPause).not.toHaveBeenCalled();
  });

  it("requires fresh MFA and records a denied audit", async () => {
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await PATCH(request(validBody), context());
    expect(response.status).toBe(403);
    expect(mocks.authorizePrivilegedAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "notification.pause", actorRole: "admin", reason: validBody.reason,
    }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied", resourceId: learnerId }));
    expect(mocks.setInactivityPause).not.toHaveBeenCalled();
  });

  it("version-binds the mutation between pre-mutation and completion audits", async () => {
    const response = await PATCH(request(validBody), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ learnerId, rowVersion: 2, completionAuditRecorded: true });
    expect(mocks.setInactivityPause).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-user",
      learnerPublicId: learnerId,
      expectedVersion: 1,
      pausedUntil: new Date(validBody.pausedUntil),
      reason: validBody.reason,
    }));
    expect(mocks.writeAuditEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      outcome: "allowed", metadata: expect.objectContaining({ phase: "pre_mutation", expectedVersion: 1 }),
    }));
    expect(mocks.writeAuditEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      outcome: "success", metadata: expect.objectContaining({ resultingVersion: 2 }),
    }));
  });

  it("does not invite a duplicate mutation when completion-audit recording fails", async () => {
    mocks.writeAuditEvent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await PATCH(request(validBody), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ completionAuditRecorded: false, warning: expect.stringContaining("do not repeat") });
    expect(mocks.setInactivityPause).toHaveBeenCalledOnce();
  });

  it("loads defaults without requiring fresh MFA for a read", async () => {
    const response = await GET(request({}), context());
    expect(response.status).toBe(200);
    expect(mocks.getInactivityPreference).toHaveBeenCalledWith(learnerId);
    expect(mocks.authorizePrivilegedAction).not.toHaveBeenCalled();
  });
});
