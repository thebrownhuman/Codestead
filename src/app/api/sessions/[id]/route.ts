import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { revokeOneOwnedSession } from "@/lib/session-controls";

import { secureSessionResponse, sessionJson } from "../_http";

const idSchema = z.string().min(1).max(128);

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAuth();
  if (!authz.session) return secureSessionResponse(authz.response);
  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) {
    return sessionJson({ error: "Session id is invalid." }, 400);
  }
  const revoked = await revokeOneOwnedSession({
    userId: authz.session.user.id,
    sessionId: id,
    actorUserId: authz.session.user.id,
    reason: "learner_logout",
  });
  if (!revoked) return sessionJson({ error: "Session not found." }, 404);
  await writeAuditEvent({
    actorUserId: authz.session.user.id,
    subjectUserId: authz.session.user.id,
    action: "session.revoke",
    resourceType: "session",
    resourceId: id,
    outcome: "success",
  });
  return sessionJson({ ok: true, current: id === authz.session.session.id });
}
