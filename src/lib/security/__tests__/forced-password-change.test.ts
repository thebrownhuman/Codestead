import { beforeEach, describe, expect, it, vi } from "vitest";

import { completeForcedPasswordChange } from "../forced-password-change";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const sessionRow = {
  id: "session-1",
  token: "raw-session-token-must-not-be-archived",
  deviceLabel: "Chrome on Linux",
  userAgent: "test-agent",
  createdAt: new Date("2029-12-01T00:00:00.000Z"),
  lastSeenAt: new Date("2029-12-31T00:00:00.000Z"),
  expiresAt: new Date("2030-02-01T00:00:00.000Z"),
};

function dependencies() {
  const tx = {
    lockAuthority: vi.fn(async () => ({
      mustChangePassword: true,
      credentialId: "credential-1",
      passwordHash: "old-hash",
    })),
    listSessions: vi.fn(async () => [sessionRow]),
    archiveSessions: vi.fn(async () => undefined),
    updatePassword: vi.fn(async () => undefined),
    deleteSessions: vi.fn(async () => undefined),
    clearRequirement: vi.fn(async () => true),
  };
  const deps = {
    now: () => NOW,
    hashPassword: vi.fn(async () => "new-hash"),
    verifyPassword: vi.fn(async () => true),
    transaction: vi.fn((operation: (value: typeof tx) => Promise<"changed" | "invalid" | "not-required">) => operation(tx)),
  };
  return { deps, tx };
}

describe("forced bootstrap password change", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rotates the credential, archives token-free history, revokes every session, then clears the flag", async () => {
    const { deps, tx } = dependencies();

    await expect(completeForcedPasswordChange({
      userId: "admin-1",
      currentPassword: "temporary-password",
      newPassword: "independent-new-password",
    }, deps)).resolves.toBe("changed");

    expect(deps.verifyPassword).toHaveBeenCalledWith("old-hash", "temporary-password");
    expect(deps.hashPassword).toHaveBeenCalledWith("independent-new-password");
    expect(tx.archiveSessions).toHaveBeenCalledWith([{
      originalSessionId: "session-1",
      userId: "admin-1",
      deviceLabel: "Chrome on Linux",
      userAgent: "test-agent",
      startedAt: sessionRow.createdAt,
      lastSeenAt: sessionRow.lastSeenAt,
      expiresAt: sessionRow.expiresAt,
      endedAt: NOW,
      endReason: "forced_password_change",
      revokedByUserId: "admin-1",
    }]);
    expect(JSON.stringify(tx.archiveSessions.mock.calls)).not.toContain(sessionRow.token);
    expect(tx.updatePassword).toHaveBeenCalledWith("credential-1", "new-hash");
    expect(tx.deleteSessions).toHaveBeenCalledWith("admin-1", ["session-1"]);
    expect(tx.clearRequirement).toHaveBeenCalledWith("admin-1");
    expect(tx.clearRequirement.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.deleteSessions.mock.invocationCallOrder[0]!,
    );
  });

  it("does not mutate authority when the current password is wrong", async () => {
    const { deps, tx } = dependencies();
    deps.verifyPassword.mockResolvedValueOnce(false);

    await expect(completeForcedPasswordChange({
      userId: "admin-1",
      currentPassword: "wrong-password",
      newPassword: "independent-new-password",
    }, deps)).resolves.toBe("invalid");

    expect(tx.archiveSessions).not.toHaveBeenCalled();
    expect(tx.updatePassword).not.toHaveBeenCalled();
    expect(tx.deleteSessions).not.toHaveBeenCalled();
    expect(tx.clearRequirement).not.toHaveBeenCalled();
  });

  it("never clears the flag when any earlier transactional step fails", async () => {
    const { deps, tx } = dependencies();
    tx.deleteSessions.mockRejectedValueOnce(new Error("delete failed"));

    await expect(completeForcedPasswordChange({
      userId: "admin-1",
      currentPassword: "temporary-password",
      newPassword: "independent-new-password",
    }, deps)).rejects.toThrow("delete failed");

    expect(deps.transaction).toHaveBeenCalledOnce();
    expect(tx.clearRequirement).not.toHaveBeenCalled();
  });

  it("refuses reuse and an already-completed rotation", async () => {
    const { deps, tx } = dependencies();
    await expect(completeForcedPasswordChange({
      userId: "admin-1",
      currentPassword: "same-password",
      newPassword: "same-password",
    }, deps)).resolves.toBe("invalid");
    expect(deps.transaction).not.toHaveBeenCalled();

    tx.lockAuthority.mockResolvedValueOnce({
      mustChangePassword: false,
      credentialId: "credential-1",
      passwordHash: "old-hash",
    });
    await expect(completeForcedPasswordChange({
      userId: "admin-1",
      currentPassword: "temporary-password",
      newPassword: "new-password-value",
    }, deps)).resolves.toBe("not-required");
    expect(tx.updatePassword).not.toHaveBeenCalled();
  });
});