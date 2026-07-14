import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { evaluateCurriculumPublicationGate } from "@/lib/curriculum-publication/gate";
import { requireAdmin } from "@/lib/http/authz";

export async function GET(request: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { versionId } = await params;
  const targetStage = request.nextUrl.searchParams.get("target");
  if (!z.uuid().safeParse(versionId).success || (targetStage !== "beta" && targetStage !== "verified")) return adminJson({ error: "Valid candidate and target stage required." }, 400);
  return adminJson({ gate: await evaluateCurriculumPublicationGate({ courseVersionId: versionId, targetStage }) });
}
