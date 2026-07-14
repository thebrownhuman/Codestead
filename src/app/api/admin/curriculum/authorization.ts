import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { authorizePrivilegedAction, type PrivilegedAction } from "@/lib/security/privileged-access";

export async function authorizeCurriculumAdmin(input: {
  readonly actorUserId: string;
  readonly sessionId: string;
  readonly actorRole: string | null;
  readonly reason: string;
  readonly action: PrivilegedAction;
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
    action: input.action,
  });
}

export function curriculumErrorStatus(code: string): number {
  if (code === "ADMIN_REQUIRED") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "INVALID_REQUEST" || code === "HUMAN_APPROVAL_BLOCKED") return 400;
  return 409;
}
