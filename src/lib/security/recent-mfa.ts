import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { isFreshMfa } from "@/lib/security/privileged-access";

export type RecentMfaAction =
  | "credential.add"
  | "credential.prefer"
  | "credential.disable"
  | "credential.enable"
  | "credential.test"
  | "credential.replace"
  | "credential.delete";

type RecentMfaResult =
  | { allowed: true }
  | { allowed: false; response: NextResponse };

/**
 * Re-reads the durable session row before a sensitive self-service action.
 * The cookie/session payload is deliberately not treated as freshness
 * authority because it may have been cached before a revocation or re-auth.
 */
export async function requireRecentMfa(input: {
  sessionId: string;
  userId: string;
  action: RecentMfaAction;
  resourceId?: string;
  now?: Date;
}): Promise<RecentMfaResult> {
  const [record] = await db
    .select({ mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)))
    .limit(1);

  if (isFreshMfa(record?.mfaVerifiedAt, input.now)) return { allowed: true };

  await writeAuditEvent({
    actorUserId: input.userId,
    subjectUserId: input.userId,
    action: input.action,
    resourceType: "provider_credential",
    resourceId: input.resourceId,
    outcome: "denied",
    metadata: { denialCode: "FRESH_MFA_REQUIRED" },
  });

  return {
    allowed: false,
    response: NextResponse.json(
      {
        error: "Verify your authenticator before changing provider credentials.",
        code: "FRESH_MFA_REQUIRED",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    ),
  };
}
