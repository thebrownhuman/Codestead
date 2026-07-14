import { NextResponse } from "next/server";
import { z } from "zod";

import { adminPlanHttpStatus, AdminPlanServiceError, listLearnerPlanHistory } from "@/lib/admin-plan/service";
import { requireAdmin } from "@/lib/http/authz";

export async function GET(
  _request: Request,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const { learnerId } = await context.params;
  if (!z.uuid().safeParse(learnerId).success) {
    return NextResponse.json({ error: "Learner identifier is invalid." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  try {
    return NextResponse.json(await listLearnerPlanHistory(learnerId), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = adminPlanHttpStatus(error);
    return NextResponse.json(
      {
        error: error instanceof AdminPlanServiceError
          ? error.message
          : "Learning-plan history is temporarily unavailable.",
      },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
