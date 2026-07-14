import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import {
  loadSmartReminderPreferences,
  SmartReminderPreferenceError,
  updateSmartReminderPreferences,
} from "@/lib/notifications/smart-preferences";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const schema = z.object({
  expectedVersion: z.number().int().min(0),
  dailyStudyEnabled: z.boolean(),
  revisionEnabled: z.boolean(),
  goalEnabled: z.boolean(),
  challengeEnabled: z.boolean(),
  weeklySummaryEnabled: z.boolean(),
  learningEmailEnabled: z.boolean(),
  timezone: z.string().trim().min(1).max(100),
  dailyStudyMinute: z.number().int().min(0).max(1_439),
  revisionMinute: z.number().int().min(0).max(1_439),
  quietHoursEnabled: z.boolean(),
  quietStartMinute: z.number().int().min(0).max(1_439),
  quietEndMinute: z.number().int().min(0).max(1_439),
}).strict();

function errorResponse(error: unknown) {
  const known = error instanceof SmartReminderPreferenceError;
  return NextResponse.json(
    { error: known ? error.code : "REMINDER_PREFERENCES_UNAVAILABLE" },
    { status: known ? error.status : 503, headers },
  );
}

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  try {
    const preferences = await loadSmartReminderPreferences(authz.session.user.id);
    return NextResponse.json({ preferences }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    {
      policy: "notification_preferences_user",
      identity: { kind: "user", value: authz.session.user.id },
    },
    async () => {
      const body = schema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return NextResponse.json({ error: "INVALID_REMINDER_PREFERENCES" }, { status: 400, headers });
      }
      try {
        const preferences = await updateSmartReminderPreferences({
          userId: authz.session.user.id,
          ...body.data,
        });
        const auditRecorded = await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: authz.session.user.id,
          action: "notification_preferences.updated",
          resourceType: "notification_preference",
          resourceId: authz.session.user.id,
          outcome: "success",
          metadata: {
            rowVersion: preferences.rowVersion,
            enabledKinds: [
              preferences.dailyStudyEnabled && "daily_study",
              preferences.revisionEnabled && "revision",
              preferences.goalEnabled && "goal",
              preferences.challengeEnabled && "challenge",
              preferences.weeklySummaryEnabled && "weekly_summary",
            ].filter(Boolean),
            learningEmailEnabled: preferences.learningEmailEnabled,
            timezone: preferences.timezone,
          },
        }).then(() => true).catch(() => {
          console.error(JSON.stringify({ event: "notification_preferences.audit_failed" }));
          return false;
        });
        return NextResponse.json({
          preferences,
          warning: auditRecorded ? null : "Preferences were saved, but the optional audit marker is pending operator review.",
        }, { headers });
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
