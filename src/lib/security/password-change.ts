import { auth } from "@/lib/auth";
import type { CurrentAuth } from "@/lib/http/authz";
import { hasCredentialPassword, preservePasswordChangeSession } from "./password-settings";
import { writeAuditEvent } from "./audit-writer";
import { BREACHED_PASSWORD_MESSAGE, isBreachedPasswordError } from "./breached-passwords";

const noStore = { "Cache-Control": "private, no-store" };
function failure(status: number, error = "Password change could not be completed.") {
  return Response.json({ error }, { status, headers: noStore });
}

/** Own password rotation, audit admission, and preservation of session authority. */
export async function changeAccountPassword(input: {
  current: CurrentAuth;
  headers: Headers;
  passwords: { currentPassword: string; newPassword: string };
}): Promise<Response> {
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
    // Fail closed before mutation if no durable audit trail can be written.
    try { await audit("allowed"); } catch { return failure(503); }
    // This endpoint executes inside Better Auth's context: its password hash
    // runs the configured HIBP plugin. Current password verification is fresh
    // proof in this request; a cached MFA timestamp is never a substitute.
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
