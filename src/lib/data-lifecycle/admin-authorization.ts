import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import {
  authorizePrivilegedAction,
  type PrivilegedAction,
} from "@/lib/security/privileged-access";

export async function authorizeLifecycleAdmin(input: {
  actorUserId: string;
  actorSessionId: string;
  actorRole: string | null | undefined;
  reason: string;
  action: Extract<PrivilegedAction, "data.export" | "account.delete">;
}) {
  const [activeSession] = await db
    .select({ mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(
      and(
        eq(session.id, input.actorSessionId),
        eq(session.userId, input.actorUserId),
      ),
    )
    .limit(1);
  return authorizePrivilegedAction({
    actorRole: input.actorRole,
    mfaVerifiedAt: activeSession?.mfaVerifiedAt,
    reason: input.reason,
    action: input.action,
  });
}
