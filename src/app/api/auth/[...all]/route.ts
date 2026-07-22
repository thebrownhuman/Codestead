import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { readInitialTotpEnrollmentAuthority } from "@/lib/security/better-auth-management-authority";
import {
  classifyRawBetterAuthRequest,
  mayBeginInitialTotpEnrollment,
} from "@/lib/security/better-auth-management-policy";

const betterAuthHandlers = toNextJsHandler(auth);

function unavailableSecurityAction() {
  return NextResponse.json(
    { error: "This account security action is unavailable." },
    {
      status: 403,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}

export async function GET(request: Request) {
  return classifyRawBetterAuthRequest(request.method, request.url) === "pass-through"
    ? betterAuthHandlers.GET(request)
    : unavailableSecurityAction();
}

export async function POST(request: Request) {
  const action = classifyRawBetterAuthRequest(request.method, request.url);
  if (action === "pass-through") return betterAuthHandlers.POST(request);
  if (action === "deny") return unavailableSecurityAction();
  if (action === "google-social-sign-in") {
    const body = await request.clone().json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        (body as { provider?: unknown }).provider !== "google") {
      return unavailableSecurityAction();
    }
    return betterAuthHandlers.POST(request);
  }

  // Initial enrollment is the only raw factor mutation allowed. Re-read the
  // durable session/account and factor row; request bodies and cookie claims
  // are never authorization authority for this exception.
  let authority: Awaited<ReturnType<typeof readInitialTotpEnrollmentAuthority>>;
  try {
    authority = await readInitialTotpEnrollmentAuthority(request.headers);
  } catch {
    return unavailableSecurityAction();
  }
  if (!authority || !mayBeginInitialTotpEnrollment(authority)) {
    return unavailableSecurityAction();
  }

  return betterAuthHandlers.POST(request);
}