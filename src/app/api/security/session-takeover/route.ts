import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { account, twoFactor, user } from "@/lib/db/schema";
import { rateLimitIp, withRateLimit } from "@/lib/security/rate-limit";
import { evaluateRequestOrigin } from "@/lib/security/request-origin-policy";
import {
  consumeSessionTakeoverBudget,
  INTERNAL_TOTP_GRANT_HEADER,
  isTotpCodeUsed,
  issueInternalTotpGrant,
  markTotpCodeUsed,
  recordSessionTakeoverFailure,
  revokeSessionsForTakeover,
} from "@/lib/security/session-takeover";

/**
 * "Sign out my other device and sign in here". Public by necessity (the caller
 * has no session yet), so it re-proves the password with Better Auth's own
 * verifier and a single-use TOTP code before ending the other device's
 * session, then signs this browser in through Better Auth itself.
 */
const bodySchema = z
  .object({
    email: z.email().max(254).transform((value) => value.trim().toLowerCase()),
    password: z.string().min(1).max(256),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();

const noStore = { "Cache-Control": "private, no-store" };
const GENERIC_FAILURE = "Email, password, or authenticator code is incorrect.";
let dummyHash: Promise<string> | null = null;

function fail(message = GENERIC_FAILURE, status = 401) {
  return NextResponse.json({ error: message, code: "SESSION_TAKEOVER_REJECTED" }, { status, headers: noStore });
}

function cookieHeader(response: Response) {
  return response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
}

export async function POST(request: NextRequest) {
  // Always require a same-origin browser request, even without cookies: this
  // endpoint sets session cookies (login CSRF) and ends another session.
  const originHeaders = new Headers(request.headers);
  if (!originHeaders.has("cookie")) originHeaders.set("cookie", "session-takeover=1");
  const origin = evaluateRequestOrigin({
    method: "POST",
    headers: originHeaders,
    appUrl: process.env.APP_URL,
    production: process.env.NODE_ENV === "production",
  });
  if (!origin.allowed) return NextResponse.json({ error: origin.code }, { status: origin.status, headers: noStore });

  return withRateLimit({ policy: "session_takeover_ip", identity: { kind: "ip", value: rateLimitIp(request) } }, async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail("Enter your email, password, and the current six-digit authenticator code.", 400);
    const { email, password, code } = parsed.data;
    return withRateLimit({ policy: "session_takeover_email", identity: { kind: "email", value: email } }, async () => {
      const context = await auth.$context;
      const [candidate] = await db
        .select({
          userId: user.id,
          status: user.status,
          banned: user.banned,
          twoFactorEnabled: user.twoFactorEnabled,
          passwordHash: account.password,
          secret: twoFactor.secret,
          factorVerified: twoFactor.verified,
        })
        .from(user)
        .innerJoin(account, and(eq(account.userId, user.id), eq(account.providerId, "credential")))
        .innerJoin(twoFactor, eq(twoFactor.userId, user.id))
        .where(sql`lower(${user.email}) = ${email}`)
        .limit(1);

      if (!candidate?.passwordHash) {
        // Same verifier work for unknown accounts and accounts without TOTP.
        dummyHash ??= context.password.hash("codestead-session-takeover-dummy-password");
        await context.password.verify({ hash: await dummyHash, password });
        return fail();
      }
      if (!(await consumeSessionTakeoverBudget(candidate.userId))) {
        await recordSessionTakeoverFailure(candidate.userId, "rate_limited");
        return fail("Too many attempts to sign out your other device. Wait a few minutes and try again.", 429);
      }
      const passwordValid = await context.password.verify({ hash: candidate.passwordHash, password });
      const eligible = candidate.status === "active" && !candidate.banned
        && candidate.twoFactorEnabled === true && candidate.factorVerified === true;
      if (!passwordValid || !eligible) {
        await recordSessionTakeoverFailure(candidate.userId, "invalid_credentials");
        return fail();
      }
      let codeValid = false;
      try {
        const secret = await symmetricDecrypt({ key: context.secretConfig, data: candidate.secret });
        codeValid = await createOTP(secret, { period: 30, digits: 6 }).verify(code)
          && !(await isTotpCodeUsed(candidate.userId, code));
      } catch {
        codeValid = false;
      }
      if (!codeValid) {
        await recordSessionTakeoverFailure(candidate.userId, "invalid_code");
        return fail();
      }

      await markTotpCodeUsed(candidate.userId, code);
      await revokeSessionsForTakeover(candidate.userId);

      const forwarded = {
        "user-agent": request.headers.get("user-agent") ?? "",
        ...(request.headers.get("x-forwarded-for") ? { "x-forwarded-for": request.headers.get("x-forwarded-for")! } : {}),
      };
      try {
        const signIn = await auth.api.signInEmail({
          asResponse: true,
          headers: new Headers(forwarded),
          body: { email, password, rememberMe: true },
        });
        const challenge = (await signIn.clone().json().catch(() => null)) as { twoFactorRedirect?: boolean } | null;
        if (!signIn.ok || challenge?.twoFactorRedirect !== true) throw new Error("sign-in did not reach the TOTP challenge");
        const verified = await auth.api.verifyTOTP({
          asResponse: true,
          headers: new Headers({ ...forwarded, cookie: cookieHeader(signIn), [INTERNAL_TOTP_GRANT_HEADER]: issueInternalTotpGrant() }),
          body: { code, trustDevice: true },
        });
        if (!verified.ok) throw new Error("TOTP completion failed");
        const response = NextResponse.json({ ok: true, redirectTo: "/onboarding" }, { headers: noStore });
        for (const line of [...signIn.headers.getSetCookie(), ...verified.headers.getSetCookie()]) {
          response.headers.append("set-cookie", line);
        }
        return response;
      } catch {
        await recordSessionTakeoverFailure(candidate.userId, "signin_after_revoke_failed");
        return fail("Your other device was signed out, but signing in here did not finish. Sign in again.", 503);
      }
    });
  });
}
