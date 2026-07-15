export type RawBetterAuthPostAction =
  | "pass-through"
  | "deny"
  | "initial-totp-enrollment";

const ALWAYS_DENIED_POST_PATHS = new Set([
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
  "/unlink-account",
]);

function normalizedAuthPath(requestUrl: string) {
  const pathname = new URL(requestUrl).pathname;
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    decodedPathname = pathname;
  }
  const compactPathname = decodedPathname
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  const authPrefix = compactPathname.lastIndexOf("/api/auth");
  return authPrefix === -1
    ? compactPathname
    : compactPathname.slice(authPrefix + "/api/auth".length);
}

/**
 * Classifies the small set of Better Auth POSTs that can change or reveal
 * authentication authority. Everything else remains Better Auth-owned.
 */
export function classifyRawBetterAuthPost(requestUrl: string): RawBetterAuthPostAction {
  const path = normalizedAuthPath(requestUrl);
  if (path === "/two-factor/enable") return "initial-totp-enrollment";
  if (ALWAYS_DENIED_POST_PATHS.has(path)) return "deny";
  return "pass-through";
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
