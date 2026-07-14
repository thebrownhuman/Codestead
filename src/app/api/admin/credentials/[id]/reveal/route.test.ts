import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ where, innerJoin }));
  const select = vi.fn(() => ({ from }));
  const values = vi.fn(async (value: unknown) => {
    void value;
  });
  const insert = vi.fn(() => ({ values }));
  return {
    limit,
    select,
    insert,
    values,
    requireAdmin: vi.fn(),
    enqueueEmail: vi.fn(),
    writeAuditEvent: vi.fn(),
    openCredential: vi.fn(),
    parseMasterKey: vi.fn(),
    authorizePrivilegedAction: vi.fn(),
    withRateLimit: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, insert: mocks.insert } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueEmail: mocks.enqueueEmail }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/credential-vault", () => ({
  openCredential: mocks.openCredential,
  parseMasterKey: mocks.parseMasterKey,
}));
vi.mock("@/lib/security/privileged-access", () => ({
  authorizePrivilegedAction: mocks.authorizePrivilegedAction,
}));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { POST } from "./route";

const credentialId = "a1000000-0000-4000-8000-000000000001";
const reason = "Help the learner repair a provider key configuration issue.";
const credential = {
  id: credentialId,
  userId: "learner-1",
  provider: "nvidia_nim",
  ciphertext: "ciphertext",
  wrappedDataKey: "wrapped",
  wrapIv: "wrap-iv",
  dataIv: "data-iv",
  authTag: "tag",
  keyVersion: "v1",
  lastFour: "ABCD",
  ownerEmail: "learner@example.test",
  ownerName: "Learner",
};

function request(body: unknown = { reason }) {
  return new NextRequest(`https://learn.test/api/admin/credentials/${credentialId}/reveal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(id = credentialId) {
  return { params: Promise.resolve({ id }) };
}

describe("administrator provider-key reveal boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CREDENTIAL_MASTER_KEY = "test-master-key-material-at-least-32-bytes";
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "session-1" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.withRateLimit.mockImplementation(async (_check, callback: () => Promise<Response>) => callback());
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.limit
      .mockResolvedValueOnce([{ mfaVerifiedAt: new Date() }])
      .mockResolvedValueOnce([credential]);
    mocks.parseMasterKey.mockReturnValue(Buffer.alloc(32, 7));
    mocks.openCredential.mockReturnValue("test-provider-credential-material");
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "audit-correlation-1", eventHash: "event-hash" });
    mocks.enqueueEmail.mockResolvedValue(undefined);
  });

  it("requires an administrator before parsing or touching reveal state", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("strictly rejects malformed reasons, extra fields, and identifiers and audits denial", async () => {
    for (const [body, id] of [
      [{ reason: "short" }, credentialId],
      [{ reason, unexpected: true }, credentialId],
      [{ reason }, "not-a-uuid"],
    ] as const) {
      const response = await POST(request(body), context(id));
      expect([400, 404]).toContain(response.status);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(3);
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
  });

  it("fails closed on stale MFA and records the exact denied credential", async () => {
    mocks.authorizePrivilegedAction.mockReturnValueOnce({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FRESH_MFA_REQUIRED" });
    expect(mocks.openCredential).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: credentialId,
      reason,
      outcome: "denied",
      metadata: { denialCode: "FRESH_MFA_REQUIRED" },
    }));
  });

  it("audits missing credentials and unavailable or corrupt vault state without leaking details", async () => {
    mocks.limit.mockReset()
      .mockResolvedValueOnce([{ mfaVerifiedAt: new Date() }])
      .mockResolvedValueOnce([]);
    const missing = await POST(request(), context());
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await missing.json())).not.toContain("ciphertext");

    mocks.limit.mockReset()
      .mockResolvedValueOnce([{ mfaVerifiedAt: new Date() }])
      .mockResolvedValueOnce([credential]);
    delete process.env.CREDENTIAL_MASTER_KEY;
    const unavailable = await POST(request(), context());
    expect(unavailable.status).toBe(503);
    expect(mocks.openCredential).not.toHaveBeenCalled();

    mocks.limit.mockReset()
      .mockResolvedValueOnce([{ mfaVerifiedAt: new Date() }])
      .mockResolvedValueOnce([credential]);
    process.env.CREDENTIAL_MASTER_KEY = "test-master-key-material-at-least-32-bytes";
    mocks.openCredential.mockImplementationOnce(() => { throw new Error("synthetic corruption"); });
    const corrupt = await POST(request(), context());
    expect(corrupt.status).toBe(503);
    expect(JSON.stringify(await corrupt.json())).not.toContain("synthetic corruption");
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failure",
      metadata: { errorCode: "CREDENTIAL_OPEN_FAILED" },
    }));
  });

  it("reveals only after fresh MFA, immutable audit, and both learner notifications", async () => {
    const response = await POST(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      credential: "test-provider-credential-material",
      provider: "nvidia_nim",
      lastFour: "ABCD",
      auditCorrelationId: "audit-correlation-1",
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1",
      subjectUserId: "learner-1",
      resourceId: credentialId,
      reason,
      outcome: "success",
      metadata: { provider: "nvidia_nim", lastFour: "ABCD" },
    }));
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      type: "credential-revealed",
    }));
    expect(mocks.enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "learner@example.test",
      template: "credential-revealed",
      idempotencySeed: `${credentialId}:audit-correlation-1`,
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain("test-provider-credential-material");
  });

  it("withholds plaintext if notification fails after recording the access", async () => {
    mocks.enqueueEmail.mockRejectedValueOnce(new Error("synthetic email outage"));
    const response = await POST(request(), context());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/plaintext was withheld/i);
    expect(JSON.stringify(body)).not.toContain("test-provider-credential-material");
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "credential.reveal.notification",
      outcome: "failure",
      correlationId: "audit-correlation-1",
    }));
  });

  it("rate-limits reveal attempts and still appends a denied audit event", async () => {
    mocks.withRateLimit.mockResolvedValueOnce(revealRateLimited());
    const response = await POST(request(), context());
    expect(response.status).toBe(429);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: credentialId,
      outcome: "denied",
      metadata: { denialCode: "RATE_LIMITED" },
    }));
  });
});

function revealRateLimited() {
  return NextResponse.json(
    { error: "Too many requests." },
    { status: 429, headers: { "Cache-Control": "private, no-store" } },
  );
}
