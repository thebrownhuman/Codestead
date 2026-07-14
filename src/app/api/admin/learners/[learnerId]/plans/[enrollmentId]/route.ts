import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { adminPlanHttpStatus, AdminPlanServiceError, getLearnerPlanDetail } from "@/lib/admin-plan/service";
import { requireAdmin } from "@/lib/http/authz";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ learnerId: string; enrollmentId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const params = await context.params;
  if (!z.uuid().safeParse(params.learnerId).success || !z.uuid().safeParse(params.enrollmentId).success) {
    return NextResponse.json({ error: "Learner or enrollment identifier is invalid." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  const revisionValue = request.nextUrl.searchParams.get("revision");
  const revision = revisionValue === null ? undefined : Number(revisionValue);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
    return NextResponse.json({ error: "Revision must be a positive integer." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  try {
    return NextResponse.json(await getLearnerPlanDetail({
      learnerPublicId: params.learnerId,
      enrollmentId: params.enrollmentId,
      revision,
    }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof AdminPlanServiceError
          ? error.message
          : "Learning-plan detail is temporarily unavailable.",
      },
      { status: adminPlanHttpStatus(error), headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
