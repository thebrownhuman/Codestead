import { NextRequest } from "next/server";
import { z } from "zod";

import { authorizeCurriculumAdmin } from "@/app/api/admin/curriculum/authorization";
import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { requireAdmin } from "@/lib/http/authz";
import {
  ModuleProjectError,
  transitionModuleProjectTemplate,
} from "@/lib/projects/module-project-service";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const decisionSchema = z.object({
  requestId: z.uuid(),
  targetStage: z.enum(["beta", "verified", "retired"]),
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(20).max(500),
}).strict();

function status(code: string) {
  if (code === "NOT_FOUND") return 404;
  if (code === "INVALID_REQUEST") return 400;
  return 409;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const { templateId } = await params;
    const parsed = decisionSchema.safeParse(await request.json().catch(() => null));
    if (!z.uuid().safeParse(templateId).success || !parsed.success) {
      return adminJson({ error: "INVALID_REQUEST" }, 400);
    }
    const gate = await authorizeCurriculumAdmin({
      actorUserId: authz.session.user.id,
      sessionId: authz.session.session.id,
      actorRole: authz.account.role,
      reason: parsed.data.reason,
      action: parsed.data.targetStage === "verified" ? "curriculum.publish" : "curriculum.review",
    });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    try {
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        action: "module_project.review",
        resourceType: "module_project_template",
        resourceId: templateId,
        reason: parsed.data.reason,
        outcome: "allowed",
        correlationId: parsed.data.requestId,
        metadata: { phase: "pre_mutation", targetStage: parsed.data.targetStage, expectedVersion: parsed.data.expectedVersion },
      });
    } catch {
      return adminJson({ error: "Module-project decision protection is temporarily unavailable." }, 503);
    }
    let result: Awaited<ReturnType<typeof transitionModuleProjectTemplate>>;
    try {
      result = await transitionModuleProjectTemplate({
        actorUserId: authz.session.user.id,
        templateId,
        ...parsed.data,
      });
    } catch (error) {
      const code = error instanceof ModuleProjectError ? error.code : "MODULE_PROJECT_DECISION_FAILED";
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        action: "module_project.review",
        resourceType: "module_project_template",
        resourceId: templateId,
        reason: parsed.data.reason,
        outcome: "failure",
        correlationId: parsed.data.requestId,
        metadata: { targetStage: parsed.data.targetStage, expectedVersion: parsed.data.expectedVersion, errorCode: code },
      }).catch(() => undefined);
      return adminJson({ error: code }, status(code));
    }
    const completionAuditRecorded = await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "module_project.review",
      resourceType: "module_project_template",
      resourceId: templateId,
      reason: parsed.data.reason,
      outcome: "success",
      correlationId: parsed.data.requestId,
      metadata: { targetStage: parsed.data.targetStage, rowVersion: result.rowVersion, replayed: result.replayed },
    }).then(() => true).catch(() => false);
    return adminJson({
      result,
      completionAuditRecorded,
      ...(completionAuditRecorded ? {} : {
        warning: "The template decision completed, but its completion audit needs operator reconciliation. Do not repeat the request.",
      }),
    });
  });
}
