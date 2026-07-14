import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { session, user } from "@/lib/db/schema";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";

export async function authorizeAdminPlanMutation(input: {
  actorUserId: string;
  actorRole: string | null | undefined;
  sessionId: string;
  learnerPublicId: string;
  enrollmentId: string;
  reason: string;
  action: "plan_revision.create" | "plan_revision.revert";
}) {
  const [[authSession], [learner]] = await Promise.all([
    db.select({ mfaVerifiedAt: session.mfaVerifiedAt })
      .from(session)
      .where(eq(session.id, input.sessionId))
      .limit(1),
    db.select({ id: user.id })
      .from(user)
      .where(and(eq(user.publicId, input.learnerPublicId), eq(user.role, "learner")))
      .limit(1),
  ]);
  const gate = authorizePrivilegedAction({
    actorRole: input.actorRole,
    mfaVerifiedAt: authSession?.mfaVerifiedAt,
    reason: input.reason,
    action: "plan.manage",
  });
  if (gate.allowed) return { allowed: true as const, learnerUserId: learner?.id ?? null };
  await writeAuditEvent({
    actorUserId: input.actorUserId,
    subjectUserId: learner?.id,
    action: input.action,
    resourceType: "plan_revision",
    resourceId: input.enrollmentId,
    reason: input.reason,
    outcome: "denied",
    metadata: { denialCode: gate.code, learnerPublicId: input.learnerPublicId },
  });
  return { allowed: false as const, code: gate.code };
}
