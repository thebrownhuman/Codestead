import { readBoundedJson } from "@/lib/http/bounded-json";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireAuth } from "@/lib/http/authz";
import { hasCredentialPassword, preservePasswordChangeSession } from "@/lib/security/password-settings";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { BREACHED_PASSWORD_MESSAGE, isBreachedPasswordError } from "@/lib/security/breached-passwords";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128) })
  .strict().refine((body) => body.currentPassword !== body.newPassword);
const noStore = { "Cache-Control": "private, no-store" };
function failure(status: number, error = "Password change could not be completed.") {
  return NextResponse.json({ error }, { status, headers: noStore });
}
export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const current = authz.session;
  const userId = authz.session.user.id;
  return withRateLimit({ policy: "forced_password_change_user", identity: { kind: "user", value: userId } }, async () => {
    const jsonBody = await readBoundedJson(request);
    if (jsonBody.response?.status === 413) return jsonBody.response;
    const parsed = bodySchema.safeParse(jsonBody.value);
    if (!parsed.success) return failure(400, "Use a different new password with 12 to 128 characters.");
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
      const result = await auth.api.changePassword({ headers: request.headers, body: { ...parsed.data, revokeOtherSessions: true }, asResponse: true });
      if (!result.ok) {
        await audit("denied");
        const body = await result.json().catch(() => null);
        if (body?.code === "PASSWORD_COMPROMISED") return NextResponse.json({ code: "PASSWORD_COMPROMISED", error: BREACHED_PASSWORD_MESSAGE }, { status: 400, headers: noStore });
        return failure(result.status >= 500 ? 503 : 400);
      }
      changed = true;
      replacementCookies = result.headers.getSetCookie();
      const body = await result.json();
      if (typeof body.token !== "string" || !body.token) throw new Error("No replacement session.");
      await preservePasswordChangeSession(current, body.token);
      await audit("success");
      const response = NextResponse.json({ ok: true }, { headers: noStore });
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
      if (isBreachedPasswordError(error)) return NextResponse.json({ code: "PASSWORD_COMPROMISED", error: BREACHED_PASSWORD_MESSAGE }, { status: 400, headers: noStore });
      if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400) return failure(400);
      return failure(503);
    }
  });
}
