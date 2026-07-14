import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { requireAdmin } from "@/lib/http/authz";
import {
  getProjectReviewCorrection,
  ProjectReviewCorrectionError,
} from "@/lib/projects/review-correction-service";
import { writeAuditEvent } from "@/lib/security/audit-writer";

export async function GET(
  _request: Request,
  context: { params: Promise<{ correctionId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { correctionId } = await context.params;
  if (!z.uuid().safeParse(correctionId).success) return adminJson({ error: "Correction not found." }, 404);
  try {
    const detail = await getProjectReviewCorrection(correctionId);
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      subjectUserId: detail.correction.userId,
      action: "project_review.correction_read",
      resourceType: "project_review_correction",
      resourceId: correctionId,
      reason: "Corrective project-review evidence inspection",
      outcome: "success",
      metadata: {
        status: detail.correction.status,
        evidenceHashValid: detail.correction.evidenceHashValid,
      },
    });
    return adminJson({ detail });
  } catch (error) {
    if (error instanceof ProjectReviewCorrectionError && error.code === "REVIEW_NOT_FOUND") {
      return adminJson({ error: "Correction not found." }, 404);
    }
    return adminJson({ error: "Correction evidence could not be loaded or audited." }, 503);
  }
}
