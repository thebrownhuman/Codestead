import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  authorizeAssessmentCorrection: vi.fn(),
  queueAssessmentCorrection: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("../../../authorization", () => ({ authorizeAssessmentCorrection: mocks.authorizeAssessmentCorrection }));
vi.mock("@/lib/assessment-corrections/admin-service", () => ({
  assessmentCorrectionErrorStatus: () => 409,
  queueAssessmentCorrection: mocks.queueAssessmentCorrection,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { POST } from "../route";

const correctionId = "30000000-0000-4000-8000-000000000001";
const body = {
  requestId: "40000000-0000-4000-8000-000000000001",
  expectedVersion: 1,
  reason: "Queue every exact immutable impact for automatic deterministic regrading.",
};

function request(value: unknown) {
  return new NextRequest(`https://learn.example.test/api/admin/assessment-corrections/${correctionId}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

function context(id = correctionId) {
  return { params: Promise.resolve({ correctionId: id }) };
}

describe("assessment correction queue route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-user" }, session: { id: "admin-session" } },
      account: { role: "admin" },
    });
    mocks.authorizeAssessmentCorrection.mockResolvedValue({ allowed: true, code: "AUTHORIZED" });
    mocks.queueAssessmentCorrection.mockResolvedValue({
      id: correctionId,
      rowVersion: 2,
      affectedCount: 2,
      replayed: false,
    });
    mocks.writeAuditEvent.mockResolvedValue({});
  });

  it("rejects unauthenticated, malformed-id, and stale-shaped requests before queueing", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await POST(request(body), context())).status).toBe(401);
    expect((await POST(request(body), context("not-an-id"))).status).toBe(404);
    expect((await POST(request({ ...body, expectedVersion: 0 }), context())).status).toBe(400);
    expect(mocks.queueAssessmentCorrection).not.toHaveBeenCalled();
  });

  it("denies stale MFA with an immutable audit", async () => {
    mocks.authorizeAssessmentCorrection.mockResolvedValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request(body), context());
    expect(response.status).toBe(403);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "assessment.correction.queue",
      resourceId: correctionId,
      outcome: "denied",
    }));
    expect(mocks.queueAssessmentCorrection).not.toHaveBeenCalled();
  });

  it("queues the exact version-bound correction and records completion", async () => {
    const response = await POST(request(body), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ report: { rowVersion: 2 }, completionAuditRecorded: true });
    expect(mocks.queueAssessmentCorrection).toHaveBeenCalledWith({
      actorUserId: "admin-user",
      correctionId,
      ...body,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "assessment.correction.queue",
      outcome: "success",
      metadata: { rowVersion: 2, replayed: false, affectedCount: 2 },
    }));
  });
});
