import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  submit: vi.fn(),
  writeAuditEvent: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/appeals/project-review-service", () => ({
  ProjectReviewAppealError: class ProjectReviewAppealError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
  submitProjectReviewAppeal: mocks.submit,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { POST } from "../route";

const projectId = "10000000-0000-4000-8000-000000000001";
const reviewId = "10000000-0000-4000-8000-000000000002";
const requestId = "10000000-0000-4000-8000-000000000003";
const params = { params: Promise.resolve({ id: projectId, reviewId }) };

function request(body: unknown) {
  return new NextRequest("https://learn.example.test/api/projects/x/reviews/y/appeal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("project-review appeal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-user" }, session: { id: "session" } },
    });
    mocks.withRateLimit.mockImplementation(async (_check, handler) => handler());
    mocks.submit.mockResolvedValue({
      accepted: true,
      duplicate: false,
      appealId: "20000000-0000-4000-8000-000000000001",
      evidenceHash: "a".repeat(64),
    });
    mocks.writeAuditEvent.mockResolvedValue(undefined);
  });

  it("requires authentication before consuming a learner budget", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await POST(request({}), params);
    expect(response.status).toBe(401);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("binds the authenticated learner and URL targets, then writes a claim-free audit event", async () => {
    const reason = "This finding points to an intentional documented fixture.";
    const response = await POST(request({
      clientRequestId: requestId,
      category: "project_finding",
      reason,
      userId: "attacker-selected-user",
      projectId: "attacker-selected-project",
    }), params);
    expect(response.status).toBe(202);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: "project_review_appeal_user",
        identity: { kind: "user", value: "learner-user" },
      }),
      expect.any(Function),
    );
    expect(mocks.submit).toHaveBeenCalledWith({
      userId: "learner-user",
      projectId,
      projectReviewId: reviewId,
      clientRequestId: requestId,
      category: "project_finding",
      reason,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "learner-user",
      subjectUserId: "learner-user",
      action: "project_review.appeal_submit",
      resourceType: "appeal",
      outcome: "success",
      metadata: expect.objectContaining({ projectId, projectReviewId: reviewId }),
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls[0]?.[0])).not.toContain(reason);
  });

  it.each([
    [{ clientRequestId: "bad", category: "project_finding", reason: "A sufficiently long reason for the appeal." }],
    [{ clientRequestId: requestId, category: "scoring", reason: "A sufficiently long reason for the appeal." }],
    [{ clientRequestId: requestId, category: "project_finding", reason: "short" }],
  ])("rejects malformed input without calling the service", async (body) => {
    const response = await POST(request(body), params);
    expect(response.status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("returns the limiter response without touching appeal storage", async () => {
    mocks.withRateLimit.mockResolvedValue(
      NextResponse.json({ code: "RATE_LIMITED" }, { status: 429 }),
    );
    const response = await POST(request({
      clientRequestId: requestId,
      category: "project_finding",
      reason: "This is a sufficiently specific appeal explanation.",
    }), params);
    expect(response.status).toBe(429);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
