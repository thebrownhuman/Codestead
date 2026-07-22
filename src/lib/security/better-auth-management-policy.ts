export type RawBetterAuthAction =
  | "pass-through"
  | "deny"
  | "google-social-sign-in"
  | "initial-totp-enrollment";

const ALLOWED_GET_PATHS = new Set([
  "/get-session",
  "/verify-email",
  "/callback/google",
  "/error",
]);

const ALLOWED_POST_PATHS = new Set([
  "/sign-in/email",
  "/sign-out",
  "/request-password-reset",
  "/reset-password",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

function rawAuthPath(requestUrl: string) {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return null;
  }
  const prefix = "/api/auth";
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length);
}

/**
 * Better Auth exposes a much larger endpoint inventory than Codestead uses.
 * This classifier is deliberately method-aware and default-deny: upgrading the
 * dependency cannot expose a new route until the application explicitly adds
 * and tests that exact method/path pair.
 */
export function classifyRawBetterAuthRequest(
  method: string,
  requestUrl: string,
): RawBetterAuthAction {
  const path = rawAuthPath(requestUrl);
  if (!path) return "deny";

  if (method === "GET") {
    if (ALLOWED_GET_PATHS.has(path)) return "pass-through";
    if (/^\/reset-password\/[A-Za-z0-9_-]+$/.test(path)) return "pass-through";
    return "deny";
  }

  if (method !== "POST") return "deny";
  if (path === "/two-factor/enable") return "initial-totp-enrollment";
  if (path === "/sign-in/social") return "google-social-sign-in";
  return ALLOWED_POST_PATHS.has(path) ? "pass-through" : "deny";
}

export function mayBeginInitialTotpEnrollment(input: {
  readonly status: string | null | undefined;
  readonly twoFactorEnabled: boolean | null | undefined;
  readonly factorPresent: boolean;
  readonly factorVerified: boolean | null | undefined;
}) {
  return (
    input.status === "pending" &&
    input.twoFactorEnabled === false &&
    (!input.factorPresent || input.factorVerified === false)
  );
}