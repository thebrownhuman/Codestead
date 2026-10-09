import { readBoundedJson } from "@/lib/http/bounded-json";
import { NextRequest } from "next/server";
import { z } from "zod";

import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import {
  archiveAndDeleteSessions,
  listSessionControls,
} from "@/lib/session-controls";

import { secureSessionResponse, sessionJson } from "./_http";

const revokeSchema = z.object({ scope: z.enum(["all", "others"]) }).strict();

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return secureSessionResponse(authz.response);
  const result = await listSessionControls(
    authz.session.user.id,
    authz.session.session.id,
  );
  return sessionJson(result);
}

export async function DELETE(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return secureSessionResponse(authz.response);
  const jsonBody = await readBoundedJson(request);
  if (jsonBody.response?.status === 413) return jsonBody.response;
  const parsed = revokeSchema.safeParse(jsonBody.value);
  if (!parsed.success) {
    return sessionJson({ error: "Choose all sessions or other sessions." }, 400);
  }
  const revokedIds = await archiveAndDeleteSessions({
    userId: authz.session.user.id,
    actorUserId: authz.session.user.id,
    currentSessionId: authz.session.session.id,
    scope: parsed.data.scope,
    reason:
      parsed.data.scope === "all"
        ? "learner_logout"
        : "learner_logout_others",
  });
  await writeAuditEvent({
    actorUserId: authz.session.user.id,
    subjectUserId: authz.session.user.id,
    action:
      parsed.data.scope === "all"
        ? "session.revoke_all"
        : "session.revoke_others",
    resourceType: "session",
    resourceId:
      parsed.data.scope === "all" ? authz.session.user.id : undefined,
    outcome: "success",
    metadata: { revokedCount: revokedIds.length },
  });
  return sessionJson({ ok: true, revokedCount: revokedIds.length });
}
