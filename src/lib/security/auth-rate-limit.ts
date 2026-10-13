import { isIP } from "node:net";
import type { BetterAuthPlugin } from "better-auth";

import { withRateLimit, type RateLimitPolicy } from "./rate-limit";

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
      const candidate = request.headers.get("cf-connecting-ip")?.trim() ?? "";
      // Node accepts interface-scoped IPv6 literals; proxy IP headers must not.
      const version = candidate.includes("%") ? 0 : isIP(candidate);
      const ip = version === 6 ? new URL(`http://[${candidate}]`).hostname.slice(1, -1)
        : version === 4 ? candidate : "unavailable";
      const response = await withRateLimit({ policy: rule, identity: { kind: "ip", value: ip } },
        async () => new Response(null, { status: 204 }));
      if (response.status === 204) return;
      if (response.status !== 429) return { response };
      return { response: new Response(JSON.stringify({ message: "Too many requests. Please try again later." }), {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "X-Retry-After": response.headers.get("Retry-After") ?? "1" },
      }) };
    },
  } satisfies BetterAuthPlugin;
}
