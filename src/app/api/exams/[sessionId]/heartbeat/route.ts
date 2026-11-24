import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

import { examError, examJson } from "../../_lib/http";
import { heartbeatExam } from "../../_lib/service";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const userId = authz.session.user.id;
  return withRateLimit(
    { policy: "exam_heartbeat_user", identity: { kind: "user", value: userId } },
    async () => {
      const { sessionId } = await params;
      try {
        return examJson(await heartbeatExam(userId, sessionId));
      } catch (error) {
        return examError(error);
      }
    },
  );
}
