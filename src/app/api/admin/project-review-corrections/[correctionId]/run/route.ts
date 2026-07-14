import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import {
  getProjectReviewCorrection,
  ProjectReviewCorrectionError,
  requestProjectReviewCorrectionRetry,
} from "@/lib/projects/review-correction-service";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  requestId: z.uuid(),
  reason: z.string().trim().min(20).max(500),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ correctionId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit(
    { policy: "appeal_decision_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { correctionId } = await context.params;
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!z.uuid().safeParse(correctionId).success || !body.success) {
        return adminJson({ error: "A correction, request id, and retry reason are required." }, 400);
      }
      const detail = await getProjectReviewCorrection(correctionId).catch(() => null);
      if (!detail) return adminJson({ error: "Correction not found." }, 404);
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
          subjectUserId: detail.correction.userId,
          action: "project_review.correction_retry",
          resourceType: "project_review_correction",
          resourceId: correctionId,
          reason: body.data.reason,
          outcome: "denied",
          correlationId: body.data.requestId,
          metadata: { denialCode: gate.code },
        });
        return adminJson({ error: gate.code }, 403);
      }
      try {
        const report = await requestProjectReviewCorrectionRetry({
          actorUserId: authz.session.user.id,
          correctionId,
          requestId: body.data.requestId,
          reason: body.data.reason,
        });
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: detail.correction.userId,
          action: "project_review.correction_retry",
          resourceType: "project_review_correction",
          resourceId: correctionId,
          reason: body.data.reason,
          outcome: "success",
          correlationId: body.data.requestId,
          metadata: {
            duplicate: report.duplicate,
            status: report.status,
            attemptCount: report.attemptCount,
            correctionExecution: "durable_worker_queued",
          },
        });
        return adminJson({
          report,
          execution: { state: report.status, worker: "project-review-correction-worker" },
        }, report.duplicate ? 200 : 202);
      } catch (error) {
        const code = error instanceof ProjectReviewCorrectionError
          ? error.code
          : "PROJECT_REVIEW_RETRY_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: detail.correction.userId,
          action: "project_review.correction_retry",
          resourceType: "project_review_correction",
          resourceId: correctionId,
          reason: body.data.reason,
          outcome: "failure",
          correlationId: body.data.requestId,
          metadata: { errorCode: code },
        }).catch(() => undefined);
        return adminJson({ error: code }, error instanceof ProjectReviewCorrectionError ? 409 : 500);
      }
    },
  );
}
