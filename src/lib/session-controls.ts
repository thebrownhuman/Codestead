import { and, desc, eq, gt, inArray, isNull, lte, ne } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  authSessionHistory,
  session,
  sessionRevocationRequest,
  user,
} from "@/lib/db/schema";

const RECENT_SESSION_LIMIT = 20;

export type SessionEndReason =
  | "learner_logout"
  | "learner_logout_others"
  | "admin_revoked"
  | "lost_device_approved"
  | "password_reset"
  | "expired";

export function describeUserAgent(value: string | null | undefined) {
  if (!value) return "Unknown browser";
  const browser = /Edg\//.test(value)
    ? "Edge"
    : /Firefox\//.test(value)
      ? "Firefox"
      : /CriOS\//.test(value)
        ? "Chrome"
        : /Chrome\//.test(value)
          ? "Chrome"
          : /Safari\//.test(value)
            ? "Safari"
            : "Browser";
  const platform = /iPad|iPhone/.test(value)
    ? "iOS/iPadOS"
    : /Android/.test(value)
      ? "Android"
      : /Windows/.test(value)
        ? "Windows"
        : /Macintosh|Mac OS X/.test(value)
          ? "macOS"
          : /Linux/.test(value)
            ? "Linux"
            : "unknown OS";
  return `${browser} on ${platform}`;
}

export function boundedUserAgent(value: string | null | undefined) {
  return value?.replace(/[\r\n\0]/g, " ").slice(0, 512) || null;
}

export function sessionScopeFilter(input: {
  userId: string;
  currentSessionId: string;
  scope: "all" | "others";
}) {
  return input.scope === "others"
    ? and(eq(session.userId, input.userId), ne(session.id, input.currentSessionId))
    : eq(session.userId, input.userId);
}

export async function listSessionControls(
  userId: string,
  currentSessionId: string,
  now = new Date(),
) {
  await db
    .update(session)
    .set({ lastSeenAt: now })
    .where(and(eq(session.id, currentSessionId), eq(session.userId, userId)));

  const [liveRows, historyRows, requestRows] = await Promise.all([
    db
      .select({
        id: session.id,
        deviceLabel: session.deviceLabel,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        revocationReason: session.revocationReason,
      })
      .from(session)
      .where(eq(session.userId, userId))
      .orderBy(desc(session.lastSeenAt))
      .limit(RECENT_SESSION_LIMIT),
    db
      .select({
        id: authSessionHistory.originalSessionId,
        deviceLabel: authSessionHistory.deviceLabel,
        userAgent: authSessionHistory.userAgent,
        createdAt: authSessionHistory.startedAt,
        lastSeenAt: authSessionHistory.lastSeenAt,
        expiresAt: authSessionHistory.expiresAt,
        endedAt: authSessionHistory.endedAt,
        endReason: authSessionHistory.endReason,
      })
      .from(authSessionHistory)
      .where(eq(authSessionHistory.userId, userId))
      .orderBy(desc(authSessionHistory.endedAt))
      .limit(RECENT_SESSION_LIMIT),
    db
      .select({
        id: sessionRevocationRequest.id,
        sessionId: sessionRevocationRequest.sessionId,
        reason: sessionRevocationRequest.reason,
        requestChannel: sessionRevocationRequest.requestChannel,
        identityVerifiedAt: sessionRevocationRequest.identityVerifiedAt,
        status: sessionRevocationRequest.status,
        decisionReason: sessionRevocationRequest.decisionReason,
        createdAt: sessionRevocationRequest.createdAt,
        decidedAt: sessionRevocationRequest.decidedAt,
      })
      .from(sessionRevocationRequest)
      .where(eq(sessionRevocationRequest.userId, userId))
      .orderBy(desc(sessionRevocationRequest.createdAt))
      .limit(20),
  ]);

  const live = liveRows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    state:
      row.revokedAt !== null
        ? ("revoked" as const)
        : row.expiresAt <= now
          ? ("expired" as const)
          : ("active" as const),
    deviceLabel: row.deviceLabel || describeUserAgent(row.userAgent),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    endedAt: row.revokedAt,
    endReason: row.revocationReason,
  }));
  const seen = new Set(live.map((row) => row.id));
  const history = historyRows
    .filter((row) => !seen.has(row.id))
    .map((row) => ({
      id: row.id,
      current: false,
      state: row.endReason === "expired"
        ? ("expired" as const)
        : ("revoked" as const),
      deviceLabel: row.deviceLabel || describeUserAgent(row.userAgent),
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      endedAt: row.endedAt,
      endReason: row.endReason,
    }));

  return {
    sessions: [...live, ...history]
      .sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime())
      .slice(0, RECENT_SESSION_LIMIT),
    revocationRequests: requestRows,
  };
}

export async function archiveAndDeleteSessions(input: {
  userId: string;
  actorUserId: string;
  currentSessionId: string;
  scope: "all" | "others";
  reason: SessionEndReason;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: session.id,
        deviceLabel: session.deviceLabel,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      })
      .from(session)
      .where(sessionScopeFilter(input));
    if (!rows.length) return [];

    await tx
      .insert(authSessionHistory)
      .values(
        rows.map((row) => ({
          originalSessionId: row.id,
          userId: input.userId,
          deviceLabel: row.deviceLabel,
          userAgent: boundedUserAgent(row.userAgent),
          startedAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          expiresAt: row.expiresAt,
          endedAt: now,
          endReason: row.expiresAt <= now ? "expired" : input.reason,
          revokedByUserId: input.actorUserId,
        })),
      )
      .onConflictDoNothing({ target: authSessionHistory.originalSessionId });
    const ids = rows.map((row) => row.id);
    await tx
      .delete(session)
      .where(and(eq(session.userId, input.userId), inArray(session.id, ids)));
    await tx
      .update(sessionRevocationRequest)
      .set({
        status: input.actorUserId === input.userId ? "withdrawn" : "approved",
        decidedBy: input.actorUserId,
        decisionReason:
          input.actorUserId === input.userId
            ? "The learner ended the requested session."
            : "The requested session was revoked by the administrator.",
        decidedAt: now,
      })
      .where(
        and(
          eq(sessionRevocationRequest.userId, input.userId),
          inArray(sessionRevocationRequest.sessionId, ids),
          eq(sessionRevocationRequest.status, "pending"),
        ),
      );
    return ids;
  });
}

/** Remove expired rows before a new login so the database uniqueness guard
 * represents one live device rather than one historical row. */
export async function archiveExpiredSessions(userId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: session.id,
        deviceLabel: session.deviceLabel,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      })
      .from(session)
      .where(and(eq(session.userId, userId), lte(session.expiresAt, now)));
    if (!rows.length) return 0;
    await tx
      .insert(authSessionHistory)
      .values(rows.map((row) => ({
        originalSessionId: row.id,
        userId,
        deviceLabel: row.deviceLabel,
        userAgent: boundedUserAgent(row.userAgent),
        startedAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        endedAt: now,
        endReason: "expired",
      })))
      .onConflictDoNothing({ target: authSessionHistory.originalSessionId });
    await tx.delete(session).where(
      and(eq(session.userId, userId), inArray(session.id, rows.map((row) => row.id))),
    );
    return rows.length;
  });
}

export async function archiveDeletedSession(input: {
  id: string;
  userId: string;
  deviceLabel?: string | null;
  userAgent?: string | null;
  createdAt: Date;
  updatedAt?: Date;
  expiresAt: Date;
  endReason: SessionEndReason;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  await db
    .insert(authSessionHistory)
    .values({
      originalSessionId: input.id,
      userId: input.userId,
      deviceLabel: input.deviceLabel,
      userAgent: boundedUserAgent(input.userAgent),
      startedAt: input.createdAt,
      lastSeenAt: input.updatedAt ?? input.createdAt,
      expiresAt: input.expiresAt,
      endedAt: now,
      endReason: input.endReason,
      revokedByUserId: input.userId,
    })
    .onConflictDoNothing({ target: authSessionHistory.originalSessionId });
}

export async function revokeOneOwnedSession(input: {
  userId: string;
  sessionId: string;
  actorUserId: string;
  reason: SessionEndReason;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: session.id,
        deviceLabel: session.deviceLabel,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      })
      .from(session)
      .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)))
      .limit(1);
    if (!row) return false;
    await tx
      .insert(authSessionHistory)
      .values({
        originalSessionId: row.id,
        userId: input.userId,
        deviceLabel: row.deviceLabel,
        userAgent: boundedUserAgent(row.userAgent),
        startedAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        endedAt: now,
        endReason: input.reason,
        revokedByUserId: input.actorUserId,
      })
      .onConflictDoNothing({ target: authSessionHistory.originalSessionId });
    await tx
      .delete(session)
      .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)));
    await tx
      .update(sessionRevocationRequest)
      .set({
        status: input.actorUserId === input.userId ? "withdrawn" : "approved",
        decidedBy: input.actorUserId,
        decisionReason:
          input.actorUserId === input.userId
            ? "The learner ended the requested session."
            : "The requested session was revoked by the administrator.",
        decidedAt: now,
      })
      .where(
        and(
          eq(sessionRevocationRequest.userId, input.userId),
          eq(sessionRevocationRequest.sessionId, input.sessionId),
          eq(sessionRevocationRequest.status, "pending"),
        ),
      );
    return true;
  });
}

export async function createRevocationRequest(input: {
  userId: string;
  sessionId: string;
  reason: string;
}) {
  const [owned] = await db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.id, input.sessionId),
        eq(session.userId, input.userId),
        isNull(session.revokedAt),
        gt(session.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!owned) return null;
  const [created] = await db
    .insert(sessionRevocationRequest)
    .values({
      userId: input.userId,
      sessionId: input.sessionId,
      reason: input.reason,
    })
    .onConflictDoNothing()
    .returning({ id: sessionRevocationRequest.id });
  if (created) return created.id;
  const [existing] = await db
    .select({ id: sessionRevocationRequest.id })
    .from(sessionRevocationRequest)
    .where(
      and(
        eq(sessionRevocationRequest.userId, input.userId),
        eq(sessionRevocationRequest.sessionId, input.sessionId),
        eq(sessionRevocationRequest.status, "pending"),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}

export async function learnerExists(learnerId: string) {
  const [record] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, learnerId), eq(user.role, "learner")))
    .limit(1);
  return Boolean(record);
}
