import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import {
  getInactivityPreference,
  NotificationPreferenceError,
  setInactivityPause,
} from "@/lib/notifications/preferences";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const learnerIdSchema = z.uuid();
const bodySchema = z.object({
  expectedVersion: z.number().int().min(0),
  pausedUntil: z.iso.datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(8).max(500),
}).strict();

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { learnerId } = await context.params;
  if (!learnerIdSchema.safeParse(learnerId).success) return adminJson({ error: "Learner identifier is invalid." }, 400);
  const preference = await getInactivityPreference(learnerId);
  return preference ? adminJson(preference) : adminJson({ error: "Learner was not found." }, 404);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit(
    { policy: "notification_pause_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { learnerId } = await context.params;
      if (!learnerIdSchema.safeParse(learnerId).success) return adminJson({ error: "Learner identifier is invalid." }, 400);
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return adminJson({ error: "A version, pause expiry (or null), and specific reason are required." }, 400);
      const [adminSession] = await db
        .select({ mfaVerifiedAt: session.mfaVerifiedAt })
        .from(session)
        .where(and(eq(session.id, authz.session.session.id), eq(session.userId, authz.session.user.id)))
        .limit(1);
      const gate = authorizePrivilegedAction({
        actorRole: authz.account.role,
        mfaVerifiedAt: adminSession?.mfaVerifiedAt,
        reason: body.data.reason,
        action: "notification.pause",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "notification.pause",
          resourceType: "learner_notification_preference",
          resourceId: learnerId,
          reason: body.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code },
        });
        return adminJson({ error: gate.code }, 403);
      }
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        action: "notification.pause",
        resourceType: "learner_notification_preference",
        resourceId: learnerId,
        reason: body.data.reason,
        outcome: "allowed",
        metadata: { phase: "pre_mutation", expectedVersion: body.data.expectedVersion, pauseRequested: body.data.pausedUntil !== null },
      });
      try {
        const preference = await setInactivityPause({
          actorUserId: authz.session.user.id,
          learnerPublicId: learnerId,
          expectedVersion: body.data.expectedVersion,
          pausedUntil: body.data.pausedUntil ? new Date(body.data.pausedUntil) : null,
          reason: body.data.reason,
        });
        let completionAuditRecorded = true;
        try {
          await writeAuditEvent({
            actorUserId: authz.session.user.id,
            action: "notification.pause",
            resourceType: "learner_notification_preference",
            resourceId: learnerId,
            reason: body.data.reason,
            outcome: "success",
            metadata: { resultingVersion: preference.rowVersion, paused: preference.inactivityPausedUntil !== null },
          });
        } catch {
          completionAuditRecorded = false;
        }
        return adminJson({
          ...preference,
          completionAuditRecorded,
          ...(!completionAuditRecorded
            ? { warning: "The pause changed, but its completion audit requires reconciliation; do not repeat the mutation." }
            : {}),
        });
      } catch (error) {
        if (error instanceof NotificationPreferenceError) {
          return adminJson({ error: error.code }, error.status);
        }
        throw error;
      }
    },
  );
}
