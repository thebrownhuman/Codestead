import { NextResponse } from "next/server";

import { listLearnerCareerRecommendations } from "@/lib/career/service";
import { requireAuth } from "@/lib/http/authz";

const noStore = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const guidance = await listLearnerCareerRecommendations(authz.session.user.id);
  return NextResponse.json({ guidance }, { headers: noStore });
}
