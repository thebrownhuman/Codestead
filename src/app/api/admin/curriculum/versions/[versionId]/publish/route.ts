import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { CurriculumAdminError, publishCurriculumVersion } from "@/lib/curriculum-publication/admin-service";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

import { authorizeCurriculumAdmin, curriculumErrorStatus } from "../../../authorization";

const schema = z.object({ requestId: z.uuid(), expectedVersion: z.number().int().min(1), targetStage: z.enum(["beta", "verified"]), reason: z.string().trim().min(20).max(500) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const { versionId } = await params;
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!z.uuid().safeParse(versionId).success || !body.success) return adminJson({ error: "Valid candidate, target, version, request id, and reason required." }, 400);
    const gate = await authorizeCurriculumAdmin({ actorUserId: authz.session.user.id, sessionId: authz.session.session.id, actorRole: authz.account.role, reason: body.data.reason, action: "curriculum.publish" });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.publish", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "allowed", metadata: { phase: "pre_mutation", targetStage: body.data.targetStage, expectedVersion: body.data.expectedVersion } });
    try {
      const report = await publishCurriculumVersion({ actorUserId: authz.session.user.id, courseVersionId: versionId, ...body.data });
      const completionAuditRecorded = await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.publish", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "success", metadata: { stage: report.stage, publicationRevision: report.publicationRevision, replayed: report.replayed, gateHash: report.gate.reportHash } }).then(() => true).catch(() => false);
      return adminJson({ report, completionAuditRecorded });
    } catch (error) {
      const code = error instanceof CurriculumAdminError ? error.code : "PUBLISH_FAILED";
      return adminJson({ error: code, ...(error instanceof CurriculumAdminError && error.gate ? { gate: error.gate } : {}) }, curriculumErrorStatus(code));
    }
  });
}
