import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { CommunityError, listCommunityReports, moderateCommunityContent } from "@/lib/community/service";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const schema = z.object({
  requestId: z.uuid(),
  reportId: z.uuid().nullable().optional(),
  target: z.enum(["post", "reply"]),
  targetId: z.uuid(),
  action: z.enum(["hide", "restore", "delete"]),
  reason: z.string().trim().min(8).max(500),
}).strict();

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit(
    { policy: "community_moderation_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      try { return adminJson({ reports: await listCommunityReports(authz.session!.user.id) }); }
      catch { return adminJson({ error: "Moderation queue is unavailable." }, 503); }
    },
  );
}

export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const body = schema.safeParse(await request.json().catch(() => null));
  if (!body.success) return adminJson({ error: "A target, action, and specific moderation reason are required." }, 400);
  return withRateLimit(
    { policy: "community_moderation_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      if (body.data.action === "delete") {
        let activeSession: { mfaVerifiedAt: Date | null } | undefined;
        try {
          [activeSession] = await db
            .select({ mfaVerifiedAt: session.mfaVerifiedAt })
            .from(session)
            .where(and(
              eq(session.id, authz.session!.session.id),
              eq(session.userId, authz.session!.user.id),
            ))
            .limit(1);
        } catch {
          return adminJson({ error: "Moderation protection is temporarily unavailable." }, 503);
        }
        const gate = authorizePrivilegedAction({
          actorRole: authz.account.role,
          mfaVerifiedAt: activeSession?.mfaVerifiedAt,
          reason: body.data.reason,
          action: "community.moderate.delete",
        });
        if (!gate.allowed) {
          await writeAuditEvent({
            actorUserId: authz.session.user.id,
            action: "community.moderate.delete",
            resourceType: body.data.target,
            resourceId: body.data.targetId,
            reason: body.data.reason,
            outcome: "denied",
            metadata: { reportId: body.data.reportId ?? null, denialCode: gate.code },
          }).catch(() => undefined);
          return adminJson({ error: gate.code }, 403);
        }
        try {
          await writeAuditEvent({
            actorUserId: authz.session.user.id,
            action: "community.moderate.delete",
            resourceType: body.data.target,
            resourceId: body.data.targetId,
            reason: body.data.reason,
            outcome: "allowed",
            metadata: { reportId: body.data.reportId ?? null, phase: "pre_mutation" },
          });
        } catch {
          return adminJson({ error: "Moderation protection is temporarily unavailable." }, 503);
        }
      }
      try {
        const report = await moderateCommunityContent({ actorUserId: authz.session!.user.id, ...body.data });
        const completionAuditRecorded = await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          action: `community.moderate.${body.data.action}`,
          resourceType: body.data.target,
          resourceId: body.data.targetId,
          reason: body.data.reason,
          outcome: "success",
          metadata: { reportId: body.data.reportId ?? null, priorState: report.priorState, resultingState: report.resultingState, replayed: report.replayed },
        }).then(() => true).catch(() => false);
        return adminJson({
          report,
          completionAuditRecorded,
          ...(completionAuditRecorded ? {} : {
            warning: "The moderation action completed, but its completion audit needs operator reconciliation. Do not repeat the request.",
          }),
        });
      } catch (error) {
        const status = error instanceof CommunityError && error.code === "NOT_FOUND" ? 404 : 409;
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          action: `community.moderate.${body.data.action}`,
          resourceType: body.data.target,
          resourceId: body.data.targetId,
          reason: body.data.reason,
          outcome: "failure",
          metadata: {
            reportId: body.data.reportId ?? null,
            errorCode: error instanceof CommunityError ? error.code : "COMMUNITY_MODERATION_FAILED",
          },
        }).catch(() => undefined);
        return adminJson({ error: status === 404 ? "Moderation target not found." : "Moderation action failed safely." }, status);
      }
    },
  );
}
