import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { authorizePrivilegedAction: vi.fn(), from, limit, select, where };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/security/privileged-access", () => ({
  authorizePrivilegedAction: mocks.authorizePrivilegedAction,
}));

import { authorizeLifecycleAdmin } from "../admin-authorization";

describe("lifecycle administrator authorization binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue([]);
    mocks.authorizePrivilegedAction.mockReturnValue({
      allowed: false,
      code: "FRESH_MFA_REQUIRED",
    });
  });

  it("uses the MFA timestamp from the exact authenticated session", async () => {
    const mfaVerifiedAt = new Date("2026-07-12T10:00:00.000Z");
    mocks.limit.mockResolvedValueOnce([{ mfaVerifiedAt }]);
    mocks.authorizePrivilegedAction.mockReturnValueOnce({ allowed: true, code: "AUTHORIZED" });

    await expect(authorizeLifecycleAdmin({
      actorUserId: "admin-1",
      actorSessionId: "session-1",
      actorRole: "admin",
      reason: "Export requested for learner support",
      action: "data.export",
    })).resolves.toEqual({ allowed: true, code: "AUTHORIZED" });

    expect(mocks.where).toHaveBeenCalledTimes(1);
    expect(mocks.limit).toHaveBeenCalledWith(1);
    expect(mocks.authorizePrivilegedAction).toHaveBeenCalledWith({
      actorRole: "admin",
      mfaVerifiedAt,
      reason: "Export requested for learner support",
      action: "data.export",
    });
  });

  it("fails closed when the claimed session row does not exist", async () => {
    await authorizeLifecycleAdmin({
      actorUserId: "admin-1",
      actorSessionId: "wrong-session",
      actorRole: "admin",
      reason: "Confirmed learner account deletion",
      action: "account.delete",
    });
    expect(mocks.authorizePrivilegedAction).toHaveBeenCalledWith(expect.objectContaining({
      mfaVerifiedAt: undefined,
      action: "account.delete",
    }));
  });
});
