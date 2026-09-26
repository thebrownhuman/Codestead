import { type NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { approveCurriculumArtifactsAsOwner, CurriculumAdminError } from "@/lib/curriculum-publication/admin-service";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

import { authorizeCurriculumAdmin, curriculumErrorStatus } from "../../../authorization";

const schema = z.object({
  requestId: z.uuid(),
  // Omit to approve every artifact of the version.
  artifactIds: z.array(z.uuid()).min(1).max(2_000).optional(),
  reason: z.string().trim().min(8).max(500),
}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const { versionId } = await params;
    if (!z.uuid().safeParse(versionId).success) return adminJson({ error: "Course version not found." }, 404);
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) return adminJson({ error: "Provide a request id, a reason, and optional artifact ids." }, 400);
    const gate = await authorizeCurriculumAdmin({ actorUserId: authz.session.user.id, sessionId: authz.session.session.id, actorRole: authz.account.role, reason: body.data.reason, action: "curriculum.review" });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    const scope = body.data.artifactIds ? "selected" : "all";
    await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.owner_approve", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "allowed", metadata: { phase: "pre_mutation", scope, requested: body.data.artifactIds?.length ?? null } });
    try {
      const report = await approveCurriculumArtifactsAsOwner({ actorUserId: authz.session.user.id, courseVersionId: versionId, ...body.data });
      const completionAuditRecorded = await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.owner_approve", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "success", metadata: { scope, approvedCount: report.approvedCount, alreadyApprovedCount: report.alreadyApprovedCount } }).then(() => true).catch(() => false);
      return adminJson({ report, completionAuditRecorded });
    } catch (error) {
      const code = error instanceof CurriculumAdminError ? error.code : "APPROVAL_FAILED";
      return adminJson({ error: code }, curriculumErrorStatus(code));
    }
  });
}
