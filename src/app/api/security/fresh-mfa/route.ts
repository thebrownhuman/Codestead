import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { session, twoFactor, user } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

async function verifyEnrollmentTotp(input: {
  userId: string;
  sessionId: string;
  code: string;
}) {
  const [factor] = await db
    .select({ id: twoFactor.id, secret: twoFactor.secret, verified: twoFactor.verified })
    .from(twoFactor)
    .where(eq(twoFactor.userId, input.userId))
    .limit(1);
  if (!factor || factor.verified !== false) return null;

  try {
    const context = await auth.$context;
    const secret = await symmetricDecrypt({ key: context.secretConfig, data: factor.secret });
    const accepted = await createOTP(secret).verify(input.code);
    if (!accepted) return false;
  } catch {
    return false;
  }

  const verifiedAt = new Date();
  await db.transaction(async (tx) => {
    const [verifiedFactor] = await tx
      .update(twoFactor)
      .set({ verified: true, failedVerificationCount: 0, lockedUntil: null })
      .where(and(eq(twoFactor.id, factor.id), eq(twoFactor.userId, input.userId), eq(twoFactor.verified, false)))
      .returning({ id: twoFactor.id });
    if (!verifiedFactor) throw new Error("MFA enrollment changed during verification.");

    await tx
      .update(user)
      .set({ twoFactorEnabled: true })
      .where(eq(user.id, input.userId));
    const [stampedSession] = await tx
      .update(session)
      .set({ mfaVerifiedAt: verifiedAt })
      .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)))
      .returning({ id: session.id });
    if (!stampedSession) throw new Error("The approved session disappeared during MFA enrollment.");
  });
  return verifiedAt;
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ allowPending: true, allowMfaChallenge: true });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "fresh_mfa_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return NextResponse.json({ error: "Enter a six-digit code." }, { status: 400 });

      let verifiedAt: Date;
      try {
        const enrollment = await verifyEnrollmentTotp({
          userId: authz.session.user.id,
          sessionId: authz.session.session.id,
          code: body.data.code,
        });
        if (enrollment === false) throw new Error("Invalid enrollment code.");
        if (enrollment) {
          verifiedAt = enrollment;
        } else {
          await auth.api.verifyTOTP({
            headers: await headers(),
            body: { code: body.data.code },
          });
          verifiedAt = new Date();
          await db
            .update(session)
            .set({ mfaVerifiedAt: verifiedAt })
            .where(and(eq(session.id, authz.session.session.id), eq(session.userId, authz.session.user.id)));
        }
      } catch {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "mfa.fresh_assertion",
          resourceType: "session",
          resourceId: authz.session.session.id,
          outcome: "denied",
        });
        return NextResponse.json({ error: "The authenticator code was not accepted." }, { status: 403 });
      }
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        action: "mfa.fresh_assertion",
        resourceType: "session",
        resourceId: authz.session.session.id,
        outcome: "success",
      });
      return NextResponse.json({
        ok: true,
        validUntil: new Date(verifiedAt.getTime() + 5 * 60_000),
        redirectTo: authz.account.status === "pending" ? "/onboarding" : "/learn",
      });
    },
  );
}
