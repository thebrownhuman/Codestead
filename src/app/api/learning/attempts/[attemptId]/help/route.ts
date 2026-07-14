import { z } from "zod";

import { learningRoute, parseLearningBody, secureLearningResponse } from "../../../_shared";

import { requireAuth } from "@/lib/http/authz";
import { LearningServiceError } from "@/lib/learning-service";
import { learningService } from "@/lib/learning-service/runtime";

const schema = z.object({ requestId: z.uuid() }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  return learningRoute(async () => {
    const { attemptId } = await context.params;
    if (!z.uuid().safeParse(attemptId).success) {
      throw new LearningServiceError("INVALID_ATTEMPT_ID", "Attempt id is invalid.");
    }
    const body = await parseLearningBody(request, schema);
    return learningService.revealNextPracticeHelp({
      userId: authz.session.user.id,
      attemptId,
      requestId: body.requestId,
    });
  });
}
