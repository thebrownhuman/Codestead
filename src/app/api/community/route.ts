import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";
import { loadCohortLeaderboards } from "@/lib/social/leaderboard-service";
import { listVisibleProfileOwners, loadVisibleCohortProfile } from "@/lib/social/profile-service";

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "social_read_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const owners = await listVisibleProfileOwners();
      const [profiles, leaderboards] = await Promise.all([
        Promise.all(owners.map((owner) => loadVisibleCohortProfile(owner.publicId))),
        loadCohortLeaderboards(),
      ]);
      return NextResponse.json(
        {
          profiles,
          leaderboards,
          privacy: "Only explicitly published alias projections with current cohort consent appear. Private learning evidence never leaves the scoring snapshot store.",
        },
        { headers: { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" } },
      );
    },
  );
}
