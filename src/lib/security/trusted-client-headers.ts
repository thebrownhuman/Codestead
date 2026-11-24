import { rateLimitIp } from "@/lib/security/rate-limit";

// Better Auth reads the client IP from cf-connecting-ip only (see ipAddressHeaders in src/lib/auth.ts).
const AUTH_CLIENT_IP_HEADER = "cf-connecting-ip";

/**
 * Headers for an internal Better Auth call made on behalf of the request. Only the
 * trusted proxy IP (the same one rate limits use) and the user agent are forwarded;
 * a client-supplied x-forwarded-for is never passed on, so it cannot spoof the
 * sign-in rate limit or the IP stored on the new session.
 */
export function trustedClientHeaders(request: Request): Headers {
  const headers = new Headers({ "user-agent": request.headers.get("user-agent") ?? "" });
  const ip = rateLimitIp(request);
  if (ip !== "unavailable") headers.set(AUTH_CLIENT_IP_HEADER, ip);
  return headers;
}
