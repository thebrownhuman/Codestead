import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import {
  decodeNotificationCursor,
  listNotifications,
  setNotificationsRead,
} from "@/lib/notifications/center";
import { withRateLimit } from "@/lib/security/rate-limit";

const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const patchSchema = z.object({
  ids: z.array(z.uuid()).max(50).optional(),
  read: z.boolean(),
  readAll: z.boolean().optional(),
}).strict().refine((value) => value.readAll === true || Boolean(value.ids?.length), {
  message: "Choose at least one notification.",
});

export async function GET(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "social_read_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const cursorValue = request.nextUrl.searchParams.get("cursor");
      const cursor = decodeNotificationCursor(cursorValue);
      if (cursorValue && !cursor) {
        return NextResponse.json({ error: "INVALID_CURSOR" }, { status: 400, headers });
      }
      const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? 20);
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
        return NextResponse.json({ error: "INVALID_LIMIT" }, { status: 400, headers });
      }
      const result = await listNotifications({ userId: authz.session.user.id, cursor, limit: rawLimit });
      return NextResponse.json(result, { headers });
    },
  );
}

export async function PATCH(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "notification_preferences_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = patchSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return NextResponse.json({ error: "INVALID_NOTIFICATION_UPDATE" }, { status: 400, headers });
      const result = await setNotificationsRead({ userId: authz.session.user.id, ...body.data });
      return NextResponse.json(result, { headers });
    },
  );
}
