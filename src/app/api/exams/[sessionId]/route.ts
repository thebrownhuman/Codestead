import { requireAuth } from "@/lib/http/authz";

import { examError, examJson } from "../_lib/http";
import { getExamSession } from "../_lib/service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const { sessionId } = await params;
  try {
    const exam = await getExamSession(authz.session.user.id, sessionId);
    return examJson({ exam });
  } catch (error) {
    return examError(error);
  }
}
