import { type NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import {
  listOwnerReviewedArtifactIds,
  OWNER_REVIEW_BATCH_LIMIT,
  setOwnerReview,
} from "@/lib/curriculum-publication/owner-review";
import { requireAdmin } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  artifactIds: z.array(z.uuid()).min(1).max(OWNER_REVIEW_BATCH_LIMIT),
  reviewed: z.boolean(),
}).strict();

export async function GET(_request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { versionId } = await params;
  if (!z.uuid().safeParse(versionId).success) return adminJson({ error: "Candidate not found." }, 404);
  return adminJson({ reviewedArtifactIds: await listOwnerReviewedArtifactIds(versionId) });
}

// Owner marks are bookkeeping for a single reviewer, not publication approval,
// so they need an admin session but not a fresh authenticator code.
export async function POST(request: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit(
    { policy: "curriculum_mutation_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { versionId } = await params;
      if (!z.uuid().safeParse(versionId).success) return adminJson({ error: "Candidate not found." }, 404);
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return adminJson({ error: "Choose between 1 and 500 artifacts." }, 400);
      const updated = await setOwnerReview({
        actorUserId: authz.session.user.id,
        courseVersionId: versionId,
        artifactIds: body.data.artifactIds,
        reviewed: body.data.reviewed,
      });
      return adminJson({ updated, reviewedArtifactIds: await listOwnerReviewedArtifactIds(versionId) });
    },
  );
}
