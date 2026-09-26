import { and, eq, gt, isNull } from "drizzle-orm";
import { APIError } from "better-auth/api";

import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { archiveAndDeleteSessions } from "@/lib/session-controls";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";
import {
  ACTIVE_SESSION_ELSEWHERE,
  SESSION_TAKEOVER_HEADER,
} from "@/lib/security/session-takeover-constants";

/**
 * One-active-device takeover. A learner blocked by the single-session rule may
 * end the other device only by completing a fresh authenticator (TOTP) check
 * in the same request that creates the new session. Password alone, backup
 * codes and social sign-in never take over; those users keep the audited
 * lost-device flow (mailbox proof + administrator approval).
 */
export { ACTIVE_SESSION_ELSEWHERE, SESSION_TAKEOVER_HEADER };
export const ACTIVE_SESSION_ELSEWHERE_MESSAGE = "You're signed in on another device.";
export const SESSION_TAKEOVER_RATE_LIMITED = "SESSION_TAKEOVER_RATE_LIMITED";

export const TAKEOVER_PATH = "/two-factor/verify-totp";
/** Second-factor endpoints that consume a challenge or code before creating a session. */
export const SECOND_FACTOR_PATHS: readonly string[] = [
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
];

type HeaderSource = { get(name: string): string | null } | null | undefined;

export function wantsSessionTakeover(path: string | undefined, headers: HeaderSource) {
  return path === TAKEOVER_PATH && headers?.get(SESSION_TAKEOVER_HEADER) === "1";
}

export function activeSessionElsewhereError() {
  return new APIError("CONFLICT", {
    code: ACTIVE_SESSION_ELSEWHERE,
    message: ACTIVE_SESSION_ELSEWHERE_MESSAGE,
  });
}

export async function hasActiveSession(userId: string, now = new Date()) {
  const [active] = await db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.userId, userId),
        isNull(session.revokedAt),
        gt(session.expiresAt, now),
      ),
    )
    .limit(1);
  return Boolean(active);
}

/** Per-account budget for takeover attempts, independent of IP. */
export async function consumeSessionTakeoverBudget(userId: string) {
  const response = await withRateLimit(
    { policy: "session_takeover_user", identity: { kind: "user", value: userId } },
    async () => new Response(null, { status: 204 }),
  );
  return response.status === 204;
}

export function sessionTakeoverRateLimitedError() {
  return new APIError("TOO_MANY_REQUESTS", {
    code: SESSION_TAKEOVER_RATE_LIMITED,
    message: "Too many attempts to sign out your other device. Wait a few minutes and try again.",
  });
}

/**
 * Ends every existing session for the account (archived with history, so the
 * old device is signed out cleanly on its next request) and records the audit
 * event. Called only after the authenticator code in this request was valid.
 */
export async function revokeSessionsForTakeover(userId: string, now = new Date()) {
  const revoked = await archiveAndDeleteSessions({
    userId,
    actorUserId: userId,
    currentSessionId: "",
    scope: "all",
    reason: "signed_in_elsewhere",
    now,
  });
  await writeAuditEvent({
    actorUserId: userId,
    subjectUserId: userId,
    action: "session.takeover",
    resourceType: "session",
    outcome: "success",
    metadata: { revokedSessionCount: revoked.length, factor: "totp" },
  });
  return revoked;
}

export async function recordSessionTakeoverFailure(
  userId: string,
  reason: "invalid_code" | "rate_limited",
) {
  try {
    await writeAuditEvent({
      actorUserId: userId,
      subjectUserId: userId,
      action: "session.takeover",
      resourceType: "session",
      outcome: "failure",
      reason,
      metadata: { factor: "totp" },
    });
  } catch {
    console.error("Session takeover failure could not be audited.");
  }
}
