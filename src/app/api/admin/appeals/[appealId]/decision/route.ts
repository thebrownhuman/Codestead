import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import {
  AppealAdminError,
  decideAppeal,
  getAppealSubject,
  type AppealDecisionReport,
} from "@/lib/appeals/admin-service";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  decision: z.enum(["needs_learner_input", "upheld", "overturned"]),
  reason: z.string().trim().min(20).max(2000),
  correctiveAction: z.string().trim().min(20).max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "overturned" && !value.correctiveAction) {
    context.addIssue({
      code: "custom",
      path: ["correctiveAction"],
      message: "Overturning requires a corrective action.",
    });
  }
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ appealId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit(
    { policy: "appeal_decision_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { appealId } = await context.params;
      if (!z.uuid().safeParse(appealId).success) return adminJson({ error: "Appeal not found." }, 404);
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return adminJson({ error: "A request id, current version, decision, and specific rationale are required." }, 400);
      }
      const subject = await getAppealSubject(appealId);
      if (!subject) return adminJson({ error: "Appeal not found." }, 404);
      const [adminSession] = await db
        .select({ mfaVerifiedAt: session.mfaVerifiedAt })
        .from(session)
        .where(and(
          eq(session.id, authz.session.session.id),
          eq(session.userId, authz.session.user.id),
        ))
        .limit(1);
      const gate = authorizePrivilegedAction({
        actorRole: authz.account.role,
        mfaVerifiedAt: adminSession?.mfaVerifiedAt,
        reason: body.data.reason,
        action: "appeal.decide",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: subject.user_id,
          action: "appeal.decide",
          resourceType: "appeal",
          resourceId: appealId,
          reason: body.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code, decision: body.data.decision },
        });
        return adminJson({ error: gate.code }, 403);
      }
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: subject.user_id,
        action: "appeal.decide",
        resourceType: "appeal",
        resourceId: appealId,
        reason: body.data.reason,
        outcome: "allowed",
        metadata: {
          decision: body.data.decision,
          expectedVersion: body.data.expectedVersion,
          phase: "pre_mutation",
        },
      });
      let report: AppealDecisionReport;
      try {
        report = await decideAppeal({
          actorUserId: authz.session.user.id,
          appealId,
          ...body.data,
        });
      } catch (error) {
        const code = error instanceof AppealAdminError ? error.code : "APPEAL_DECISION_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: subject.user_id,
          action: "appeal.decide",
          resourceType: "appeal",
          resourceId: appealId,
          reason: body.data.reason,
          outcome: "failure",
          metadata: { errorCode: code, decision: body.data.decision },
        }).catch(() => undefined);
        const status = error instanceof AppealAdminError
          ? error.code === "ADMIN_REQUIRED"
            ? 403
            : error.code === "APPEAL_NOT_FOUND"
              ? 404
              : error.code === "CORRECTIVE_ACTION_REQUIRED"
                ? 400
                : 409
          : 500;
        return adminJson({
          error: error instanceof AppealAdminError
            ? error.code
            : "Appeal decision failed safely. Reload the evidence before retrying.",
        }, status);
      }
      const completionAuditRecorded = await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: report.userId,
        action: "appeal.decide",
        resourceType: "appeal",
        resourceId: appealId,
        reason: body.data.reason,
        outcome: "success",
        metadata: {
          decision: report.decision,
          rowVersion: report.rowVersion,
          replayed: report.replayed,
          correctionPending: report.correctionPending,
          projectReviewCorrectionId: report.projectReviewCorrectionId,
          projectReviewCorrectionStatus: report.projectReviewCorrectionStatus,
          correctionExecution: report.projectReviewCorrectionId ? "durable_worker_queued" : null,
        },
      }).then(() => true).catch(() => false);
      return adminJson({
        report,
        completionAuditRecorded,
        ...(completionAuditRecorded
          ? {}
          : { warning: "Decision completed, but its completion audit needs operator reconciliation." }),
      });
    },
  );
}
