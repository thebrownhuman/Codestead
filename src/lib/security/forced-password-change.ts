import { and, eq, inArray } from "drizzle-orm";
import { hashPassword, verifyPassword } from "better-auth/crypto";

import { db } from "@/lib/db/client";
import { account, authSessionHistory, session, user } from "@/lib/db/schema";
import { boundedUserAgent } from "@/lib/session-controls";

type LockedAuthority = {
  mustChangePassword: boolean;
  credentialId: string;
  passwordHash: string;
};

type LiveSession = {
  id: string;
  token: string;
  deviceLabel: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
};

type ArchivedSession = {
  originalSessionId: string;
  userId: string;
  deviceLabel: string | null;
  userAgent: string | null;
  startedAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  endedAt: Date;
  endReason: "forced_password_change";
  revokedByUserId: string;
};

export interface ForcedPasswordChangeTransaction {
  lockAuthority(userId: string): Promise<LockedAuthority | null>;
  listSessions(userId: string): Promise<LiveSession[]>;
  archiveSessions(rows: ArchivedSession[]): Promise<void>;
  updatePassword(credentialId: string, passwordHash: string): Promise<void>;
  deleteSessions(userId: string, sessionIds: string[]): Promise<void>;
  clearRequirement(userId: string): Promise<boolean>;
}

export type ForcedPasswordChangeResult = "changed" | "invalid" | "not-required";

export interface ForcedPasswordChangeDependencies {
  now(): Date;
  hashPassword(password: string): Promise<string>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
  transaction(operation: (tx: ForcedPasswordChangeTransaction) => Promise<ForcedPasswordChangeResult>): Promise<ForcedPasswordChangeResult>;
}

const productionDependencies: ForcedPasswordChangeDependencies = {
  now: () => new Date(),
  hashPassword,
  verifyPassword: (hash, password) => verifyPassword({ hash, password }),
  transaction: (operation) => db.transaction(async (tx) => operation({
    async lockAuthority(userId) {
      const [owner] = await tx
        .select({ mustChangePassword: user.mustChangePassword })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1)
        .for("update");
      if (!owner) return null;
      const [credential] = await tx
        .select({ id: account.id, password: account.password })
        .from(account)
        .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
        .limit(1)
        .for("update");
      if (!credential?.password) return null;
      return {
        mustChangePassword: owner.mustChangePassword,
        credentialId: credential.id,
        passwordHash: credential.password,
      };
    },
    async listSessions(userId) {
      return tx.select({
        id: session.id,
        token: session.token,
        deviceLabel: session.deviceLabel,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      }).from(session).where(eq(session.userId, userId)).for("update");
    },
    async archiveSessions(rows) {
      if (!rows.length) return;
      await tx.insert(authSessionHistory).values(rows)
        .onConflictDoNothing({ target: authSessionHistory.originalSessionId });
    },
    async updatePassword(credentialId, passwordHash) {
      await tx.update(account).set({ password: passwordHash }).where(eq(account.id, credentialId));
    },
    async deleteSessions(userId, sessionIds) {
      if (!sessionIds.length) return;
      await tx.delete(session).where(and(eq(session.userId, userId), inArray(session.id, sessionIds)));
    },
    async clearRequirement(userId) {
      const [cleared] = await tx.update(user).set({ mustChangePassword: false })
        .where(and(eq(user.id, userId), eq(user.mustChangePassword, true)))
        .returning({ id: user.id });
      return Boolean(cleared);
    },
  })),
};

export async function completeForcedPasswordChange(
  input: { userId: string; currentPassword: string; newPassword: string },
  dependencies: ForcedPasswordChangeDependencies = productionDependencies,
): Promise<ForcedPasswordChangeResult> {
  if (input.currentPassword === input.newPassword) return "invalid";
  const newHash = await dependencies.hashPassword(input.newPassword);
  return dependencies.transaction(async (tx) => {
    const authority = await tx.lockAuthority(input.userId);
    if (!authority) return "invalid";
    if (!authority.mustChangePassword) return "not-required";
    if (!await dependencies.verifyPassword(authority.passwordHash, input.currentPassword)) {
      return "invalid";
    }

    const now = dependencies.now();
    const sessions = await tx.listSessions(input.userId);
    await tx.archiveSessions(sessions.map((row) => ({
      originalSessionId: row.id,
      userId: input.userId,
      deviceLabel: row.deviceLabel,
      userAgent: boundedUserAgent(row.userAgent),
      startedAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      endedAt: now,
      endReason: "forced_password_change",
      revokedByUserId: input.userId,
    })));
    await tx.updatePassword(authority.credentialId, newHash);
    await tx.deleteSessions(input.userId, sessions.map((row) => row.id));
    if (!await tx.clearRequirement(input.userId)) {
      throw new Error("Password change authority changed during rotation.");
    }
    return "changed";
  });
}