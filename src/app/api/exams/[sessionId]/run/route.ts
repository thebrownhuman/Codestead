import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";
import { hasCurrentConsent } from "@/lib/privacy/consent";

import { examError, examJson } from "../../_lib/http";
import { runExamCode } from "../../_lib/service";

const runSchema = z.object({
  itemId: z.string().trim().min(3).max(180),
  sourceCode: z.string().min(1).max(131_072),
  stdin: z.string().max(16_384).optional(),
  mode: z.enum(["COMPILE", "RUN"]),
  clientRequestId: z.string().uuid(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "exam_run_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
  const body = runSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return examJson({ error: "Executable source and a request id are required.", code: "INVALID_CODE_RUN" }, { status: 400 });
  }
  if (!(await hasCurrentConsent(authz.session.user.id, "server_code_execution"))) {
    return examJson(
      { error: "Accept the current server-execution disclosure before running code.", code: "EXECUTION_DISCLOSURE_REQUIRED" },
      { status: 409 },
    );
  }
  const { sessionId } = await params;
  try {
    const result = await runExamCode({
      userId: authz.session.user.id,
      sessionId,
      ...body.data,
    });
    return examJson({ result });
  } catch (error) {
    return examError(error);
      }
    },
  );
}
