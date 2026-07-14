import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AdminPlanServiceError extends Error {
    constructor(public readonly code: string, message: string, public readonly preview?: unknown) {
      super(message);
    }
  }
  return {
    AdminPlanServiceError,
    requireAdmin: vi.fn(),
    authorizeAdminPlanMutation: vi.fn(),
    previewLearnerPlanRevision: vi.fn(),
    createLearnerPlanRevision: vi.fn(),
    revertLearnerPlanRevision: vi.fn(),
    notifyLearningPlanChanged: vi.fn(),
    writeAuditEvent: vi.fn(),
  };
});

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-plan/authorization", () => ({ authorizeAdminPlanMutation: mocks.authorizeAdminPlanMutation }));
vi.mock("@/lib/admin-plan/notifications", () => ({ notifyLearningPlanChanged: mocks.notifyLearningPlanChanged }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: vi.fn(async (_input, callback) => callback()) }));
vi.mock("@/lib/admin-plan/service", () => ({
  AdminPlanServiceError: mocks.AdminPlanServiceError,
  adminPlanHttpStatus: (error: unknown) => {
    if (!(error instanceof mocks.AdminPlanServiceError)) return 500;
    if (error.code === "VERSION_CONFLICT" || error.code === "PREREQUISITE_VIOLATION") return 409;
    if (error.code === "ENROLLMENT_NOT_FOUND") return 404;
    return 400;
  },
  previewLearnerPlanRevision: mocks.previewLearnerPlanRevision,
  createLearnerPlanRevision: mocks.createLearnerPlanRevision,
  revertLearnerPlanRevision: mocks.revertLearnerPlanRevision,
}));

import { POST as createRevision } from "../route";
import { POST as revertRevision } from "../../revert/route";

const learnerId = "10000000-0000-4000-8000-000000000001";
const enrollmentId = "20000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000001";
const effectiveAt = "2026-07-12T10:00:00.000Z";
const reason = "Assign focused remediation after mentor review.";
const operation = {
  type: "assign_remediation",
  itemId: "python:loops:learn:python",
  note: "Repeat loop tracing before the next assessment.",
};
const preview = {
  plan: [],
  diff: { added: [], removed: [], moved: [], changed: [{ id: operation.itemId }] },
  impact: {
    canApply: true,
    prerequisiteViolations: [],
    downstreamAffected: [{ skillId: "python.functions", title: "Functions" }],
    overrideRequests: [],
    evidencePreserved: true,
    masteryMutation: false,
    prerequisiteBypass: false,
  },
};

function request(path: string, body: unknown) {
  return new NextRequest(`https://learn.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    expectedRevision: 2,
    reason,
    effectiveAt,
    previewOnly: false,
    operations: [operation],
    ...overrides,
  };
}

function params() {
  return { params: Promise.resolve({ learnerId, enrollmentId }) };
}

describe("administrator learning-plan revision routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "admin-session" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.authorizeAdminPlanMutation.mockResolvedValue({ allowed: true, learnerUserId: "learner-user-1" });
    mocks.previewLearnerPlanRevision.mockResolvedValue({
      detail: { latestRevision: 2 }, preview,
    });
    mocks.createLearnerPlanRevision.mockResolvedValue({
      created: true,
      replayed: false,
      learner: { learnerUserId: "learner-user-1", courseTitle: "Python" },
      revision: { id: requestId, revision: 3, parentId: "revision-2" },
      preview,
    });
    mocks.revertLearnerPlanRevision.mockResolvedValue({
      created: true,
      replayed: false,
      learner: { learnerUserId: "learner-user-1", courseTitle: "Python" },
      revision: { id: requestId, revision: 4, parentId: "revision-3" },
      preview,
    });
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "audit-1", eventHash: "hash" });
    mocks.notifyLearningPlanChanged.mockResolvedValue(undefined);
  });

  it("requires administrator authentication before preview or mutation", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await createRevision(request("/api/admin/plans", createBody()), params());
    expect(response.status).toBe(403);
    expect(mocks.previewLearnerPlanRevision).not.toHaveBeenCalled();
    expect(mocks.createLearnerPlanRevision).not.toHaveBeenCalled();
  });

  it("rejects path/body confusion and malformed operations before privileged action", async () => {
    const badPath = await createRevision(
      request("/api/admin/plans", createBody()),
      { params: Promise.resolve({ learnerId: "not-a-uuid", enrollmentId }) },
    );
    expect(badPath.status).toBe(400);
    const badBody = await createRevision(
      request("/api/admin/plans", createBody({ learnerId: "body-target", operations: [] })),
      params(),
    );
    expect(badBody.status).toBe(400);
    expect(mocks.authorizeAdminPlanMutation).not.toHaveBeenCalled();
  });

  it("returns prerequisite/downstream preview without requiring fresh MFA or writing state", async () => {
    const response = await createRevision(
      request("/api/admin/plans", createBody({ previewOnly: true })),
      params(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preview, expectedRevision: 2 });
    expect(mocks.previewLearnerPlanRevision).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      learnerPublicId: learnerId,
      enrollmentId,
      expectedRevision: 2,
      effectiveAt,
      operations: [operation],
    });
    expect(mocks.authorizeAdminPlanMutation).not.toHaveBeenCalled();
    expect(mocks.createLearnerPlanRevision).not.toHaveBeenCalled();
  });

  it("requires fresh MFA and a reason through the target-bound privileged gate", async () => {
    mocks.authorizeAdminPlanMutation.mockResolvedValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await createRevision(request("/api/admin/plans", createBody()), params());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "FRESH_MFA_REQUIRED", code: "FRESH_MFA_REQUIRED" });
    expect(mocks.authorizeAdminPlanMutation).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1",
      learnerPublicId: learnerId,
      enrollmentId,
      reason,
      action: "plan_revision.create",
    }));
    expect(mocks.createLearnerPlanRevision).not.toHaveBeenCalled();
  });

  it("binds actor/learner/enrollment, appends a revision, audits invariants, and notifies the learner", async () => {
    const response = await createRevision(request("/api/admin/plans", createBody()), params());
    expect(response.status).toBe(201);
    expect(mocks.createLearnerPlanRevision).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      learnerPublicId: learnerId,
      enrollmentId,
      requestId,
      expectedRevision: 2,
      reason,
      effectiveAt,
      operations: [operation],
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1",
      subjectUserId: "learner-user-1",
      action: "plan_revision.create",
      resourceId: requestId,
      outcome: "success",
      metadata: expect.objectContaining({
        replayed: false,
        evidencePreserved: true,
        masteryMutation: false,
        prerequisiteBypass: false,
      }),
    }));
    expect(mocks.notifyLearningPlanChanged).toHaveBeenCalledWith({
      learnerUserId: "learner-user-1",
      courseTitle: "Python",
      revision: 3,
      action: "updated",
      idempotencySeed: requestId,
    });
  });

  it("replays the idempotent notifier so a prior outbox failure can self-heal", async () => {
    mocks.createLearnerPlanRevision.mockResolvedValueOnce({
      created: false,
      replayed: true,
      learner: { learnerUserId: "learner-user-1", courseTitle: "Python" },
      revision: { id: requestId, revision: 3, parentId: "revision-2" },
      preview: null,
    });
    const response = await createRevision(request("/api/admin/plans", createBody()), params());
    expect(response.status).toBe(200);
    expect(mocks.notifyLearningPlanChanged).toHaveBeenCalledWith({
      learnerUserId: "learner-user-1",
      courseTitle: "Python",
      revision: 3,
      action: "updated",
      idempotencySeed: requestId,
    });
    await expect(response.json()).resolves.toMatchObject({
      replayed: true,
      learnerNotificationQueued: true,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      metadata: expect.objectContaining({ replayed: true }),
    }));
  });

  it("truthfully reports post-commit audit/notification delivery failures without retrying the mutation", async () => {
    mocks.writeAuditEvent
      .mockResolvedValueOnce({ correlationId: "allowed", eventHash: "allowed-hash" })
      .mockRejectedValueOnce(new Error("completion audit unavailable"));
    mocks.notifyLearningPlanChanged.mockRejectedValueOnce(new Error("outbox unavailable"));

    const response = await createRevision(request("/api/admin/plans", createBody()), params());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      auditRecorded: false,
      learnerNotificationQueued: false,
      warning: expect.stringContaining("operator must reconcile"),
    });
    expect(mocks.createLearnerPlanRevision).toHaveBeenCalledTimes(1);
  });

  it("returns a safe version conflict and prerequisite impact without leaking unexpected failures", async () => {
    mocks.createLearnerPlanRevision.mockRejectedValueOnce(
      new mocks.AdminPlanServiceError("VERSION_CONFLICT", "Reload revision 4 before saving."),
    );
    const conflict = await createRevision(request("/api/admin/plans", createBody()), params());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "VERSION_CONFLICT" });

    mocks.createLearnerPlanRevision.mockRejectedValueOnce(
      new mocks.AdminPlanServiceError("PREREQUISITE_VIOLATION", "Prerequisite required.", preview),
    );
    const blocked = await createRevision(request("/api/admin/plans", createBody()), params());
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ code: "PREREQUISITE_VIOLATION", preview });

    mocks.createLearnerPlanRevision.mockRejectedValueOnce(new Error("database password leaked"));
    const unexpected = await createRevision(request("/api/admin/plans", createBody()), params());
    expect(unexpected.status).toBe(500);
    expect(await unexpected.text()).not.toContain("password leaked");
  });

  it("creates a new append-only revert revision and never edits the historical target", async () => {
    const body = {
      requestId,
      expectedRevision: 3,
      targetRevision: 1,
      reason: "Return to the earlier sequence after mentor review.",
      effectiveAt,
    };
    const response = await revertRevision(request("/api/admin/plans/revert", body), params());
    expect(response.status).toBe(201);
    expect(mocks.revertLearnerPlanRevision).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      learnerPublicId: learnerId,
      enrollmentId,
      ...body,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "plan_revision.revert",
      resourceId: requestId,
      metadata: expect.objectContaining({ targetRevision: 1, masteryMutation: false }),
    }));
    expect(mocks.notifyLearningPlanChanged).toHaveBeenCalledWith(expect.objectContaining({
      action: "reverted",
      revision: 4,
    }));
  });

  it("also retries the idempotent revert notification on replay", async () => {
    mocks.revertLearnerPlanRevision.mockResolvedValueOnce({
      created: false,
      replayed: true,
      learner: { learnerUserId: "learner-user-1", courseTitle: "Python" },
      revision: { id: requestId, revision: 4, parentId: "revision-3" },
      preview: null,
    });
    const response = await revertRevision(request("/api/admin/plans/revert", {
      requestId,
      expectedRevision: 3,
      targetRevision: 1,
      reason: "Return to the earlier sequence after mentor review.",
      effectiveAt,
    }), params());

    expect(response.status).toBe(200);
    expect(mocks.notifyLearningPlanChanged).toHaveBeenCalledWith(expect.objectContaining({
      action: "reverted",
      revision: 4,
      idempotencySeed: requestId,
    }));
    await expect(response.json()).resolves.toMatchObject({
      replayed: true,
      learnerNotificationQueued: true,
    });
  });
});
