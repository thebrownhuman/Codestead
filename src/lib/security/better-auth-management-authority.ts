import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { twoFactor, user } from "@/lib/db/schema";

/**
 * Loads only the durable authority needed for the pending-account enrollment
 * exception. Passing request headers directly keeps this usable at the route
 * boundary without relying on Next's ambient request context.
 */
export async function readInitialTotpEnrollmentAuthority(headers: Headers) {
  const session = await auth.api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session) return null;

  const [authority] = await db
    .select({
      status: user.status,
      twoFactorEnabled: user.twoFactorEnabled,
      factorId: twoFactor.id,
      factorVerified: twoFactor.verified,
    })
    .from(user)
    .leftJoin(twoFactor, eq(twoFactor.userId, user.id))
    .where(eq(user.id, session.user.id))
    .limit(1);
  if (!authority) return null;

  return {
    status: authority.status,
    twoFactorEnabled: authority.twoFactorEnabled,
    factorPresent: typeof authority.factorId === "string",
    factorVerified: authority.factorVerified,
  } as const;
}
