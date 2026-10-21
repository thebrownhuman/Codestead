import { isIP } from "node:net";
import type { BetterAuthPlugin } from "better-auth";

import { withRateLimit, type RateLimitPolicy } from "./rate-limit";
import {
  holdResetRequestFloor,
  markResetRequestStarted,
  NEUTRAL_RESET_REQUEST_BODY,
} from "./reset-request-timing";

// Auth budgets are fixed and fail closed, independent of API policy overrides.
const rules: Record<string, RateLimitPolicy> = {
  "/request-password-reset": { name: "auth_reset_request_ip", limit: 3, windowSeconds: 600, failureMode: "closed" },
  "/reset-password": { name: "auth_reset_password_ip", limit: 6, windowSeconds: 60, failureMode: "closed" },
  "/reset-password/:token": { name: "auth_reset_callback_ip", limit: 10, windowSeconds: 60, failureMode: "closed" },
  "/two-factor/verify-backup-code": { name: "auth_backup_code_ip", limit: 6, windowSeconds: 60, failureMode: "closed" },
  "/sign-in/email": { name: "auth_sign_in_ip", limit: 8, windowSeconds: 60, failureMode: "closed" },
  "/sign-up/email": { name: "auth_sign_up_ip", limit: 3, windowSeconds: 600, failureMode: "closed" },
  "/two-factor/verify-totp": { name: "auth_totp_ip", limit: 6, windowSeconds: 60, failureMode: "closed" },
};

const resetRequestEmailRule: RateLimitPolicy = {
  name: "auth_reset_request_email",
  limit: 5,
  windowSeconds: 24 * 60 * 60,
  failureMode: "closed",
};

function clientIp(request: Request) {
  const candidate = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  // Node accepts interface-scoped IPv6 literals; proxy IP headers must not.
  const version = candidate.includes("%") ? 0 : isIP(candidate);
  return version === 6 ? new URL(`http://[${candidate}]`).hostname.slice(1, -1)
    : version === 4 ? candidate : null;
}

/** Lowercased email from the JSON body, or null when absent/malformed. */
async function requestedEmail(request: Request) {
  try {
    const body: unknown = await request.clone().json();
    const email = body && typeof body === "object" ? (body as { email?: unknown }).email : undefined;
    return typeof email === "string" && email.trim() && email.length <= 254 ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function tooManyRequests(retryAfter: string | null) {
  return new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "X-Retry-After": retryAfter ?? "1" },
  });
}

function protectionUnavailable() {
  return new Response(JSON.stringify({ message: "Request protection is temporarily unavailable." }), {
    status: 503,
    headers: { "Retry-After": "30", "Cache-Control": "private, no-store" },
  });
}

export function atomicAuthRateLimitPlugin(databaseRequired: boolean) {
  return {
    id: "atomic-auth-rate-limit",
    // Run before body validation: malformed requests also spend the budget,
    // and betterAuth(auth.options) retains the admission boundary.
    async onRequest(request: Request, context: { baseURL: string }) {
      if (!databaseRequired) return;
      const basePath = new URL(context.baseURL).pathname.replace(/\/+$/, "");
      const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
      const path = pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
      const rule = rules[/^\/reset-password\/[A-Za-z0-9_-]+$/.test(path) ? "/reset-password/:token" : path];
      if (!rule) return;
      const ip = clientIp(request);
      const isResetRequest = path === "/request-password-reset";
      // Cloudflare always sets cf-connecting-ip. A production reset request
      // without it bypassed the edge; refuse it rather than let every such
      // caller share one bucket that could lock recovery for everyone. Other
      // auth paths keep the shared fallback so LAN/internal callers still work.
      if (!ip && isResetRequest && process.env.NODE_ENV === "production") {
        console.error("auth_reset_request_client_ip_unavailable");
        return { response: protectionUnavailable() };
      }
      if (isResetRequest) markResetRequestStarted(request);
      const response = await withRateLimit({ policy: rule, identity: { kind: "ip", value: ip ?? "unavailable" } },
        async () => new Response(null, { status: 204 }));
      if (response.status === 429) return { response: tooManyRequests(response.headers.get("Retry-After")) };
      if (response.status !== 204) return { response };
      if (!isResetRequest) return;
      const email = await requestedEmail(request);
      if (!email) return;
      // Keyed by the submitted address whether or not an account exists, and
      // answered with the same neutral body, so the budget is not an oracle.
      const emailDecision = await withRateLimit({ policy: resetRequestEmailRule, identity: { kind: "email", value: email } },
        async () => new Response(null, { status: 204 }));
      if (emailDecision.status === 204) return;
      if (emailDecision.status !== 429) return { response: emailDecision };
      await holdResetRequestFloor(request);
      return { response: Response.json(NEUTRAL_RESET_REQUEST_BODY) };
    },
  } satisfies BetterAuthPlugin;
}
