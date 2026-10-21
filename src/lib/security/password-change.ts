import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import type { CurrentAuth } from "@/lib/http/authz";
import { hasCredentialPassword, preservePasswordChangeSession } from "./password-settings";
import { writeAuditEvent } from "./audit-writer";
import { BREACHED_PASSWORD_MESSAGE, isBreachedPasswordError } from "./breached-passwords";
import { clearTrustedDevices, recordPasswordChanged } from "./password-security-events";
import { isFreshMfa } from "./privileged-access";
import { withRateLimit } from "./rate-limit";

/** Same window the fresh-MFA route promises in its `validUntil`. */
export const PASSWORD_CHANGE_MFA_MS = 5 * 60_000;

const noStore = { "Cache-Control": "private, no-store" };
function failure(status: number, error = "Password change could not be completed.") {
  return Response.json({ error }, { status, headers: noStore });
}

type ChangeAccountPasswordInput = {
  current: CurrentAuth;
  headers: Headers;
  passwords: { currentPassword: string; newPassword: string };
};

/**
 * Own password rotation, audit admission, and preservation of session authority.
 * Has its own per-user budget (separate from the forced-change route's) because
 * each attempt is a current-password guess by whoever holds the session.
 */
export async function changeAccountPassword(input: ChangeAccountPasswordInput): Promise<Response> {
  return withRateLimit(
    { policy: "password_change_user", identity: { kind: "user", value: input.current.user.id } },
    () => rotateAccountPassword(input),
  );
}

/** Durable re-read: the cookie/session payload is not freshness authority. */
async function hasFreshPasswordChangeMfa(current: CurrentAuth) {
  const [record] = await db.select({ mfaVerifiedAt: session.mfaVerifiedAt }).from(session)
    .where(and(eq(session.id, current.session.id), eq(session.userId, current.user.id))).limit(1);
  return isFreshMfa(record?.mfaVerifiedAt, new Date(), PASSWORD_CHANGE_MFA_MS);
}

async function rotateAccountPassword(input: ChangeAccountPasswordInput): Promise<Response> {
  const current = input.current;
  const userId = current.user.id;
  let changed = false;
  let replacementCookies: string[] = [];
  const audit = (outcome: "allowed" | "success" | "denied" | "failure") => writeAuditEvent({ actorUserId: userId, action: "account.password_change", resourceType: "user", resourceId: userId, outcome });
  try {
    if (!await hasCredentialPassword(userId)) {
      await audit("denied");
      return failure(403, "Signed in with Google; manage your password at Google.");
    }
    if (current.user.twoFactorEnabled && !await hasFreshPasswordChangeMfa(current)) {
      await writeAuditEvent({ actorUserId: userId, action: "account.password_change", resourceType: "user", resourceId: userId, outcome: "denied", metadata: { denialCode: "FRESH_MFA_REQUIRED" } });
      return Response.json({ code: "FRESH_MFA_REQUIRED", error: "Verify your authenticator before changing your password." }, { status: 403, headers: noStore });
    }
    // Fail closed before mutation if no durable audit trail can be written.
    try { await audit("allowed"); } catch { return failure(503); }
    // This endpoint executes inside Better Auth's context: its password hash
    // runs the configured HIBP plugin. Current password verification is fresh
    // proof of the password; MFA freshness is checked separately above.
    const result = await auth.api.changePassword({ headers: input.headers, body: { ...input.passwords, revokeOtherSessions: true }, asResponse: true });
    if (!result.ok) {
      await audit("denied");
      const body = await result.json().catch(() => null);
      if (body?.code === "PASSWORD_COMPROMISED") return Response.json({ code: "PASSWORD_COMPROMISED", error: BREACHED_PASSWORD_MESSAGE }, { status: 400, headers: noStore });
      return failure(result.status >= 500 ? 503 : 400);
    }
    changed = true;
    replacementCookies = result.headers.getSetCookie();
    const body = await result.json();
    if (typeof body.token !== "string" || !body.token) throw new Error("No replacement session.");
    await preservePasswordChangeSession(current, body.token);
    await audit("success");
    try {
      await clearTrustedDevices(userId);
    } catch {
      console.error("password_change_trusted_device_clear_failed");
    }
    // The success audit row is written above; this adds only the notice.
    await recordPasswordChanged({ userId, kind: "change", audit: false });
    const response = Response.json({ ok: true }, { headers: noStore });
    for (const cookie of replacementCookies) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    try {
      await audit(isBreachedPasswordError(error) || (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400) ? "denied" : "failure");
    } catch {
      // Never include provider errors or password inputs in operational logs.
      console.error("Password change outcome could not be audited.");
    }
    if (changed) {
      const response = failure(503, "Password changed, but confirmation could not be completed. Use your new password if asked to sign in again.");
      // Rotation has already happened. Deliver its HttpOnly cookie even if
      // stamping/confirmation failed, so the new session is not stranded.
      for (const cookie of replacementCookies) response.headers.append("Set-Cookie", cookie);
      return response;
    }
    if (isBreachedPasswordError(error)) return Response.json({ code: "PASSWORD_COMPROMISED", error: BREACHED_PASSWORD_MESSAGE }, { status: 400, headers: noStore });
    if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400) return failure(400);
    return failure(503);
  }
}
