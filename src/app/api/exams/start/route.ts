import { type NextRequest } from "next/server";

import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

import { examError, examJson } from "../_lib/http";
import { startExam } from "../_lib/service";
import { startExamRequestSchema } from "../_lib/start-contract";

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "exam_start_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
  const body = startExamRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return examJson(
      { error: "Choose a module and accept both exam statements.", code: "INVALID_EXAM_START" },
      { status: 400 },
    );
  }
  try {
    const exam = await startExam(authz.session.user.id, {
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
