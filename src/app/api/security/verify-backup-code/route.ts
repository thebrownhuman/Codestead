import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  code: z.string().trim().min(6).max(100),
});

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ allowPending: true, allowMfaChallenge: true });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "fresh_mfa_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return NextResponse.json({ error: "Enter one complete recovery code." }, { status: 400 });
      }

      try {
        await auth.api.verifyBackupCode({
          headers: await headers(),
          body: {
            code: body.data.code,
            trustDevice: false,
            disableSession: false,
          },
        });
      } catch {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "mfa.backup_code_assertion",
          resourceType: "session",
          resourceId: authz.session.session.id,
          outcome: "denied",
        });
        return NextResponse.json(
          { error: "The recovery code was not accepted." },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }

      const verifiedAt = new Date();
      await db
        .update(session)
        .set({ mfaVerifiedAt: verifiedAt })
        .where(eq(session.id, authz.session.session.id));
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        action: "mfa.backup_code_assertion",
        resourceType: "session",
        resourceId: authz.session.session.id,
        outcome: "success",
      });
      return NextResponse.json({
        ok: true,
        validUntil: new Date(verifiedAt.getTime() + 5 * 60_000),
        redirectTo: authz.account.status === "pending" ? "/onboarding" : "/learn",
      }, { headers: { "Cache-Control": "no-store" } });
    },
  );
}
