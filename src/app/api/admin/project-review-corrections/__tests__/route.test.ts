import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  select: vi.fn(),
  authorize: vi.fn(),
  withRateLimit: vi.fn(),
  writeAuditEvent: vi.fn(),
  list: vi.fn(),
  queue: vi.fn(),
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
  listProjectReviewCorrections: mocks.list,
  queueProjectReviewCorrection: mocks.queue,
}));

import { GET, POST } from "../route";

const sourceReviewId = "10000000-0000-4000-8000-000000000001";
const requestId = "10000000-0000-4000-8000-000000000002";
const correctionId = "10000000-0000-4000-8000-000000000003";
const reason = "The stored static rubric omitted the documented test-directory rule.";

function request(body: unknown) {
  return new NextRequest("https://learn.example.test/api/admin/project-review-corrections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function selectBuilder(rows: unknown[]) {
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    limit: async () => rows,
  };
  return builder;
}

describe("project review correction collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-user" }, session: { id: "admin-session" } },
      account: { role: "admin" },
    });
    const selections = [
      [{ userId: "learner-user" }],
      [{ mfaVerifiedAt: new Date() }],
    ];
    mocks.select.mockImplementation(() => selectBuilder(selections.shift() ?? []));
    mocks.authorize.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.withRateLimit.mockImplementation(async (_input, handler) => handler());
    mocks.writeAuditEvent.mockResolvedValue({});
    mocks.list.mockResolvedValue([]);
    mocks.queue.mockResolvedValue({
      correctionId,
      projectId: "10000000-0000-4000-8000-000000000004",
      sourceReviewId,
      userId: "learner-user",
      status: "queued",
      revision: 1,
      duplicate: false,
    });
  });

  it("fails closed before reading or queueing for a non-admin", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request({ requestId, sourceReviewId, reason }));
    expect(response.status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("requires fresh MFA and audits denial before queueing a defective review", async () => {
    mocks.authorize.mockReturnValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request({ requestId, sourceReviewId, reason }));
    expect(response.status).toBe(403);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "project_review.correction_queue",
      resourceId: sourceReviewId,
      outcome: "denied",
      metadata: { denialCode: "FRESH_MFA_REQUIRED", trigger: "defective_review" },
    }));
  });

  it("binds the authenticated administrator and durably queues exact-review analysis", async () => {
    const response = await POST(request({ requestId, sourceReviewId, reason }));
    expect(response.status).toBe(202);
    expect(mocks.queue).toHaveBeenCalledWith({
      actorUserId: "admin-user",
      sourceReviewId,
      requestId,
      reason,
    });
    expect(await response.json()).toMatchObject({
      correction: { correctionId, status: "queued" },
      execution: { state: "queued", worker: "project-review-correction-worker" },
    });
    expect(mocks.writeAuditEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "project_review.correction_queue",
      resourceType: "project_review_correction",
      resourceId: correctionId,
      outcome: "success",
      metadata: expect.objectContaining({ correctionExecution: "durable_worker_queued" }),
    }));
  });

  it("rejects extra or malformed fields without touching storage", async () => {
    const response = await POST(request({ requestId, sourceReviewId, reason, userId: "attacker" }));
    expect(response.status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it("lists only through the administrator projection", async () => {
    const response = await GET(new NextRequest("https://learn.example.test/api/admin/project-review-corrections?scope=all"));
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ scope: "all" });
  });
});
