import { type NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { CurriculumAdminError, reviewCurriculumArtifact } from "@/lib/curriculum-publication/admin-service";
import { curriculumReviewChecklistSchema } from "@/lib/curriculum-publication/contracts";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

import { authorizeCurriculumAdmin, curriculumErrorStatus } from "../../../authorization";

const schema = z.object({
  requestId: z.uuid(), expectedVersion: z.number().int().min(1),
  decision: z.enum(["approved", "changes_requested", "rejected"]),
  checklist: curriculumReviewChecklistSchema,
  reviewedItemIds: z.array(z.string().trim().min(1)).min(1).max(1_000),
  reason: z.string().trim().min(20).max(500),
}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ artifactId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit({ policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } }, async () => {
    const { artifactId } = await params;
    if (!z.uuid().safeParse(artifactId).success) return adminJson({ error: "Artifact not found." }, 404);
    const body = schema.safeParse(await request.json().catch(() => null));
    if (!body.success) return adminJson({ error: "Complete the bounded review checklist, item list, reason, and version." }, 400);
    const gate = await authorizeCurriculumAdmin({ actorUserId: authz.session.user.id, sessionId: authz.session.session.id, actorRole: authz.account.role, reason: body.data.reason, action: "curriculum.review" });
    if (!gate.allowed) return adminJson({ error: gate.code }, 403);
    await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.review", resourceType: "curriculum_artifact", resourceId: artifactId, reason: body.data.reason, outcome: "allowed", metadata: { phase: "pre_mutation", decision: body.data.decision, expectedVersion: body.data.expectedVersion } });
    try {
      const report = await reviewCurriculumArtifact({ actorUserId: authz.session.user.id, artifactId, ...body.data });
      const completionAuditRecorded = await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.review", resourceType: "curriculum_artifact", resourceId: artifactId, reason: body.data.reason, outcome: "success", metadata: { decision: report.decision, rowVersion: report.rowVersion, replayed: report.replayed } }).then(() => true).catch(() => false);
      return adminJson({ report, completionAuditRecorded });
    } catch (error) {
      const code = error instanceof CurriculumAdminError ? error.code : "REVIEW_FAILED";
      return adminJson({ error: code }, curriculumErrorStatus(code));
    }
  });
}
