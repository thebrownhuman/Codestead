import { NextRequest } from "next/server";
import { z } from "zod";

import { authorizeCurriculumAdmin } from "@/app/api/admin/curriculum/authorization";
import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { requireAdmin } from "@/lib/http/authz";
import {
  listAdminModuleProjectTemplates,
  ModuleProjectError,
  syncModuleProjectTemplates,
} from "@/lib/projects/module-project-service";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const syncSchema = z.object({ requestId: z.uuid(), reason: z.string().trim().min(20).max(500) }).strict();

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return adminJson({ templates: await listAdminModuleProjectTemplates() });
}

export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const parsed = syncSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return adminJson({ error: "INVALID_REQUEST" }, 400);
    const gate = await authorizeCurriculumAdmin({
      actorUserId: authz.session.user.id,
      sessionId: authz.session.session.id,
      actorRole: authz.account.role,
      reason: parsed.data.reason,
      action: "curriculum.stage",
    });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    try {
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        action: "module_project.sync",
        resourceType: "module_project_catalog",
        reason: parsed.data.reason,
        outcome: "allowed",
        correlationId: parsed.data.requestId,
        metadata: { phase: "pre_mutation" },
      });
    } catch {
      return adminJson({ error: "Module-project synchronization protection is temporarily unavailable." }, 503);
    }
    let report: Awaited<ReturnType<typeof syncModuleProjectTemplates>>;
    try {
      report = await syncModuleProjectTemplates();
    } catch (error) {
      const code = error instanceof ModuleProjectError ? error.code : "MODULE_PROJECT_SYNC_FAILED";
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        action: "module_project.sync",
        resourceType: "module_project_catalog",
        reason: parsed.data.reason,
        outcome: "failure",
        correlationId: parsed.data.requestId,
        metadata: { errorCode: code },
      }).catch(() => undefined);
      return adminJson({ error: code }, code === "NOT_FOUND" ? 404 : 409);
    }
    const completionAuditRecorded = await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "module_project.sync",
      resourceType: "module_project_catalog",
      reason: parsed.data.reason,
      outcome: "success",
      correlationId: parsed.data.requestId,
      metadata: { ...report, requestId: parsed.data.requestId },
    }).then(() => true).catch(() => false);
    return adminJson({
      report,
      completionAuditRecorded,
      ...(completionAuditRecorded ? {} : {
        warning: "The catalog synchronization completed, but its completion audit needs operator reconciliation. Do not repeat the request.",
      }),
    });
  });
}
