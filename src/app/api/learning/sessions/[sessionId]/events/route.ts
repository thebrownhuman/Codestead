import { z } from "zod";

import { learningRoute, parseLearningBody, secureLearningResponse } from "../../../_shared";

import { requireAuth } from "@/lib/http/authz";
import { LearningServiceError, SESSION_EVENT_TYPES } from "@/lib/learning-service";
import { learningService } from "@/lib/learning-service/runtime";

const schema = z.object({
  clientEventId: z.string().min(8).max(160),
  expectedRowVersion: z.number().int().positive(),
  type: z.enum(SESSION_EVENT_TYPES),
  subjectType: z.string().trim().min(1).max(80).nullable().optional(),
  subjectId: z.string().trim().min(1).max(160).nullable().optional(),
  clientTime: z.iso.datetime().nullable().optional(),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  return learningRoute(async () => {
    const { sessionId } = await context.params;
    if (!z.uuid().safeParse(sessionId).success) throw new LearningServiceError("INVALID_SESSION_ID", "Session id is invalid.");
    const body = await parseLearningBody(request, schema);
    return learningService.recordSessionEvent({
      userId: authz.session.user.id,
      sessionId,
      ...body,
      clientTime: body.clientTime ? new Date(body.clientTime) : null,
    });
  }, 201);
}
