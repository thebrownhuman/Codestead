export type RequestOriginPolicyInput = Readonly<{
  method: string;
  headers: Headers;
  appUrl: string | undefined;
  production: boolean;
}>;

export type RequestOriginDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
    allowed: false;
    status: 403 | 503;
    code: "REQUEST_ORIGIN_REJECTED" | "CANONICAL_ORIGIN_UNAVAILABLE";
  }>;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEVELOPMENT_ORIGIN = "http://localhost:3000";

function canonicalAppOrigin(input: RequestOriginPolicyInput) {
  const configured = input.appUrl ?? (input.production ? undefined : DEVELOPMENT_ORIGIN);
  if (!configured) return null;

  try {
    const parsed = new URL(configured);
    if (parsed.origin !== configured) return null;
    if (input.production ? parsed.protocol !== "https:" : !["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return configured;
  } catch {
    return null;
  }
}

export function evaluateRequestOrigin(input: RequestOriginPolicyInput): RequestOriginDecision {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { allowed: true };

  const cookie = input.headers.get("cookie");
  if (cookie === null) return { allowed: true };

  const canonicalOrigin = canonicalAppOrigin(input);
  if (!canonicalOrigin) {
    return {
      allowed: false,
      status: 503,
      code: "CANONICAL_ORIGIN_UNAVAILABLE",
    };
  }

  const origin = input.headers.get("origin");
  const fetchSite = input.headers.get("sec-fetch-site");
  if (origin !== canonicalOrigin || (fetchSite !== null && fetchSite !== "same-origin")) {
    return {
      allowed: false,
      status: 403,
      code: "REQUEST_ORIGIN_REJECTED",
    };
  }

  return { allowed: true };
}
