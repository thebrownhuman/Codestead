import { requireAuth } from "@/lib/http/authz";

import { examError, examJson } from "../../_lib/http";
import { heartbeatExam } from "../../_lib/service";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const { sessionId } = await params;
  try {
    return examJson(await heartbeatExam(authz.session.user.id, sessionId));
  } catch (error) {
    return examError(error);
  }
}
