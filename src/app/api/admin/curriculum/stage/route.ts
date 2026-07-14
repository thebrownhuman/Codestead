import { type NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { CurriculumStagingError, stageFilesystemCurriculum } from "@/lib/curriculum-publication/staging";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

import { authorizeCurriculumAdmin, curriculumErrorStatus } from "../authorization";

const schema = z.object({ requestId: z.uuid(), reason: z.string().trim().min(20).max(500) }).strict();

export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) return adminJson({ error: "A request id and specific staging reason are required." }, 400);
    const gate = await authorizeCurriculumAdmin({ actorUserId: authz.session.user.id, sessionId: authz.session.session.id, actorRole: authz.account.role, reason: body.data.reason, action: "curriculum.stage" });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.stage", resourceType: "curriculum_catalog", reason: body.data.reason, outcome: "allowed", metadata: { phase: "pre_mutation" } });
    try {
      const report = await stageFilesystemCurriculum({ actorUserId: authz.session.user.id, ...body.data });
      const completionAuditRecorded = await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.stage", resourceType: "curriculum_catalog", reason: body.data.reason, outcome: "success", metadata: { courses: report.courses, artifacts: report.artifacts, aiAssistedArtifacts: report.aiAssistedArtifacts } }).then(() => true).catch(() => false);
      return adminJson({ report, completionAuditRecorded, ...(completionAuditRecorded ? {} : { warning: "Staging completed; completion audit needs reconciliation." }) });
    } catch (error) {
      const code = error instanceof CurriculumStagingError ? error.code : "STAGING_FAILED";
      await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.stage", resourceType: "curriculum_catalog", reason: body.data.reason, outcome: "failure", metadata: { errorCode: code } }).catch(() => undefined);
      return adminJson({ error: code }, curriculumErrorStatus(code));
    }
  });
}
