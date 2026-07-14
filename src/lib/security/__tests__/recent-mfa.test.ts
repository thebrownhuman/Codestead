import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { limit, where, from, select, writeAuditEvent: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/security/audit-writer", () => ({
  writeAuditEvent: mocks.writeAuditEvent,
}));

import { requireRecentMfa } from "../recent-mfa";

const input = {
  sessionId: "session-1",
  userId: "learner-1",
  action: "credential.delete" as const,
  resourceId: "credential-1",
  now: new Date("2026-07-12T10:00:00.000Z"),
};

describe("recent MFA gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockReset();
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
  });

  it("allows a sensitive credential command after a durable fresh assertion", async () => {
    mocks.limit.mockResolvedValueOnce([
      { mfaVerifiedAt: new Date("2026-07-12T09:59:00.000Z") },
    ]);

    await expect(requireRecentMfa(input)).resolves.toEqual({ allowed: true });
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("denies and audits a stale assertion without exposing credential data", async () => {
    mocks.limit.mockResolvedValueOnce([
      { mfaVerifiedAt: new Date("2026-07-12T09:54:59.999Z") },
    ]);

    const result = await requireRecentMfa(input);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("Expected the recent-MFA gate to deny.");
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    await expect(result.response.json()).resolves.toEqual({
      error: "Verify your authenticator before changing provider credentials.",
      code: "FRESH_MFA_REQUIRED",
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith({
      actorUserId: "learner-1",
      subjectUserId: "learner-1",
      action: "credential.delete",
      resourceType: "provider_credential",
      resourceId: "credential-1",
      outcome: "denied",
      metadata: { denialCode: "FRESH_MFA_REQUIRED" },
    });
  });

  it("fails closed when the session row is absent", async () => {
    mocks.limit.mockResolvedValueOnce([]);

    const result = await requireRecentMfa({ ...input, action: "credential.add" });
    expect(result.allowed).toBe(false);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "credential.add", outcome: "denied" }),
    );
  });
});
