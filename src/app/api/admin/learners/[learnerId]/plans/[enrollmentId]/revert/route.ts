import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeAdminPlanMutation } from "@/lib/admin-plan/authorization";
import { notifyLearningPlanChanged } from "@/lib/admin-plan/notifications";
import { adminPlanHttpStatus, AdminPlanServiceError, revertLearnerPlanRevision } from "@/lib/admin-plan/service";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  targetRevision: z.number().int().min(1),
  reason: z.string().trim().min(8).max(500),
  effectiveAt: z.iso.datetime({ offset: true }),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ learnerId: string; enrollmentId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const params = await context.params;
  if (!z.uuid().safeParse(params.learnerId).success || !z.uuid().safeParse(params.enrollmentId).success) {
    return NextResponse.json({ error: "Learner or enrollment identifier is invalid." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  return withRateLimit(
    { policy: "plan_revision_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json({ error: "Choose a historical revision and provide an immediate effective time and reason." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
      }
      const gate = await authorizeAdminPlanMutation({
        actorUserId: authz.session.user.id,
        actorRole: authz.account.role,
        sessionId: authz.session.session.id,
        learnerPublicId: params.learnerId,
        enrollmentId: params.enrollmentId,
        reason: parsed.data.reason,
        action: "plan_revision.revert",
      });
      if (!gate.allowed) {
        return NextResponse.json({ error: gate.code, code: gate.code }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
      }
      try {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: gate.learnerUserId ?? undefined,
          action: "plan_revision.revert",
          resourceType: "enrollment",
          resourceId: params.enrollmentId,
          reason: parsed.data.reason,
          outcome: "allowed",
          metadata: {
            learnerPublicId: params.learnerId,
            expectedRevision: parsed.data.expectedRevision,
            targetRevision: parsed.data.targetRevision,
          },
        });
        const result = await revertLearnerPlanRevision({
          actorUserId: authz.session.user.id,
          learnerPublicId: params.learnerId,
          enrollmentId: params.enrollmentId,
          requestId: parsed.data.requestId,
          expectedRevision: parsed.data.expectedRevision,
          targetRevision: parsed.data.targetRevision,
          reason: parsed.data.reason,
          effectiveAt: parsed.data.effectiveAt,
        });
        const [completionAudit, learnerNotice] = await Promise.allSettled([
          writeAuditEvent({
            actorUserId: authz.session.user.id,
            subjectUserId: result.learner.learnerUserId,
            action: "plan_revision.revert",
            resourceType: "plan_revision",
            resourceId: result.revision.id,
            reason: parsed.data.reason,
            outcome: "success",
            metadata: {
              replayed: result.replayed,
              enrollmentId: params.enrollmentId,
              revision: result.revision.revision,
              targetRevision: parsed.data.targetRevision,
              evidencePreserved: true,
              masteryMutation: false,
              prerequisiteBypass: false,
            },
          }),
          notifyLearningPlanChanged({
            learnerUserId: result.learner.learnerUserId,
            courseTitle: result.learner.courseTitle,
            revision: result.revision.revision,
            action: "reverted",
            idempotencySeed: result.revision.id,
          }),
        ]);
        const auditRecorded = completionAudit.status === "fulfilled";
        const learnerNotificationQueued = learnerNotice.status === "fulfilled";
        const warning = !auditRecorded || learnerNotificationQueued === false
          ? "The revert was committed, but an operator must reconcile its completion audit or learner notification."
          : undefined;
        return NextResponse.json(
          {
            revision: result.revision,
            preview: result.preview,
            replayed: result.replayed,
            auditRecorded,
            learnerNotificationQueued,
            warning,
          },
          { status: result.created ? 201 : 200, headers: { "Cache-Control": "private, no-store" } },
        );
      } catch (error) {
        return NextResponse.json(
          {
            error: error instanceof AdminPlanServiceError
              ? error.message
              : "The plan revision could not be reverted.",
            code: error instanceof AdminPlanServiceError ? error.code : undefined,
            preview: error instanceof AdminPlanServiceError ? error.preview : undefined,
          },
          { status: adminPlanHttpStatus(error), headers: { "Cache-Control": "private, no-store" } },
        );
      }
    },
  );
}
