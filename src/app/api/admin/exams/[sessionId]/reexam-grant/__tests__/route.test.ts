import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  withRateLimit: vi.fn(),
  limit: vi.fn(),
  issue: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/db/client", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }) },
}));
vi.mock("@/lib/exams/reexam-grant", () => {
  class ExamReexamGrantError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  return { ExamReexamGrantError, issueExamReexamGrant: mocks.issue };
});

import { ExamReexamGrantError } from "@/lib/exams/reexam-grant";
import { POST } from "../route";

const sessionId = "61000000-0000-4000-8000-000000000001";
const body = {
  requestId: "62000000-0000-4000-8000-000000000001",
  reason: "The server recorded a material disconnect through the deadline.",
};

function request(value: unknown = body) {
  return new NextRequest(`https://learn.example.test/api/admin/exams/${sessionId}/reexam-grant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

const context = { params: Promise.resolve({ sessionId }) };

describe("administrator material-outage re-exam grant endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "auth-session-1" } },
      account: { role: "admin" },
    });
    mocks.withRateLimit.mockImplementation(async (_input, work: () => Promise<Response>) => work());
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date() }]);
    mocks.audit.mockResolvedValue({ eventHash: "a".repeat(64) });
    mocks.issue.mockResolvedValue({
      id: "63000000-0000-4000-8000-000000000001",
      userId: "learner-1",
      sourceExamSessionId: sessionId,
      moduleId: "pf.computing",
      evidenceHash: "b".repeat(64),
      status: "available",
      replayed: false,
    });
  });

  it("requires administrator authentication before parsing a grant", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("requires fresh MFA and audits the denied reasoned action", async () => {
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date(0) }]);
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FRESH_MFA_REQUIRED" });
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "exam.reexam.grant", outcome: "denied", reason: body.reason,
    }));
  });

  it("issues a one-use grant only after fresh MFA and records the evidence hash", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.issue).toHaveBeenCalledWith({
      actorUserId: "admin-1", sourceExamSessionId: sessionId,
      requestId: body.requestId, reason: body.reason,
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({
      subjectUserId: "learner-1", outcome: "success",
      metadata: expect.objectContaining({ evidenceHash: "b".repeat(64) }),
    }));
  });

  it("fails closed when durable material-outage evidence is absent", async () => {
    mocks.issue.mockRejectedValue(new ExamReexamGrantError("MATERIAL_OUTAGE_EVIDENCE_REQUIRED"));
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "MATERIAL_OUTAGE_EVIDENCE_REQUIRED" });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "failure" }));
  });
});
