import { z } from "zod";

import { learningRoute, parseLearningBody, secureLearningResponse } from "../_shared";

import { requireAuth } from "@/lib/http/authz";
import { toLearnerAttemptCreationPayload } from "@/lib/learning-service";
import { learningService } from "@/lib/learning-service/runtime";

const schema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  skillId: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/),
}).strict();

export async function POST(request: Request) {
  const authz = await requireAuth({ closedBookCapability: "learning_workspace" });
  if (!authz.session) return secureLearningResponse(authz.response);
  return learningRoute(async () => {
    const body = await parseLearningBody(request, schema);
    const internalAttempt = await learningService.createAttempt({
      userId: authz.session.user.id,
      idempotencyKey: body.idempotencyKey,
      skillId: body.skillId,
      kind: "diagnostic",
    });
    const attempt = toLearnerAttemptCreationPayload(internalAttempt);
    return {
      ...attempt,
      placement: {
        selfReportUsedAsEvidence: false,
        officialEvidencePending: attempt.state === "ready",
      },
    };
  }, 201);
}
