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
    writeAuditEvent: vi.fn(),
    authorizePrivilegedAction: vi.fn(),
    withRateLimit: vi.fn(),
    performAdminCredentialOperation: vi.fn(),
    adminCredentialErrorCode: vi.fn(),
    adminCredentialErrorStatus: vi.fn(),
    adminCredentialPublicError: vi.fn(),
    executeProviderOperationIdempotently: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/privileged-access", () => ({
  authorizePrivilegedAction: mocks.authorizePrivilegedAction,
}));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/admin-credentials/service", () => ({
  performAdminCredentialOperation: mocks.performAdminCredentialOperation,
  adminCredentialErrorCode: mocks.adminCredentialErrorCode,
  adminCredentialErrorStatus: mocks.adminCredentialErrorStatus,
  adminCredentialPublicError: mocks.adminCredentialPublicError,
}));
vi.mock("@/lib/ai/provider-operation-idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/provider-operation-idempotency")>()),
  canonicalProviderOperationHash: () => "a".repeat(64),
  executeProviderOperationIdempotently: mocks.executeProviderOperationIdempotently,
}));

import { DELETE, PATCH } from "./route";
import { ProviderOperationIdempotencyError } from "@/lib/ai/provider-operation-idempotency";

const credentialId = "a1000000-0000-4000-8000-000000000001";
const learnerId = "b1000000-0000-4000-8000-000000000002";
const requestId = "c1000000-0000-4000-8000-000000000003";
const reason = "Help this learner repair their provider configuration.";
const replacementSecret = "replacement-provider-material-123456";

function patchRequest(body: unknown) {
  return new NextRequest(`https://learn.test/api/admin/credentials/${credentialId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest(body: unknown) {
  return new NextRequest(`https://learn.test/api/admin/credentials/${credentialId}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(id = credentialId) {
  return { params: Promise.resolve({ id }) };
}

describe("administrator credential mutation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "session-1" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date() }]);
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.withRateLimit.mockImplementation(async (_check, callback: () => Promise<Response>) => callback());
    mocks.executeProviderOperationIdempotently.mockImplementation(async (input) => ({
      ...(await input.execute()),
      replayed: false,
    }));
    mocks.performAdminCredentialOperation.mockImplementation(async (input: { action: string }) => ({
      credentialId,
      action: input.action,
      status: input.action === "delete" ? "deleted" : "active",
      auditCorrelationId: "audit-correlation-1",
    }));
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "denial-audit", eventHash: "hash" });
    mocks.adminCredentialErrorCode.mockReturnValue("CREDENTIAL_NOT_FOUND");
    mocks.adminCredentialErrorStatus.mockReturnValue(404);
    mocks.adminCredentialPublicError.mockReturnValue("Credential not found for this learner.");
  });

  it("requires the administrator role before parsing, rate limiting, or touching credentials", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await PATCH(
      patchRequest({ learnerId, reason, action: "test" }),
      context(),
    );
    expect(response.status).toBe(403);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.performAdminCredentialOperation).not.toHaveBeenCalled();
  });

  it("strictly rejects malformed IDs, reasons, actions, and extra fields without retaining supplied material", async () => {
    const badBodies = [
      { learnerId, reason: "short", action: "test", requestId },
      { learnerId, reason, action: "replace", requestId, secret: replacementSecret, extra: true },
      { learnerId: "not-a-uuid", reason, action: "test", requestId },
      { learnerId, reason, action: "test" },
      { learnerId, reason, action: "prefer" },
    ];
    for (const body of badBodies) {
      const response = await PATCH(patchRequest(body), context());
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect((await PATCH(patchRequest({ learnerId, reason, action: "test", requestId }), context("bad-id"))).status).toBe(404);
    expect(mocks.performAdminCredentialOperation).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain(replacementSecret);
  });

  it("requires fresh MFA and a reason for every supported privileged action", async () => {
    for (const action of ["test", "replace", "enable", "disable"] as const) {
      mocks.authorizePrivilegedAction.mockReturnValueOnce({ allowed: false, code: "FRESH_MFA_REQUIRED" });
      const response = await PATCH(
        patchRequest({
          learnerId,
          reason,
          action,
          ...(action === "test" || action === "replace" ? { requestId } : {}),
          ...(action === "replace" ? { secret: replacementSecret } : {}),
        }),
        context(),
      );
      expect(response.status).toBe(403);
    }
    mocks.authorizePrivilegedAction.mockReturnValueOnce({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    expect((await DELETE(deleteRequest({ learnerId, reason }), context())).status).toBe(403);
    expect(mocks.performAdminCredentialOperation).not.toHaveBeenCalled();
    expect(mocks.authorizePrivilegedAction.mock.calls.map((call) => call[0].action)).toEqual([
      "credential.test",
      "credential.replace",
      "credential.enable",
      "credential.disable",
      "credential.delete",
    ]);
  });

  it("binds a replacement to the displayed learner and never puts key material in response or route audit", async () => {
    const response = await PATCH(
      patchRequest({ learnerId, reason, action: "replace", requestId, secret: replacementSecret }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      action: "replace",
      status: "active",
      auditCorrelationId: "audit-correlation-1",
    });
    expect(mocks.performAdminCredentialOperation).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      learnerPublicId: learnerId,
      credentialId,
      action: "replace",
      reason,
      replacementSecret,
    });
    expect(mocks.executeProviderOperationIdempotently).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "admin-1",
      action: "credential.replace",
      requestId,
      inputHash: "a".repeat(64),
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain(replacementSecret);
    expect(JSON.stringify(await PATCH(
      patchRequest({ learnerId, reason, action: "test", requestId }),
      context(),
    ).then((item) => item.json()))).not.toContain(replacementSecret);
  });

  it("fails a cross-learner/unknown credential closed with a generic safe response", async () => {
    mocks.performAdminCredentialOperation.mockRejectedValueOnce(new Error("synthetic owner mismatch"));
    const response = await PATCH(
      patchRequest({ learnerId, reason, action: "replace", requestId, secret: replacementSecret }),
      context(),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Credential not found for this learner.",
      code: "CREDENTIAL_NOT_FOUND",
    });
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain(replacementSecret);
  });

  it("routes delete through the same owner-bound service and returns no-store metadata only", async () => {
    const response = await DELETE(deleteRequest({ learnerId, reason }), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ ok: true, action: "delete", status: "deleted" });
    expect(mocks.performAdminCredentialOperation).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      learnerPublicId: learnerId,
      credentialId,
      action: "delete",
      reason,
    });
  });

  it("rate-limits before session or operation work and appends a safe denial audit", async () => {
    mocks.withRateLimit.mockResolvedValueOnce(NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Cache-Control": "private, no-store" } },
    ));
    const response = await PATCH(patchRequest({ learnerId, reason, action: "test", requestId }), context());
    expect(response.status).toBe(429);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.performAdminCredentialOperation).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: credentialId,
      outcome: "denied",
      metadata: { errorCode: "RATE_LIMITED" },
    }));
  });

  it("returns 503 and no secret if the atomic audit/notification transaction fails", async () => {
    mocks.performAdminCredentialOperation.mockRejectedValueOnce(new Error("synthetic notification outage"));
    mocks.adminCredentialErrorCode.mockReturnValueOnce("OPERATION_UNAVAILABLE");
    mocks.adminCredentialErrorStatus.mockReturnValueOnce(503);
    mocks.adminCredentialPublicError.mockReturnValueOnce("Credential operation could not be completed safely.");
    const response = await PATCH(
      patchRequest({ learnerId, reason, action: "replace", requestId, secret: replacementSecret }),
      context(),
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(replacementSecret);
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain(replacementSecret);
  });

  it("returns 409 for UUID payload reuse and replays the original safe result without another mutation", async () => {
    mocks.executeProviderOperationIdempotently.mockRejectedValueOnce(
      new ProviderOperationIdempotencyError("IDEMPOTENCY_KEY_REUSED", "Request ID payload mismatch."),
    );
    const mismatch = await PATCH(
      patchRequest({ learnerId, reason, action: "test", requestId }),
      context(),
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(mocks.performAdminCredentialOperation).not.toHaveBeenCalled();

    mocks.executeProviderOperationIdempotently.mockResolvedValueOnce({
      status: 200,
      body: { ok: true, action: "test", status: "active", auditCorrelationId: "original-audit" },
      replayed: true,
    });
    const replay = await PATCH(
      patchRequest({ learnerId, reason, action: "test", requestId }),
      context(),
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");
    expect(await replay.json()).toMatchObject({ auditCorrelationId: "original-audit" });
    expect(mocks.performAdminCredentialOperation).not.toHaveBeenCalled();
  });
});
