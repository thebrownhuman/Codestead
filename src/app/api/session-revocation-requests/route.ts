import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { notification, user } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { enqueueEmail } from "@/lib/notifications/outbox";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";
import {
  createRevocationRequest,
  listSessionControls,
} from "@/lib/session-controls";

import {
  secureSessionResponse,
  sessionJson,
} from "../sessions/_http";

const bodySchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    reason: z.string().trim().min(12).max(500),
  })
  .strict();

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return secureSessionResponse(authz.response);
  const result = await listSessionControls(
    authz.session.user.id,
    authz.session.session.id,
  );
  return sessionJson({ revocationRequests: result.revocationRequests });
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return secureSessionResponse(authz.response);
  return withRateLimit(
    { policy: "session_revocation_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
  if (authz.account.role !== "learner") {
    return sessionJson({ error: "This request flow is for learner devices." }, 403);
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return sessionJson(
      { error: "Select your device and provide a clear reason (12–500 characters)." },
      400,
    );
  }
  const requestId = await createRevocationRequest({
    userId: authz.session.user.id,
    sessionId: body.data.sessionId,
    reason: body.data.reason,
  });
  if (!requestId) return sessionJson({ error: "Active session not found." }, 404);

  const controls = await listSessionControls(
    authz.session.user.id,
    authz.session.session.id,
  );
  const device =
    controls.sessions.find((item) => item.id === body.data.sessionId)?.deviceLabel ??
    "an approved browser profile";
  const admins = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(eq(user.role, "admin"));
  const actionUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/admin/learners/${authz.session.user.id}`;
  await Promise.all(
    admins.flatMap((admin) => [
      db.insert(notification).values({
        userId: admin.id,
        type: "session-revocation-requested",
        title: "Device revocation needs review",
        body: `${authz.session.user.name} requested revocation of ${device}. Confirm identity before deciding.`,
        actionUrl: `/admin/learners/${authz.session.user.id}`,
      }),
      enqueueEmail({
        to: admin.email,
        userId: admin.id,
        template: "session-revocation-requested",
        variables: { name: admin.name, device, url: actionUrl },
        idempotencySeed: requestId,
      }),
    ]),
  );
  await writeAuditEvent({
    actorUserId: authz.session.user.id,
    subjectUserId: authz.session.user.id,
    action: "session.revocation_requested",
    resourceType: "session_revocation_request",
    resourceId: requestId,
    outcome: "success",
    metadata: { sessionId: body.data.sessionId },
  });
      return sessionJson({ ok: true, requestId }, 201);
    },
  );
}
