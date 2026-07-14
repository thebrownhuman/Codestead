import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { CurriculumAdminError, rollbackCurriculumPointer } from "@/lib/curriculum-publication/admin-service";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

import { authorizeCurriculumAdmin, curriculumErrorStatus } from "../../../authorization";

const schema = z.object({ requestId: z.uuid(), targetCourseVersionId: z.uuid(), expectedPointerVersion: z.number().int().min(1), reason: z.string().trim().min(20).max(500) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ courseId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const { courseId } = await params;
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!z.uuid().safeParse(courseId).success || !body.success) return adminJson({ error: "Valid course, target version, pointer version, and reason required." }, 400);
    const gate = await authorizeCurriculumAdmin({ actorUserId: authz.session.user.id, sessionId: authz.session.session.id, actorRole: authz.account.role, reason: body.data.reason, action: "curriculum.rollback" });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.rollback", resourceType: "course", resourceId: courseId, reason: body.data.reason, outcome: "allowed", metadata: { phase: "pre_mutation", targetCourseVersionId: body.data.targetCourseVersionId, expectedPointerVersion: body.data.expectedPointerVersion } });
    try {
      const report = await rollbackCurriculumPointer({ actorUserId: authz.session.user.id, courseId, ...body.data });
      await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.rollback", resourceType: "course", resourceId: courseId, reason: body.data.reason, outcome: "success", metadata: { currentCourseVersionId: report.currentCourseVersionId, pointerVersion: report.pointerVersion, replayed: report.replayed } });
      return adminJson({ report });
    } catch (error) { const code = error instanceof CurriculumAdminError ? error.code : "ROLLBACK_FAILED"; return adminJson({ error: code }, curriculumErrorStatus(code)); }
  });
}
