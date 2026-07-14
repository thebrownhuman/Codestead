import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAppealSubject: vi.fn(),
  decideAppeal: vi.fn(),
  authorizePrivilegedAction: vi.fn(),
  writeAuditEvent: vi.fn(),
  withRateLimit: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/appeals/admin-service", () => ({
  AppealAdminError: class AppealAdminError extends Error {
    constructor(public readonly code: string) { super(code); }
  },
  getAppealSubject: mocks.getAppealSubject,
  decideAppeal: mocks.decideAppeal,
}));
vi.mock("@/lib/security/privileged-access", () => ({
  authorizePrivilegedAction: mocks.authorizePrivilegedAction,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));

import { POST } from "../route";

const appealId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";

function request(body: unknown) {
  return new NextRequest(`https://learn.example.test/api/admin/appeals/${appealId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(id = appealId) {
  return { params: Promise.resolve({ appealId: id }) };
}

const validBody = {
  requestId,
  expectedVersion: 1,
  decision: "upheld",
  reason: "The immutable evidence supports the original assessment result.",
} as const;

describe("administrator appeal decision endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-user" }, session: { id: "admin-session" } },
      account: { role: "admin" },
    });
    mocks.getAppealSubject.mockResolvedValue({ id: appealId, user_id: "learner-user", status: "open" });
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date() }]);
    mocks.where.mockReturnValue({ limit: mocks.limit });
    mocks.from.mockReturnValue({ where: mocks.where });
    mocks.select.mockReturnValue({ from: mocks.from });
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.writeAuditEvent.mockResolvedValue(undefined);
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
    mocks.decideAppeal.mockResolvedValue({
      appealId,
      userId: "learner-user",
      decision: "upheld",
      status: "upheld",
      rowVersion: 2,
      decidedAt: "2026-07-12T00:00:00.000Z",
      examSessionId: "30000000-0000-4000-8000-000000000001",
      correctionPending: false,
      projectReviewCorrectionId: null,
      projectReviewCorrectionStatus: null,
      projectReviewCorrectionRevision: null,
      replayed: false,
    });
  });

  it("fails closed before rate limiting or loading evidence for a non-administrator", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request(validBody), context());
    expect(response.status).toBe(403);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.getAppealSubject).not.toHaveBeenCalled();
  });

  it("rejects malformed ids and strict bodies without performing a mutation", async () => {
    const invalidId = await POST(request(validBody), context("not-an-id"));
    expect(invalidId.status).toBe(404);
    const injected = await POST(request({ ...validBody, appealId: "attacker-selected-target" }), context());
    expect(injected.status).toBe(400);
    expect(mocks.getAppealSubject).not.toHaveBeenCalled();
    expect(mocks.decideAppeal).not.toHaveBeenCalled();
  });

  it("binds the path appeal to its database learner and denies stale MFA with a durable audit", async () => {
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request(validBody), context());
    expect(response.status).toBe(403);
    expect(mocks.authorizePrivilegedAction).toHaveBeenCalledWith(expect.objectContaining({
      actorRole: "admin",
      action: "appeal.decide",
      reason: validBody.reason,
    }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-user",
      subjectUserId: "learner-user",
      resourceId: appealId,
      outcome: "denied",
    }));
    expect(mocks.decideAppeal).not.toHaveBeenCalled();
  });

  it("records pre-mutation and completion audits around an idempotent, version-bound decision", async () => {
    const response = await POST(request(validBody), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      report: { appealId, decision: "upheld", rowVersion: 2 },
      completionAuditRecorded: true,
    });
    expect(mocks.decideAppeal).toHaveBeenCalledWith({
      actorUserId: "admin-user",
      appealId,
      ...validBody,
    });
    expect(mocks.writeAuditEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      outcome: "allowed",
      metadata: expect.objectContaining({ phase: "pre_mutation", expectedVersion: 1 }),
    }));
    expect(mocks.writeAuditEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      outcome: "success",
      subjectUserId: "learner-user",
    }));
  });

  it("truthfully reports a completed decision when only the completion audit needs reconciliation", async () => {
    mocks.writeAuditEvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("audit sink unavailable"));
    const response = await POST(request(validBody), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      report: { decision: "upheld" },
      completionAuditRecorded: false,
      warning: expect.stringContaining("reconciliation"),
    });
    expect(mocks.decideAppeal).toHaveBeenCalledOnce();
  });

  it("requires an explicit corrective action for an overturn", async () => {
    const response = await POST(request({ ...validBody, decision: "overturned" }), context());
    expect(response.status).toBe(400);
    expect(mocks.decideAppeal).not.toHaveBeenCalled();
  });

  it("commits the exact queued project correction without running GitHub work in the request", async () => {
    const correctionId = "30000000-0000-4000-8000-000000000002";
    mocks.decideAppeal.mockResolvedValue({
      appealId,
      userId: "learner-user",
      decision: "overturned",
      status: "overturned",
      rowVersion: 2,
      decidedAt: "2026-07-12T00:00:00.000Z",
      examSessionId: null,
      correctionPending: true,
      projectReviewCorrectionId: correctionId,
      projectReviewCorrectionStatus: "queued",
      projectReviewCorrectionRevision: 1,
      replayed: false,
    });
    const response = await POST(request({
      ...validBody,
      decision: "overturned",
      correctiveAction: "Re-run deterministic static analysis against the exact preserved commit.",
    }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      report: {
        correctionPending: true,
        projectReviewCorrectionStatus: "queued",
      },
    });
    expect(mocks.writeAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ correctionExecution: "durable_worker_queued" }),
    }));
  });
});
