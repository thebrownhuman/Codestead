import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { db } from "@/lib/db/client";
import { project, projectReview, session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import {
  listProjectReviewCorrections,
  ProjectReviewCorrectionError,
  queueProjectReviewCorrection,
} from "@/lib/projects/review-correction-service";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const createSchema = z.object({
  requestId: z.uuid(),
  sourceReviewId: z.uuid(),
  reason: z.string().trim().min(20).max(500),
}).strict();

export async function GET(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const scope = request.nextUrl.searchParams.get("scope") === "all" ? "all" : "actionable";
  return adminJson({ corrections: await listProjectReviewCorrections({ scope }) });
}

export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit(
    { policy: "appeal_decision_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = createSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return adminJson({ error: "A review, request id, and specific correction reason are required." }, 400);
      const [subject] = await db
        .select({ userId: project.userId })
        .from(projectReview)
        .innerJoin(project, eq(project.id, projectReview.projectId))
        .where(eq(projectReview.id, body.data.sourceReviewId))
        .limit(1);
      if (!subject) return adminJson({ error: "Project review not found." }, 404);
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
          subjectUserId: subject.userId,
          action: "project_review.correction_queue",
          resourceType: "project_review",
          resourceId: body.data.sourceReviewId,
          reason: body.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code, trigger: "defective_review" },
        });
        return adminJson({ error: gate.code }, 403);
      }
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: subject.userId,
        action: "project_review.correction_queue",
        resourceType: "project_review",
        resourceId: body.data.sourceReviewId,
        reason: body.data.reason,
        outcome: "allowed",
        correlationId: body.data.requestId,
        metadata: { trigger: "defective_review", phase: "pre_mutation" },
      });
      try {
        const queued = await queueProjectReviewCorrection({
          actorUserId: authz.session.user.id,
          sourceReviewId: body.data.sourceReviewId,
          requestId: body.data.requestId,
          reason: body.data.reason,
        });
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: queued.userId,
          action: "project_review.correction_queue",
          resourceType: "project_review_correction",
          resourceId: queued.correctionId,
          reason: body.data.reason,
          outcome: "success",
          correlationId: body.data.requestId,
          metadata: {
            trigger: "defective_review",
            duplicate: queued.duplicate,
            revision: queued.revision,
            correctionExecution: "durable_worker_queued",
          },
        });
        return adminJson({
          correction: queued,
          execution: { state: queued.status, worker: "project-review-correction-worker" },
        }, queued.duplicate ? 200 : 202);
      } catch (error) {
        const code = error instanceof ProjectReviewCorrectionError
          ? error.code
          : "PROJECT_REVIEW_CORRECTION_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: subject.userId,
          action: "project_review.correction_queue",
          resourceType: "project_review",
          resourceId: body.data.sourceReviewId,
          reason: body.data.reason,
          outcome: "failure",
          correlationId: body.data.requestId,
          metadata: { errorCode: code, trigger: "defective_review" },
        }).catch(() => undefined);
        const status = error instanceof ProjectReviewCorrectionError
          ? error.code === "REVIEW_NOT_FOUND"
            ? 404
            : error.code === "ADMIN_REQUIRED"
              ? 403
              : 409
          : 500;
        return adminJson({ error: code }, status);
      }
    },
  );
}
