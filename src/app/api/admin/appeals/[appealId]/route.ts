import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import {
  AppealAdminError,
  getAdminAppealDetail,
} from "@/lib/appeals/admin-service";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";

export async function GET(
  _request: Request,
  context: { params: Promise<{ appealId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { appealId } = await context.params;
  if (!z.uuid().safeParse(appealId).success) return adminJson({ error: "Appeal not found." }, 404);
  try {
    const detail = await getAdminAppealDetail(appealId);
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      subjectUserId: detail.appeal.userId,
      action: "appeal.read_evidence",
      resourceType: "appeal",
      resourceId: appealId,
      reason: "Appeal adjudication evidence review",
      outcome: "success",
      metadata: {
        category: detail.appeal.category,
        evidenceHashValid: detail.appeal.evidenceHashValid,
      },
    });
    return adminJson({ detail });
  } catch (error) {
    if (error instanceof AppealAdminError && error.code === "APPEAL_NOT_FOUND") {
      return adminJson({ error: "Appeal not found." }, 404);
    }
    return adminJson({ error: "Appeal evidence could not be loaded or audited." }, 503);
  }
}
