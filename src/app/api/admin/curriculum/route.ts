import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import {
  listCurriculumCandidates,
  listCurriculumReviewQueue,
} from "@/lib/curriculum-publication/admin-service";
import { requireAdmin } from "@/lib/http/authz";

export async function GET() {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const [candidates, reviewQueue] = await Promise.all([
    listCurriculumCandidates(),
    listCurriculumReviewQueue(),
  ]);
  return adminJson({ candidates, reviewQueue });
}
