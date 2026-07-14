import { z } from "zod";

import { getLearnerDetailData } from "../../data";
import { adminJson, secureAdminResponse } from "../../http";

import { requireAdmin } from "@/lib/http/authz";

export const dynamic = "force-dynamic";

const learnerIdSchema = z.uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);

  const { learnerId } = await context.params;
  if (!learnerIdSchema.safeParse(learnerId).success) {
    return adminJson({ error: "Learner identifier is invalid." }, 400);
  }

  try {
    const detail = await getLearnerDetailData(learnerId);
    return detail
      ? adminJson(detail)
      : adminJson({ error: "Learner was not found." }, 404);
  } catch (error) {
    console.error("Admin learner detail query failed", error);
    return adminJson({ error: "Learner operations data is temporarily unavailable." }, 503);
  }
}
