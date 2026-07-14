import { requireAdmin } from "@/lib/http/authz";
import { learnerExists, listSessionControls } from "@/lib/session-controls";

import {
  adminJson,
  secureAdminResponse,
} from "@/app/api/admin/dashboard/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { learnerId } = await context.params;
  if (!(await learnerExists(learnerId))) {
    return adminJson({ error: "Learner not found." }, 404);
  }
  const result = await listSessionControls(
    learnerId,
    authz.session.session.id,
  );
  return adminJson(result);
}
