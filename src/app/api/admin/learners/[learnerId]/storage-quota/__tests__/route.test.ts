import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    limit,
    select,
    requireAdmin: vi.fn(),
    authorizePrivilegedAction: vi.fn(),
    writeAuditEvent: vi.fn(),
    getLearnerStorageQuota: vi.fn(),
    changeLearnerStorageQuota: vi.fn(),
    emailStorageQuotaChanged: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorizePrivilegedAction }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: vi.fn(async (_input, callback) => callback()) }));
vi.mock("@/lib/storage/admin-quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/admin-quota")>();
  return {
    ...actual,
    getLearnerStorageQuota: mocks.getLearnerStorageQuota,
    changeLearnerStorageQuota: mocks.changeLearnerStorageQuota,
  };
});
vi.mock("@/lib/storage/quota-notifications", () => ({ emailStorageQuotaChanged: mocks.emailStorageQuotaChanged }));

import { GET, PATCH } from "../route";

const learnerId = "a1000000-0000-4000-8000-000000000001";
const requestBody = {
  requestId: "a2000000-0000-4000-8000-000000000001",
  expectedRowVersion: 3,
  quotaBytes: 3 * 1024 ** 3,
  reason: "Learner needs space for course PDFs",
};

function request(body: unknown = requestBody) {
  return new NextRequest(`https://learn.test/api/admin/learners/${learnerId}/storage-quota`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("administrator storage quota route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "session-1" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date() }]);
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: requestBody.requestId, eventHash: "hash" });
    const quota = {
      learnerUserId: "learner-1",
      learnerPublicId: learnerId,
      learnerName: "Learner",
      learnerEmail: "learner@example.test",
      usedBytes: 1234,
      quotaBytes: requestBody.quotaBytes,
      rowVersion: 4,
      replayed: false,
    };
    mocks.getLearnerStorageQuota.mockResolvedValue(quota);
    mocks.changeLearnerStorageQuota.mockResolvedValue(quota);
    mocks.emailStorageQuotaChanged.mockResolvedValue(undefined);
  });

  it("requires administrator authentication and keeps responses private", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await PATCH(request(), { params: Promise.resolve({ learnerId }) });
    expect(response.status).toBe(403);
    expect(mocks.changeLearnerStorageQuota).not.toHaveBeenCalled();
  });

  it("returns the current authoritative quota without key or object metadata", async () => {
    const response = await GET(request(), { params: Promise.resolve({ learnerId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ usedBytes: 1234, quotaBytes: requestBody.quotaBytes, rowVersion: 4 });
  });

  it("strictly rejects invalid ranges, reasons and unexpected fields", async () => {
    for (const body of [
      { ...requestBody, quotaBytes: 3 * 1024 ** 3 + 1 },
      { ...requestBody, reason: "short" },
      { ...requestBody, unexpected: true },
      { ...requestBody, expectedRowVersion: -1 },
    ]) {
      const response = await PATCH(request(body), { params: Promise.resolve({ learnerId }) });
      expect(response.status).toBe(400);
    }
    expect(mocks.changeLearnerStorageQuota).not.toHaveBeenCalled();
  });

  it("denies a stale MFA session, audits it, and does not mutate", async () => {
    mocks.authorizePrivilegedAction.mockReturnValueOnce({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await PATCH(request(), { params: Promise.resolve({ learnerId }) });
    expect(response.status).toBe(403);
    expect(mocks.changeLearnerStorageQuota).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "storage.quota.change",
      outcome: "denied",
    }));
  });

  it("changes the quota with optimistic versioning, audits, and queues a notice", async () => {
    const response = await PATCH(request(), { params: Promise.resolve({ learnerId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ quotaBytes: requestBody.quotaBytes, rowVersion: 4 });
    expect(mocks.changeLearnerStorageQuota).toHaveBeenCalledWith({
      learnerPublicId: learnerId,
      requestedBytes: requestBody.quotaBytes,
      expectedRowVersion: 3,
      requestId: requestBody.requestId,
      actorUserId: "admin-1",
      reason: requestBody.reason,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      subjectUserId: "learner-1",
      outcome: "success",
      correlationId: requestBody.requestId,
    }));
    expect(mocks.emailStorageQuotaChanged).toHaveBeenCalledWith(
      expect.objectContaining({ learnerUserId: "learner-1" }),
      requestBody.requestId,
    );
  });

  it("returns an explicit durable replay marker while notifications remain idempotent", async () => {
    mocks.changeLearnerStorageQuota.mockResolvedValueOnce({
      learnerUserId: "learner-1",
      learnerPublicId: learnerId,
      learnerName: "Learner",
      learnerEmail: "learner@example.test",
      usedBytes: 1234,
      quotaBytes: requestBody.quotaBytes,
      rowVersion: 4,
      replayed: true,
    });
    const response = await PATCH(request(), { params: Promise.resolve({ learnerId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      quotaBytes: requestBody.quotaBytes,
      rowVersion: 4,
      replayed: true,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: requestBody.requestId,
      metadata: expect.objectContaining({ replayed: true }),
    }));
    expect(mocks.emailStorageQuotaChanged).toHaveBeenCalledTimes(1);
  });
});
