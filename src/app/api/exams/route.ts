import { requireAuth } from "@/lib/http/authz";

import { examError, examJson } from "./_lib/http";
import { listExamCatalog } from "./_lib/service";

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  try {
    const exams = await listExamCatalog(authz.session.user.id);
    return examJson({ exams, serverNow: new Date().toISOString() });
  } catch (error) {
    return examError(error);
  }
}
