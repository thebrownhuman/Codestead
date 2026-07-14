import type { NextRequest } from "next/server";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import {
  assessmentCorrectionErrorStatus,
  createAssessmentCorrection,
  listAssessmentCorrections,
} from "@/lib/assessment-corrections/admin-service";
import { createCorrectionSchema, correctionListQuerySchema } from "@/lib/assessment-corrections/contracts";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";

import { authorizeAssessmentCorrection } from "./authorization";

export async function GET(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const query = correctionListQuerySchema.safeParse({
    scope: request.nextUrl.searchParams.get("scope") ?? undefined,
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
  });
  if (!query.success) return adminJson({ error: "Correction list query is invalid." }, 400);
  return adminJson({ corrections: await listAssessmentCorrections(query.data) });
}

export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const body = createCorrectionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return adminJson({ error: "Exact appeal/item scope, reviewed replacement tests, a new bundle version, and rationale are required." }, 400);
  }
  const gate = await authorizeAssessmentCorrection({
    actorUserId: authz.session.user.id,
    sessionId: authz.session.session.id,
    actorRole: authz.account.role,
    reason: body.data.reason,
  });
  if (!gate.allowed) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "assessment.correction.create",
      resourceType: "appeal",
      resourceId: body.data.appealId,
      reason: body.data.reason,
      outcome: "denied",
      metadata: { denialCode: gate.code, itemId: body.data.itemId },
    }).catch(() => undefined);
    return adminJson({ error: gate.code }, 403);
  }
  try {
    const report = await createAssessmentCorrection({
      actorUserId: authz.session.user.id,
      ...body.data,
    });
    const completionAuditRecorded = await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "assessment.correction.create",
      resourceType: "assessment_correction",
      resourceId: report.id,
      reason: body.data.reason,
      outcome: "success",
      metadata: {
        sourceAppealId: body.data.appealId,
        itemId: body.data.itemId,
        affectedCount: report.affectedCount,
        replayed: report.replayed,
      },
    }).then(() => true).catch(() => false);
    return adminJson({ report, completionAuditRecorded }, 201);
  } catch (error) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "assessment.correction.create",
      resourceType: "appeal",
      resourceId: body.data.appealId,
      reason: body.data.reason,
      outcome: "failure",
      metadata: { errorCode: error instanceof Error ? error.name : "UNKNOWN", itemId: body.data.itemId },
    }).catch(() => undefined);
    return adminJson({ error: error instanceof Error ? error.message : "CORRECTION_CREATE_FAILED" }, assessmentCorrectionErrorStatus(error));
  }
}
