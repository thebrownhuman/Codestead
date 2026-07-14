import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  select: vi.fn(),
  authorize: vi.fn(),
  withRateLimit: vi.fn(),
  writeAuditEvent: vi.fn(),
  getCorrection: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorize }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/projects/review-correction-service", () => ({
  ProjectReviewCorrectionError: class ProjectReviewCorrectionError extends Error {
    constructor(public readonly code: string) { super(code); }
  },
  getProjectReviewCorrection: mocks.getCorrection,
  requestProjectReviewCorrectionRetry: mocks.retry,
}));

import { POST } from "../route";

const correctionId = "10000000-0000-4000-8000-000000000001";
const requestId = "10000000-0000-4000-8000-000000000002";
const reason = "Retry after the reviewed transient GitHub outage has cleared.";
const context = { params: Promise.resolve({ correctionId }) };

function request() {
  return new NextRequest(`https://learn.example.test/api/admin/project-review-corrections/${correctionId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, reason }),
  });
}

function selectBuilder(rows: unknown[]) {
  const builder = { from: () => builder, where: () => builder, limit: async () => rows };
  return builder;
}

describe("project-review correction retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-user" }, session: { id: "admin-session" } },
      account: { role: "admin" },
    });
    mocks.select.mockReturnValue(selectBuilder([{ mfaVerifiedAt: new Date() }]));
    mocks.authorize.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.withRateLimit.mockImplementation(async (_input, handler) => handler());
    mocks.writeAuditEvent.mockResolvedValue({});
    mocks.getCorrection.mockResolvedValue({ correction: { id: correctionId, userId: "learner-user" } });
    mocks.retry.mockResolvedValue({
      correctionId,
      userId: "learner-user",
      status: "queued",
      attemptCount: 1,
      duplicate: false,
    });
  });

  it("rejects a non-administrator before reading correction evidence", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.getCorrection).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("requires fresh MFA and reason before queueing a retry", async () => {
    mocks.authorize.mockReturnValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("queues durable worker retry without executing static analysis in the request", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(202);
    expect(mocks.retry).toHaveBeenCalledWith({
      actorUserId: "admin-user",
      correctionId,
      requestId,
      reason,
    });
    expect(await response.json()).toMatchObject({
      report: { status: "queued", duplicate: false },
      execution: { state: "queued", worker: "project-review-correction-worker" },
    });
  });
});
