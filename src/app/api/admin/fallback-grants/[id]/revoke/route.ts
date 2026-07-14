import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { revokeFallbackGrantCommand } from "@/lib/ai/fallback-grants";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  reason: z.string().trim().min(8).max(500),
  requestId: z.string().uuid(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "fallback_grant_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return NextResponse.json({ error: "A specific revocation reason is required." }, { status: 400 });
      }
      const { id } = await context.params;
      const [authSession] = await db
        .select({ mfaVerifiedAt: session.mfaVerifiedAt })
        .from(session)
        .where(eq(session.id, authz.session.session.id))
        .limit(1);
      const gate = authorizePrivilegedAction({
        actorRole: authz.account.role,
        mfaVerifiedAt: authSession?.mfaVerifiedAt,
        reason: body.data.reason,
        action: "fallback_grant.manage",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "fallback_grant.revoke",
          resourceType: "admin_fallback_grant",
          resourceId: id,
          reason: body.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code },
        });
        return NextResponse.json({ error: gate.code }, { status: 403 });
      }

      const result = await revokeFallbackGrantCommand({
        actorUserId: authz.session.user.id,
        grantId: id,
        reason: body.data.reason,
        requestId: body.data.requestId,
      });
      if (!result.ok) {
        if (result.code === "GRANT_NOT_FOUND") {
          return NextResponse.json({ error: "Fallback grant not found." }, { status: 404 });
        }
        return NextResponse.json(
          {
            error: result.code === "IDEMPOTENCY_KEY_REUSED"
              ? "This request ID was already used for a different revocation command."
              : "Fallback access was already revoked.",
            code: result.code,
          },
          { status: 409 },
        );
      }
      const revoked = result.value;
      return NextResponse.json(
        { ok: true, revokedAt: revoked.revokedAt },
        {
          headers: {
            "Cache-Control": "private, no-store",
            "X-Idempotent-Replay": result.replayed ? "true" : "false",
          },
        },
      );
    },
  );
}
