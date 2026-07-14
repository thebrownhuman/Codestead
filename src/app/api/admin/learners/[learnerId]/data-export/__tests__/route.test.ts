import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    limit, select,
    requireAdmin: vi.fn(),
    authorizeLifecycleAdmin: vi.fn(),
    createLearnerExport: vi.fn(),
    writeAuditEvent: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/data-lifecycle/admin-authorization", () => ({ authorizeLifecycleAdmin: mocks.authorizeLifecycleAdmin }));
vi.mock("@/lib/data-lifecycle/export", () => ({ createLearnerExport: mocks.createLearnerExport }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: vi.fn(async (_input, callback) => callback()) }));

import { POST } from "../route";

const body = {
  requestId: "81000000-0000-4000-8000-000000000001",
  reason: "Learner requested a data export",
};

function request(payload: unknown = body) {
  return new NextRequest("https://learn.test/api/admin/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  it("requires administrator authentication", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.createLearnerExport).not.toHaveBeenCalled();
  });

  it("strictly validates request ids, reasons, fields, and size bounds", async () => {
    for (const payload of [
      { ...body, requestId: "not-a-uuid" },
      { ...body, reason: "short" },
      { ...body, maxRecords: 10_001 },
      { ...body, maxBytes: 1_023 },
      { ...body, unexpected: true },
    ]) {
      const response = await POST(request(payload), {
        params: Promise.resolve({ learnerId: "learner-1" }),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(mocks.authorizeLifecycleAdmin).not.toHaveBeenCalled();
    expect(mocks.createLearnerExport).not.toHaveBeenCalled();
  });

  it("rejects an unavailable target before privileged authorization", async () => {
    mocks.limit.mockResolvedValueOnce([]);
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "missing" }) });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.authorizeLifecycleAdmin).not.toHaveBeenCalled();
    expect(mocks.createLearnerExport).not.toHaveBeenCalled();
  });
}

describe("administrator learner export route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockReset().mockResolvedValue([{ id: "learner-1" }]);
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "admin-session" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.authorizeLifecycleAdmin.mockResolvedValue({ allowed: true, code: "AUTHORIZED" });
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
    mocks.createLearnerExport.mockResolvedValue({
      runId: "run-1",
      stream: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{}\n")); controller.close(); } }),
      completion: Promise.resolve({ records: 1, bytes: 3, truncated: false }),
    });
  });

  it("does not start an export without fresh MFA", async () => {
    mocks.authorizeLifecycleAdmin.mockResolvedValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.createLearnerExport).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "data.export", outcome: "denied", subjectUserId: "learner-1",
    }));
  });

  it("streams a no-store attachment bound to the path learner", async () => {
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("x-export-run-id")).toBe("run-1");
    expect(response.headers.get("x-robots-tag")).toContain("noarchive");
    expect(mocks.createLearnerExport).toHaveBeenCalledWith({
      learnerId: "learner-1",
      actorUserId: "admin-1",
      requestId: body.requestId,
      maxRecords: undefined,
      maxBytes: undefined,
    });
    await expect(response.text()).resolves.toBe("{}\n");
  });

  it("passes only validated bounds and records an export-start failure safely", async () => {
    mocks.createLearnerExport.mockRejectedValueOnce(new Error("duplicate request"));
    const response = await POST(request({ ...body, maxRecords: 25, maxBytes: 4_096 }), {
      params: Promise.resolve({ learnerId: "learner-1" }),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("duplicate request");
    expect(mocks.createLearnerExport).toHaveBeenCalledWith(expect.objectContaining({
      learnerId: "learner-1",
      maxRecords: 25,
      maxBytes: 4_096,
    }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "data.export", outcome: "failure",
      metadata: { errorCode: "EXPORT_START_FAILED" },
    }));
  });

  it("audits an asynchronous stream failure without exposing it in response headers", async () => {
    mocks.createLearnerExport.mockResolvedValueOnce({
      runId: "run-failed",
      stream: new ReadableStream({ start(controller) { controller.close(); } }),
      completion: Promise.reject(new Error("stream secret")),
    });
    const response = await POST(request(), { params: Promise.resolve({ learnerId: "learner-1" }) });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "data.export",
      resourceId: "run-failed",
      outcome: "failure",
      metadata: { errorCode: "EXPORT_STREAM_FAILED" },
    })));
  });
});
