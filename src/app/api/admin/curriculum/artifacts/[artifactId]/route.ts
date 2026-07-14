import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { CurriculumAdminError, getCurriculumArtifactDetail } from "@/lib/curriculum-publication/admin-service";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";

export async function GET(_request: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { artifactId } = await params;
  if (!z.uuid().safeParse(artifactId).success) return adminJson({ error: "Artifact not found." }, 404);
  try {
    const detail = await getCurriculumArtifactDetail(artifactId);
    await writeAuditEvent({ actorUserId: authz.session.user.id, action: "curriculum.read_artifact", resourceType: "curriculum_artifact", resourceId: artifactId, reason: "Human curriculum review", outcome: "success", metadata: { artifactType: detail.artifact.artifactType, contentHashValid: detail.artifact.contentHashValid } });
    return adminJson({ detail });
  } catch (error) {
    return adminJson({ error: error instanceof CurriculumAdminError && error.code === "NOT_FOUND" ? "Artifact not found." : "Artifact evidence could not be loaded or audited." }, error instanceof CurriculumAdminError && error.code === "NOT_FOUND" ? 404 : 503);
  }
}
