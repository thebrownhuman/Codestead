import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));

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

  it("rejects when no matching authority row is locked", async () => {
    const { deps, tx } = dependencies();
    tx.lockAuthority.mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof tx.lockAuthority>>);

    await expect(completeForcedPasswordChange({
      userId: "ghost-user",
      currentPassword: "temporary-password",
      newPassword: "independent-new-password",
    }, deps)).resolves.toBe("invalid");
    expect(tx.listSessions).not.toHaveBeenCalled();
  });

  it("skips archive and delete calls when there are no live sessions", async () => {
    const { deps, tx } = dependencies();
    tx.listSessions.mockResolvedValueOnce([]);

    await expect(completeForcedPasswordChange({
      userId: "admin-1",
      currentPassword: "temporary-password",
      newPassword: "independent-new-password",
    }, deps)).resolves.toBe("changed");

    expect(tx.archiveSessions).toHaveBeenCalledWith([]);
    expect(tx.deleteSessions).toHaveBeenCalledWith("admin-1", []);
  });

  it("throws when the requirement flag was already cleared by another actor", async () => {
    const { deps, tx } = dependencies();
    tx.clearRequirement.mockResolvedValueOnce(false);

    await expect(completeForcedPasswordChange({
      userId: "admin-1",
      currentPassword: "temporary-password",
      newPassword: "independent-new-password",
    }, deps)).rejects.toThrow("Password change authority changed during rotation.");
  });
});

function chainable<T>(result: T) {
  const node: Record<string, unknown> = {
    from: () => node,
    where: () => node,
    limit: () => node,
    for: () => node,
    set: () => node,
    values: () => node,
    onConflictDoNothing: () => Promise.resolve(undefined),
    returning: () => Promise.resolve(result),
    then: (resolve: (value: T) => unknown) => Promise.resolve(result).then(resolve),
  };
  return node;
}

describe("productionDependencies transaction wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  function fakeTx(handlers: {
    ownerRow?: { mustChangePassword: boolean }[];
    credentialRow?: { id: string; password: string | null }[];
    sessions?: unknown[];
    clearedRow?: { id: string }[];
  }) {
    const inserted: unknown[] = [];
    const deleted: unknown[] = [];
    let selectCall = 0;
    return {
      select: () => {
        selectCall += 1;
        if (selectCall === 1) return chainable(handlers.ownerRow ?? []);
        if (selectCall === 2) return chainable(handlers.credentialRow ?? []);
        return chainable(handlers.sessions ?? []);
      },
      insert: () => ({
        values: (rows: unknown) => {
          inserted.push(rows);
          return chainable(undefined);
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve(handlers.clearedRow ?? []),
          }),
        }),
      }),
      delete: () => ({
        where: (predicate: unknown) => {
          deleted.push(predicate);
          return Promise.resolve(undefined);
        },
      }),
      inserted,
      deleted,
    };
  }

  it("returns invalid when the user row does not exist", async () => {
    const tx = fakeTx({ ownerRow: [] });
    mocks.transaction.mockImplementationOnce((op: (tx: unknown) => unknown) => op(tx));

    await expect(completeForcedPasswordChange({
      userId: "missing-user",
      currentPassword: "temporary-password",
      newPassword: "independent-new-password",
    })).resolves.toBe("invalid");
  });

  it("returns invalid when the credential account has no password", async () => {
    const tx = fakeTx({
      ownerRow: [{ mustChangePassword: true }],
      credentialRow: [{ id: "credential-1", password: null }],
    });
    mocks.transaction.mockImplementationOnce((op: (tx: unknown) => unknown) => op(tx));

    await expect(completeForcedPasswordChange({
      userId: "admin-1",
      currentPassword: "temporary-password",
      newPassword: "independent-new-password",
    })).resolves.toBe("invalid");
  });
});