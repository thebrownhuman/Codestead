import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccountDeletionError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    AccountDeletionError, limit, select,
    requireAdmin: vi.fn(),
    authorizeLifecycleAdmin: vi.fn(),
    deleteLearnerAccount: vi.fn(),
    writeAuditEvent: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/data-lifecycle/admin-authorization", () => ({ authorizeLifecycleAdmin: mocks.authorizeLifecycleAdmin }));
vi.mock("@/lib/data-lifecycle/deletion", () => ({
  AccountDeletionError: mocks.AccountDeletionError,
  deleteLearnerAccount: mocks.deleteLearnerAccount,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: vi.fn(async (_input, callback) => callback()) }));

import { POST } from "../route";

const validBody = {
  requestId: "80000000-0000-4000-8000-000000000001",
  confirmation: "DELETE",
  reason: "Confirmed learner deletion request",
};

function request(body: unknown = validBody) {
  return new NextRequest("https://learn.test/api/admin/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("administrator learner deletion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockReset().mockResolvedValue([{ id: "learner-1", role: "learner" }]);
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "admin-session" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.authorizeLifecycleAdmin.mockResolvedValue({ allowed: true, code: "AUTHORIZED" });
    mocks.deleteLearnerAccount.mockResolvedValue({
      tombstoneId: "tombstone-1",
      backupStatus: "awaiting_retention_expiry",
      backupRetentionUntil: "2027-07-12T00:00:00.000Z",
      primaryStoreDeletionComplete: true,
      objectFileErasureComplete: true,
    });
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
  });

  it("requires administrator authentication", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.deleteLearnerAccount).not.toHaveBeenCalled();
  });

  it("rejects missing exact confirmation before any mutation", async () => {
    const response = await POST(request({ ...validBody, confirmation: "delete" }), {
      params: Promise.resolve({ learnerId: "learner-1" }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.deleteLearnerAccount).not.toHaveBeenCalled();
  });

  it("rejects unknown fields and a non-learner target before privileged authorization", async () => {
    const strictResponse = await POST(request({ ...validBody, learnerId: "body-target" }), {
      params: Promise.resolve({ learnerId: "learner-1" }),
    });
    expect(strictResponse.status).toBe(400);
    mocks.limit.mockResolvedValueOnce([{ id: "admin-2", role: "admin" }]);
    const targetResponse = await POST(request(), {
      params: Promise.resolve({ learnerId: "admin-2" }),
    });
    expect(targetResponse.status).toBe(404);
    expect(targetResponse.headers.get("cache-control")).toContain("no-store");
    expect(mocks.authorizeLifecycleAdmin).not.toHaveBeenCalled();
    expect(mocks.deleteLearnerAccount).not.toHaveBeenCalled();
  });

  it("requires fresh MFA and audits denial", async () => {
    mocks.authorizeLifecycleAdmin.mockResolvedValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(403);
    expect(mocks.deleteLearnerAccount).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      subjectUserId: "learner-1", outcome: "denied",
    }));
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("binds actor and target to authorization state and path, not request data", async () => {
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.deleteLearnerAccount).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      learnerId: "learner-1",
      requestId: validBody.requestId,
      reason: validBody.reason,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "account.delete", outcome: "allowed",
    }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "account.delete", outcome: "success",
    }));
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    ["ADMIN_REQUIRED", 403],
    ["LEARNER_NOT_FOUND", 404],
    ["FILE_ERASURE_FAILED", 503],
    ["RUN_IN_PROGRESS", 409],
    ["PREVIOUS_RUN_FAILED", 409],
    ["PROVIDER_OPERATION_IN_PROGRESS", 409],
    ["RUNNER_OPERATION_IN_PROGRESS", 409],
  ])("maps the safe lifecycle error %s to %s and audits failure", async (code, status) => {
    mocks.deleteLearnerAccount.mockRejectedValueOnce(new mocks.AccountDeletionError(code));
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: code });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "account.delete",
      outcome: "failure",
      metadata: { errorCode: code },
    }));
  });

  it("does not expose unexpected deletion failures", async () => {
    mocks.deleteLearnerAccount.mockRejectedValueOnce(new Error("database password leaked here"));
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("password leaked");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("reports truthful completion when only the post-deletion audit write fails", async () => {
    mocks.writeAuditEvent
      .mockResolvedValueOnce({ correlationId: "pre", eventHash: "pre-hash" })
      .mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      completionAuditRecorded: false,
      report: { primaryStoreDeletionComplete: true },
      warning: expect.stringContaining("operator reconciliation"),
    });
    expect(mocks.deleteLearnerAccount).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(2);
  });
});
