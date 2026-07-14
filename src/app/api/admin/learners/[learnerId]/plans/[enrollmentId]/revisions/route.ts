import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authorizeAdminPlanMutation } from "@/lib/admin-plan/authorization";
import { notifyLearningPlanChanged } from "@/lib/admin-plan/notifications";
import { AdminPlanValidationError } from "@/lib/admin-plan/plan-revisions";
import {
  adminPlanHttpStatus,
  AdminPlanServiceError,
  createLearnerPlanRevision,
  previewLearnerPlanRevision,
} from "@/lib/admin-plan/service";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), itemId: z.string().trim().min(1).max(500), fromRevision: z.number().int().min(1) }),
  z.object({ type: z.literal("remove"), itemId: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal("move"), itemId: z.string().trim().min(1).max(500), toPosition: z.number().int().min(1).max(10_000) }),
  z.object({ type: z.literal("assign_remediation"), itemId: z.string().trim().min(1).max(500), note: z.string().trim().min(8).max(500) }),
  z.object({
    type: z.literal("set_override"),
    itemId: z.string().trim().min(1).max(500),
    mode: z.enum(["prioritize", "defer", "unlock_requested"]),
    note: z.string().trim().min(8).max(500),
  }),
]);

const bodySchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  reason: z.string().trim().min(8).max(500),
  effectiveAt: z.iso.datetime({ offset: true }),
  previewOnly: z.boolean().default(false),
  operations: z.array(operationSchema).min(1).max(50),
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
        return NextResponse.json(
          { error: "Provide a request id, current revision, immediate effective time, reason, and valid plan operations." },
          { status: 400, headers: { "Cache-Control": "private, no-store" } },
        );
      }
      try {
        if (parsed.data.previewOnly) {
          const result = await previewLearnerPlanRevision({
            actorUserId: authz.session.user.id,
            learnerPublicId: params.learnerId,
            enrollmentId: params.enrollmentId,
            expectedRevision: parsed.data.expectedRevision,
            effectiveAt: parsed.data.effectiveAt,
            operations: parsed.data.operations,
          });
          return NextResponse.json(
            { preview: result.preview, expectedRevision: result.detail.latestRevision },
            { headers: { "Cache-Control": "private, no-store" } },
          );
        }
        const gate = await authorizeAdminPlanMutation({
          actorUserId: authz.session.user.id,
          actorRole: authz.account.role,
          sessionId: authz.session.session.id,
          learnerPublicId: params.learnerId,
          enrollmentId: params.enrollmentId,
          reason: parsed.data.reason,
          action: "plan_revision.create",
        });
        if (!gate.allowed) {
          return NextResponse.json({ error: gate.code, code: gate.code }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
        }
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: gate.learnerUserId ?? undefined,
          action: "plan_revision.create",
          resourceType: "enrollment",
          resourceId: params.enrollmentId,
          reason: parsed.data.reason,
          outcome: "allowed",
          metadata: {
            learnerPublicId: params.learnerId,
            expectedRevision: parsed.data.expectedRevision,
            operationTypes: parsed.data.operations.map((operation) => operation.type),
          },
        });
        const result = await createLearnerPlanRevision({
          actorUserId: authz.session.user.id,
          learnerPublicId: params.learnerId,
          enrollmentId: params.enrollmentId,
          requestId: parsed.data.requestId,
          expectedRevision: parsed.data.expectedRevision,
          reason: parsed.data.reason,
          effectiveAt: parsed.data.effectiveAt,
          operations: parsed.data.operations,
        });
        const [completionAudit, learnerNotice] = await Promise.allSettled([
          writeAuditEvent({
            actorUserId: authz.session.user.id,
            subjectUserId: result.learner.learnerUserId,
            action: "plan_revision.create",
            resourceType: "plan_revision",
            resourceId: result.revision.id,
            reason: parsed.data.reason,
            outcome: "success",
            metadata: {
              replayed: result.replayed,
              enrollmentId: params.enrollmentId,
              revision: result.revision.revision,
              parentId: result.revision.parentId,
              evidencePreserved: true,
              masteryMutation: false,
              prerequisiteBypass: false,
              changes: result.preview ? {
                added: result.preview.diff.added.length,
                removed: result.preview.diff.removed.length,
                moved: result.preview.diff.moved.length,
                changed: result.preview.diff.changed.length,
                downstream: result.preview.impact.downstreamAffected.length,
              } : null,
            },
          }),
          notifyLearningPlanChanged({
            learnerUserId: result.learner.learnerUserId,
            courseTitle: result.learner.courseTitle,
            revision: result.revision.revision,
            action: "updated",
            idempotencySeed: result.revision.id,
          }),
        ]);
        const auditRecorded = completionAudit.status === "fulfilled";
        // The notifier is itself transactionally idempotent. Replaying it is
        // what repairs a prior post-commit outbox failure without duplicating
        // an already durable learner notification.
        const learnerNotificationQueued = learnerNotice.status === "fulfilled";
        const warning = !auditRecorded || learnerNotificationQueued === false
          ? "The revision was committed, but an operator must reconcile its completion audit or learner notification."
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
            error: error instanceof AdminPlanServiceError || error instanceof AdminPlanValidationError
              ? error.message
              : "The plan revision could not be created.",
            code: error instanceof AdminPlanServiceError ? error.code : undefined,
            preview: error instanceof AdminPlanServiceError ? error.preview : undefined,
          },
          { status: adminPlanHttpStatus(error), headers: { "Cache-Control": "private, no-store" } },
        );
      }
    },
  );
}
