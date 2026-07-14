import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

import { examError, examJson } from "../../../_lib/http";
import { startMasteryRecheck } from "../../../_lib/service";
import { startExamRequestSchema } from "../../../_lib/start-contract";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ recheckId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "exam_start_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { recheckId } = await context.params;
      if (!z.uuid().safeParse(recheckId).success) {
        return examJson({ error: "Mastery recheck was not found.", code: "MASTERY_RECHECK_NOT_FOUND" }, { status: 404 });
      }
      const body = startExamRequestSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return examJson(
          { error: "Choose the module and accept both recheck statements.", code: "INVALID_EXAM_START" },
          { status: 400 },
        );
      }
      try {
        const exam = await startMasteryRecheck(authz.session.user.id, recheckId, {
          ...body.data,
          device: {
            ...body.data.device,
            userAgent: request.headers.get("user-agent") ?? body.data.device.userAgent,
          },
        });
        return examJson({ exam }, { status: 201 });
      } catch (error) {
        return examError(error);
      }
    },
  );
}
