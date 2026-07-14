import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { notifySessionRevoked } from "@/lib/session-notifications";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import {
  describeUserAgent,
  learnerExists,
  revokeOneOwnedSession,
} from "@/lib/session-controls";

import {
  adminJson,
  secureAdminResponse,
} from "@/app/api/admin/dashboard/http";

const bodySchema = z.object({ reason: z.string().trim().min(8).max(500) }).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ learnerId: string; sessionId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { learnerId, sessionId } = await context.params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return adminJson({ error: "A specific reason is required." }, 400);

  const [adminSession] = await db
    .select({ mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(
      and(
        eq(session.id, authz.session.session.id),
        eq(session.userId, authz.session.user.id),
      ),
    )
    .limit(1);
  const gate = authorizePrivilegedAction({
    actorRole: authz.account.role,
    mfaVerifiedAt: adminSession?.mfaVerifiedAt,
    reason: body.data.reason,
    action: "session.revoke",
  });
  if (!gate.allowed) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      subjectUserId: learnerId,
      action: "session.revoke",
      resourceType: "session",
      resourceId: sessionId,
      reason: body.data.reason,
      outcome: "denied",
      metadata: { denialCode: gate.code },
    });
    return adminJson({ error: gate.code }, 403);
  }
  if (!(await learnerExists(learnerId))) {
    return adminJson({ error: "Learner not found." }, 404);
  }
  const [target] = await db
    .select({ deviceLabel: session.deviceLabel, userAgent: session.userAgent })
    .from(session)
    .where(and(eq(session.id, sessionId), eq(session.userId, learnerId)))
    .limit(1);
  if (!target) return adminJson({ error: "Session not found." }, 404);
  await writeAuditEvent({
    actorUserId: authz.session.user.id,
    subjectUserId: learnerId,
    action: "session.revoke",
    resourceType: "session",
    resourceId: sessionId,
    reason: body.data.reason,
    outcome: "allowed",
    metadata: { phase: "pre_mutation" },
  });
  const revoked = await revokeOneOwnedSession({
    userId: learnerId,
    sessionId,
    actorUserId: authz.session.user.id,
    reason: "admin_revoked",
  });
  if (!revoked) return adminJson({ error: "Session not found." }, 404);
  const device = target.deviceLabel || describeUserAgent(target.userAgent);
  await writeAuditEvent({
    actorUserId: authz.session.user.id,
    subjectUserId: learnerId,
    action: "session.revoke",
    resourceType: "session",
    resourceId: sessionId,
    reason: body.data.reason,
    outcome: "success",
    metadata: { deviceLabel: device },
  });
  await notifySessionRevoked({
    userId: learnerId,
    device,
    idempotencySeed: `${sessionId}:${authz.session.user.id}`,
  }).catch(() => undefined);
  return adminJson({ ok: true });
}
