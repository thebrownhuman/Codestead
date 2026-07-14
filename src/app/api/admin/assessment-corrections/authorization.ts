import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";

export async function authorizeAssessmentCorrection(input: {
  readonly actorUserId: string;
  readonly sessionId: string;
  readonly actorRole: string | null;
  readonly reason: string;
}) {
  const [bound] = await db
    .select({ mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(and(eq(session.id, input.sessionId), eq(session.userId, input.actorUserId)))
    .limit(1);
  return authorizePrivilegedAction({
    actorRole: input.actorRole,
    mfaVerifiedAt: bound?.mfaVerifiedAt,
    reason: input.reason,
    action: "assessment.regrade",
  });
}
