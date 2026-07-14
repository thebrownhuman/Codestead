import { NextResponse } from "next/server";

import { listOwnTrophyCabinet } from "@/lib/achievements/trophy-cabinet";
import { requireAuth } from "@/lib/http/authz";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow",
};

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const cabinet = await listOwnTrophyCabinet(authz.session.user.id);
  return NextResponse.json({ cabinet }, { headers });
}
