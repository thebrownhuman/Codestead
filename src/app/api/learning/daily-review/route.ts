import { requireAuth } from "@/lib/http/authz";
import { dailyReviewService } from "@/lib/daily-review/runtime";

import { learningRoute, secureLearningResponse } from "../_shared";

export async function GET() {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  return learningRoute(() => dailyReviewService.get(authz.session.user.id));
}

export async function POST() {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  return learningRoute(() => dailyReviewService.initialize(authz.session.user.id), 201);
}
