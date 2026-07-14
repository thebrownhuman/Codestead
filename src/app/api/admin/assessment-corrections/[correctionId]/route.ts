import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import {
  assessmentCorrectionErrorStatus,
  getAssessmentCorrectionDetail,
} from "@/lib/assessment-corrections/admin-service";
import { requireAdmin } from "@/lib/http/authz";

export async function GET(
  _request: Request,
  context: { params: Promise<{ correctionId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { correctionId } = await context.params;
  if (!z.uuid().safeParse(correctionId).success) return adminJson({ error: "Correction not found." }, 404);
  try {
    return adminJson({ detail: await getAssessmentCorrectionDetail(correctionId) });
  } catch (error) {
    return adminJson({ error: error instanceof Error ? error.message : "CORRECTION_DETAIL_FAILED" }, assessmentCorrectionErrorStatus(error));
  }
}
