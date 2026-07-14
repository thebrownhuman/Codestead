import { z } from "zod";

import { learningJson, learningRoute, secureLearningResponse } from "../_shared";

import { requireAuth } from "@/lib/http/authz";
import { learningService } from "@/lib/learning-service/runtime";

export async function GET(request: Request) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  const value = new URL(request.url).searchParams.get("sessionId");
  if (value && !z.uuid().safeParse(value).success) {
    return learningJson({ error: "Session id is invalid.", code: "INVALID_SESSION_ID" }, 400);
  }
  return learningRoute(() => learningService.recommendNext(authz.session.user.id, value ?? undefined));
}
