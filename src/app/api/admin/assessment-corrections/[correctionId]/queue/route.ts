import type { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import {
  assessmentCorrectionErrorStatus,
  queueAssessmentCorrection,
} from "@/lib/assessment-corrections/admin-service";
import { queueCorrectionSchema } from "@/lib/assessment-corrections/contracts";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";

import { authorizeAssessmentCorrection } from "../../authorization";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ correctionId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { correctionId } = await context.params;
  if (!z.uuid().safeParse(correctionId).success) return adminJson({ error: "Correction not found." }, 404);
  const body = queueCorrectionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return adminJson({ error: "Current version, request id, and a specific queue rationale are required." }, 400);
  const gate = await authorizeAssessmentCorrection({
    actorUserId: authz.session.user.id,
    sessionId: authz.session.session.id,
    actorRole: authz.account.role,
    reason: body.data.reason,
  });
  if (!gate.allowed) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "assessment.correction.queue",
      resourceType: "assessment_correction",
      resourceId: correctionId,
      reason: body.data.reason,
      outcome: "denied",
      metadata: { denialCode: gate.code },
    }).catch(() => undefined);
    return adminJson({ error: gate.code }, 403);
  }
  try {
    const report = await queueAssessmentCorrection({
      actorUserId: authz.session.user.id,
      correctionId,
      ...body.data,
    });
    const completionAuditRecorded = await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "assessment.correction.queue",
      resourceType: "assessment_correction",
      resourceId: correctionId,
      reason: body.data.reason,
      outcome: "success",
      metadata: { rowVersion: report.rowVersion, replayed: report.replayed, affectedCount: report.affectedCount },
    }).then(() => true).catch(() => false);
    return adminJson({ report, completionAuditRecorded });
  } catch (error) {
    return adminJson({ error: error instanceof Error ? error.message : "CORRECTION_QUEUE_FAILED" }, assessmentCorrectionErrorStatus(error));
  }
}
