import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";
import {
  loadOwnCohortSettings,
  SocialProfileError,
  updateCohortProfile,
} from "@/lib/social/profile-service";

const noStore = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const updateSchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(0),
  alias: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/),
  bio: z.string().trim().max(280).nullable(),
  showBio: z.boolean(),
  showStreak: z.boolean(),
  showMasterySummary: z.boolean(),
  publish: z.boolean(),
  selectedAchievementIds: z.array(z.uuid()).max(100),
  selectedProjectIds: z.array(z.uuid()).max(100),
}).strict();

function status(code: string) {
  if (code === "NOT_FOUND") return 404;
  if (code === "CONSENT_REQUIRED" || code === "INVALID_REQUEST" || code === "INVALID_SELECTION") return 400;
  return 409;
}

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const settings = await loadOwnCohortSettings(authz.session.user.id);
  return NextResponse.json({ settings }, { headers: noStore });
}

export async function PATCH(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "social_profile_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = updateSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return NextResponse.json({ error: "Choose a safe alias and explicit visible fields." }, { status: 400, headers: noStore });
      try {
        const report = await updateCohortProfile({ actorUserId: authz.session.user.id, ...body.data });
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: authz.session.user.id,
          action: `cohort_profile.${report.event ?? (body.data.publish ? "published" : "withdrawn")}`,
          resourceType: "cohort_profile",
          resourceId: authz.session.user.id,
          outcome: "success",
          metadata: {
            rowVersion: report.rowVersion,
            replayed: report.replayed,
            publish: body.data.publish,
            visibleBadgeCount: body.data.publish ? new Set(body.data.selectedAchievementIds).size : 0,
            visibleProjectCount: body.data.publish ? new Set(body.data.selectedProjectIds).size : 0,
          },
        });
        return NextResponse.json({ report, settings: await loadOwnCohortSettings(authz.session.user.id) }, { headers: noStore });
      } catch (error) {
        const code = error instanceof SocialProfileError ? error.code : "PROFILE_UPDATE_FAILED";
        return NextResponse.json({ error: code }, { status: status(code), headers: noStore });
      }
    },
  );
}
