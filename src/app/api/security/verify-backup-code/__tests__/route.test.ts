import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    where, set, update,
    requireAuth: vi.fn(), withRateLimit: vi.fn(), verifyBackupCode: vi.fn(),
    writeAuditEvent: vi.fn(), headers: vi.fn(async () => new Headers({ cookie: "session=test" })),
  };
});

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/auth", () => ({ auth: { api: { verifyBackupCode: mocks.verifyBackupCode } } }));
vi.mock("@/lib/db/client", () => ({ db: { update: mocks.update } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { POST } from "../route";

const request = (code: string) => new NextRequest("https://learn.test/api/security/verify-backup-code", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code }),
});

describe("session recovery-code verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" }, session: { id: "session-1" } },
      account: { status: "active", role: "learner", twoFactorEnabled: true },
      response: null,
    });
    mocks.withRateLimit.mockImplementation(async (_config, callback) => callback());
    mocks.verifyBackupCode.mockResolvedValue({ status: true });
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
    mocks.where.mockResolvedValue(undefined);
  });

  it("consumes the code server-side and stamps only the authenticated session", async () => {
    const code = "recovery-code-1234";
    const response = await POST(request(code));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requireAuth).toHaveBeenCalledWith({ allowPending: true, allowMfaChallenge: true });
    expect(mocks.verifyBackupCode).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { code, trustDevice: false, disableSession: false },
    });
    expect(mocks.set).toHaveBeenCalledWith({ mfaVerifiedAt: expect.any(Date) });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "learner-1",
      resourceId: "session-1",
      action: "mfa.backup_code_assertion",
      outcome: "success",
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain(code);
  });

  it("audits denial without retaining the submitted recovery code", async () => {
    const code = "invalid-recovery-code";
    mocks.verifyBackupCode.mockRejectedValueOnce(new Error("invalid"));
    const response = await POST(request(code));
    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "denied",
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain(code);
  });

  it("rejects malformed values before invoking Better Auth", async () => {
    const response = await POST(request("x"));
    expect(response.status).toBe(400);
    expect(mocks.verifyBackupCode).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
