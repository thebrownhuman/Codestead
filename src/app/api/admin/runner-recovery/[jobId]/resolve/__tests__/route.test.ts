import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return {
    limit,
    select: vi.fn(() => ({ from })),
    requireAdmin: vi.fn(),
    resolve: vi.fn(),
    writeAuditEvent: vi.fn(),
    authorizePrivilegedAction: vi.fn(),
    withRateLimit: vi.fn(async (_check, handler: () => Promise<Response>) => handler()),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/runner/practice-recovery-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runner/practice-recovery-admin")>();
  return { ...actual, resolveQuarantinedPracticeRunnerJob: mocks.resolve };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorizePrivilegedAction }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { POST } from "../route";
import { PracticeRecoveryAdminError } from "@/lib/runner/practice-recovery-admin";

const JOB_ID = "51000000-0000-4000-8000-000000000001";
const REQUEST_ID = "51000000-0000-4000-8000-000000000002";
const body = {
  requestId: REQUEST_ID,
  reason: "Runner restarted and the durable journal was reconciled before terminalization.",
  isolatedRunnerRestarted: true,
  journalReconciled: true,
};

function request(payload: unknown = body) {
  return new NextRequest(`https://learn.test/api/admin/runner-recovery/${JOB_ID}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function context(jobId = JOB_ID) {
  return { params: Promise.resolve({ jobId }) };
}

describe("administrator practice quarantine resolution route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date() }]);
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "admin-session" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.writeAuditEvent.mockResolvedValue({ eventHash: "a".repeat(64), correlationId: REQUEST_ID });
    mocks.resolve.mockResolvedValue({
      runnerJobId: JOB_ID,
      submissionId: "51000000-0000-4000-8000-000000000003",
      learnerUserId: "learner-1",
      status: "cancelled",
      officialEvidenceChanged: false,
      replayed: false,
    });
  });

  it("requires administrator authentication before parsing or storage", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["missing restart attestation", { ...body, isolatedRunnerRestarted: false }],
    ["missing journal attestation", { ...body, journalReconciled: false }],
    ["short reason", { ...body, reason: "too short" }],
    ["extra field", { ...body, force: true }],
  ])("strictly rejects %s and audits denial", async (_label, payload) => {
    const response = await POST(request(payload), context());
    expect(response.status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "runner.practice.quarantine.resolve",
      outcome: "denied",
      metadata: expect.objectContaining({ code: "INVALID_REQUEST", officialEvidenceChanged: false }),
    }));
  });

  it("requires fresh MFA and a reason through the privileged action gate", async () => {
    mocks.authorizePrivilegedAction.mockReturnValueOnce({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.authorizePrivilegedAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "runner.practice.quarantine.resolve",
      reason: body.reason,
    }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: JOB_ID,
      correlationId: REQUEST_ID,
      outcome: "denied",
      metadata: expect.objectContaining({ code: "FRESH_MFA_REQUIRED" }),
    }));
  });

  it("rate limits the privileged operation and records the denial", async () => {
    mocks.withRateLimit.mockResolvedValueOnce(NextResponse.json({ error: "Too many requests." }, { status: 429 }));
    const response = await POST(request(), context());
    expect(response.status).toBe(429);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: JOB_ID,
      correlationId: REQUEST_ID,
      metadata: expect.objectContaining({ code: "RATE_LIMITED" }),
    }));
  });

  it("passes both attestations to the atomic resolver and returns its replay marker", async () => {
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "runner_recovery_admin", identity: { kind: "user", value: "admin-1" } },
      expect.any(Function),
    );
    expect(mocks.resolve).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      runnerJobId: JOB_ID,
      ...body,
    });
    await expect(response.json()).resolves.toMatchObject({
      resolution: { status: "cancelled", officialEvidenceChanged: false, replayed: false },
    });
  });

  it("rejects official jobs and audits the failed attempt", async () => {
    mocks.resolve.mockRejectedValueOnce(new PracticeRecoveryAdminError("NOT_PRACTICE_JOB"));
    const response = await POST(request(), context());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_PRACTICE_JOB" });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: JOB_ID,
      correlationId: REQUEST_ID,
      outcome: "failure",
      metadata: expect.objectContaining({ code: "NOT_PRACTICE_JOB" }),
    }));
  });
});
