import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";
import { loadVisibleCohortProfile, SocialProfileError } from "@/lib/social/profile-service";

export async function GET(_request: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "social_read_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      try {
        const profile = await loadVisibleCohortProfile((await params).publicId);
        return NextResponse.json({ profile }, { headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } });
      } catch (error) {
        const status = error instanceof SocialProfileError && error.code === "NOT_FOUND" ? 404 : 500;
        return NextResponse.json({ error: status === 404 ? "PROFILE_NOT_VISIBLE" : "PROFILE_READ_FAILED" }, { status, headers: { "Cache-Control": "private, no-store" } });
      }
    },
  );
}
