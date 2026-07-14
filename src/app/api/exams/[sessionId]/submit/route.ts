import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

import { examError, examJson } from "../../_lib/http";
import { submitExam } from "../../_lib/service";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "exam_submit_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
  const { sessionId } = await params;
  try {
    const exam = await submitExam(authz.session.user.id, sessionId);
    return examJson({ exam });
  } catch (error) {
    return examError(error);
      }
    },
  );
}
