import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { dailyReviewService } from "@/lib/daily-review/runtime";
import { LearningServiceError } from "@/lib/learning-service";

import { learningRoute, secureLearningResponse } from "../../../../../_shared";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string; itemId: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  return learningRoute(async () => {
    const params = await context.params;
    if (!z.uuid().safeParse(params.sessionId).success || !z.uuid().safeParse(params.itemId).success) {
      throw new LearningServiceError("INVALID_DAILY_REVIEW_ITEM", "Daily review identifiers are invalid.", 400);
    }
    return dailyReviewService.startItem(
      authz.session.user.id,
      params.sessionId,
      params.itemId,
    );
  }, 201);
}
