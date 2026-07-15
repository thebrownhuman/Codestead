import { createHmac } from "node:crypto";

function namespaceSecret() {
  const configured = process.env.DRAFT_CACHE_NAMESPACE_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim();
  if (configured && Buffer.byteLength(configured, "utf8") >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("DRAFT_CACHE_NAMESPACE_SECRET (or BETTER_AUTH_SECRET) must contain at least 32 bytes.");
  }
  // Domain-separated development fallback. Production can never reach it.
  return "learncoding-development-draft-namespace-only-v1";
}

/**
 * Produces an opaque browser-cache namespace bound to one authenticated
 * account *and* one durable session. Raw user/session identifiers never enter
 * browser storage keys.
 */
export function createDraftCacheNamespace(
  userId: string,
  sessionId: string,
  secret = namespaceSecret(),
) {
  if (!userId.trim() || !sessionId.trim()) throw new Error("A user and session are required.");
  return createHmac("sha256", secret)
    .update("learncoding-draft-cache-v1\0")
    .update(userId)
    .update("\0")
    .update(sessionId)
    .digest("base64url");
}

export const createBrowserDurabilityNamespace = createDraftCacheNamespace;
