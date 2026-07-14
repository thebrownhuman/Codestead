import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { listCurriculumArtifacts } from "@/lib/curriculum-publication/admin-service";
import { requireAdmin } from "@/lib/http/authz";

export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { versionId } = await params;
  if (!z.uuid().safeParse(versionId).success) return adminJson({ error: "Candidate not found." }, 404);
  return adminJson({ artifacts: await listCurriculumArtifacts(versionId) });
}
