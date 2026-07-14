import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { CurriculumAdminError, retireCurriculumVersion } from "@/lib/curriculum-publication/admin-service";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

import { authorizeCurriculumAdmin, curriculumErrorStatus } from "../../../authorization";

const schema = z.object({ requestId: z.uuid(), expectedVersion: z.number().int().min(1), reason: z.string().trim().min(20).max(500) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const { versionId } = await params;
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!z.uuid().safeParse(versionId).success || !body.success) return adminJson({ error: "Valid version and reason required." }, 400);
    const gate = await authorizeCurriculumAdmin({ actorUserId: authz.session.user.id, sessionId: authz.session.session.id, actorRole: authz.account.role, reason: body.data.reason, action: "curriculum.rollback" });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.retire", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "allowed", metadata: { phase: "pre_mutation", expectedVersion: body.data.expectedVersion } });
    try {
      const report = await retireCurriculumVersion({ actorUserId: authz.session.user.id, courseVersionId: versionId, ...body.data });
      const completionAuditRecorded = await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.retire", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "success", metadata: { publicationRevision: report.publicationRevision, replayed: report.replayed } }).then(() => true).catch(() => false);
      return adminJson({ report, completionAuditRecorded });
    } catch (error) {
      const code = error instanceof CurriculumAdminError ? error.code : "RETIRE_FAILED";
      await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.retire", resourceType: "course_version", resourceId: versionId, reason: body.data.reason, outcome: "denied", metadata: { code } }).catch(() => undefined);
      return adminJson({ error: code }, curriculumErrorStatus(code));
    }
  });
}
