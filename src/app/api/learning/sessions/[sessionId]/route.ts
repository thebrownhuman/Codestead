import { z } from "zod";

import { learningJson, learningRoute, parseLearningBody, secureLearningResponse } from "../../_shared";

import { requireAuth } from "@/lib/http/authz";
import { LearningServiceError } from "@/lib/learning-service";
import { learningService } from "@/lib/learning-service/runtime";

const paramsSchema = z.uuid();
const patchSchema = z.object({
  action: z.enum(["resume", "end"]),
  expectedRowVersion: z.number().int().positive(),
}).strict();

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  const { sessionId } = await context.params;
  if (!paramsSchema.safeParse(sessionId).success) return learningJson({ error: "Session id is invalid.", code: "INVALID_SESSION_ID" }, 400);
  return learningRoute(async () => {
    const session = await learningService.getSession(authz.session.user.id, sessionId);
    if (!session) return { state: "empty", session: null };
    return { state: "ready", session };
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  return learningRoute(async () => {
    const { sessionId } = await context.params;
    if (!paramsSchema.safeParse(sessionId).success) {
      throw new LearningServiceError("INVALID_SESSION_ID", "Session id is invalid.");
    }
    const body = await parseLearningBody(request, patchSchema);
    return learningService.mutateSession({ userId: authz.session.user.id, sessionId, ...body });
  });
}
