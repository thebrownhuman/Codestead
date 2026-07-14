import { z } from "zod";

import { learningRoute, parseLearningBody, secureLearningResponse } from "../_shared";

import { requireAuth } from "@/lib/http/authz";
import { learningService } from "@/lib/learning-service/runtime";

const schema = z.object({
  idempotencyKey: z.string().min(8).max(128),
}).strict();

export async function POST(request: Request) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  return learningRoute(async () => {
    const body = await parseLearningBody(request, schema);
    return learningService.initializePlans(authz.session.user.id, body.idempotencyKey);
  }, 201);
}
