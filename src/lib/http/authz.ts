import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import { accountMayUseProtectedFeatures } from "@/lib/security/account-policy";
import {
  gateClosedBookCapability,
  type ClosedBookCapability,
} from "@/lib/exams/capability-gate";

export type CurrentAuth = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export async function currentAuth(): Promise<CurrentAuth | null> {
  // Authorization must always re-read the durable session row. Better Auth's
  // five-minute cookie cache is a latency optimization, not revocation
  // authority; without this flag a just-revoked device could keep acting.
  return auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true, disableRefresh: false },
  });
}

export async function requireAuth(
  options: {
    allowPending?: boolean;
    allowMfaChallenge?: boolean;
    closedBookCapability?: ClosedBookCapability;
  } = {},
) {
  const session = await currentAuth();
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    } as const;
  }
  // Better Auth's short cookie cache improves latency, but authorization state
  // (suspension, deletion, role) must be read from the database on every
  // protected request so a revoked account cannot keep acting for five minutes.
  const [account] = await db
    .select({ status: user.status, role: user.role, twoFactorEnabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  const mfaVerifiedAt = (session.session as { mfaVerifiedAt?: Date | string | null }).mfaVerifiedAt;
  const sessionMfaCompleted =
    mfaVerifiedAt instanceof Date
      ? Number.isFinite(mfaVerifiedAt.getTime())
      : typeof mfaVerifiedAt === "string" && Number.isFinite(new Date(mfaVerifiedAt).getTime());
  const mayUseProtectedFeatures = accountMayUseProtectedFeatures(
    account?.status,
    options.allowPending,
    account?.twoFactorEnabled === true,
    sessionMfaCompleted || options.allowMfaChallenge === true,
  );
  if (!mayUseProtectedFeatures) {
    return {
      session: null,
      response: NextResponse.json(
        {
          error: account?.status === "pending"
            ? "Complete account setup before using this feature."
            : account?.status === "active" && account.twoFactorEnabled && !sessionMfaCompleted
              ? "Complete the authenticator challenge before using this feature."
              : "This account is not active.",
          code: account?.status === "pending"
            ? "ACCOUNT_SETUP_REQUIRED"
            : account?.status === "active" && !account.twoFactorEnabled
              ? "MFA_REQUIRED"
              : account?.status === "active" && !sessionMfaCompleted
                ? "MFA_CHALLENGE_REQUIRED"
              : "ACCOUNT_NOT_ACTIVE",
        },
        { status: 403 },
      ),
    } as const;
  }
  if (options.closedBookCapability) {
    const examGate = await gateClosedBookCapability(session.user.id, options.closedBookCapability);
    if (!examGate.allowed) {
      return {
        session: null,
        response: NextResponse.json(
          { error: examGate.message, code: examGate.code },
          {
            status: examGate.status,
            headers: { "Cache-Control": "private, no-store" },
          },
        ),
      } as const;
    }
  }
  return { session, account, response: null } as const;
}

export async function requireAdmin() {
  const result = await requireAuth();
  if (!result.session) return result;
  if (result.account.role !== "admin") {
    return {
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    } as const;
  }
  return result;
}
