import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { notification, providerCredential, session, user } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { enqueueEmail } from "@/lib/notifications/outbox";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { openCredential, parseMasterKey } from "@/lib/security/credential-vault";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({ reason: z.string().trim().min(8).max(500) }).strict();
const credentialIdSchema = z.uuid();
const noStore = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

function revealJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;

  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  const { id } = await context.params;
  if (!parsedBody.success) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "credential.reveal",
      resourceType: "provider_credential",
      outcome: "denied",
      reason: "Invalid reveal request",
      metadata: { denialCode: "INVALID_REASON" },
    }).catch(() => undefined);
    return revealJson({ error: "A specific reason is required." }, 400);
  }
  if (!credentialIdSchema.safeParse(id).success) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "credential.reveal",
      resourceType: "provider_credential",
      reason: parsedBody.data.reason,
      outcome: "denied",
      metadata: { denialCode: "INVALID_CREDENTIAL_ID" },
    }).catch(() => undefined);
    return revealJson({ error: "Credential not found." }, 404);
  }

  const response = await withRateLimit(
    {
      policy: "credential_reveal_admin",
      identity: { kind: "user", value: authz.session.user.id },
    },
    async () => {
      const [authSession] = await db
        .select({ mfaVerifiedAt: session.mfaVerifiedAt })
        .from(session)
        .where(and(
          eq(session.id, authz.session!.session.id),
          eq(session.userId, authz.session!.user.id),
        ))
        .limit(1);
      const gate = authorizePrivilegedAction({
        actorRole: authz.account.role,
        mfaVerifiedAt: authSession?.mfaVerifiedAt,
        reason: parsedBody.data.reason,
        action: "credential.reveal",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          action: "credential.reveal",
          resourceType: "provider_credential",
          resourceId: id,
          reason: parsedBody.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code },
        });
        return revealJson({ error: gate.code }, 403);
      }

      const [credential] = await db
        .select({
          id: providerCredential.id,
          userId: providerCredential.userId,
          provider: providerCredential.provider,
          ciphertext: providerCredential.ciphertext,
          wrappedDataKey: providerCredential.wrappedDataKey,
          wrapIv: providerCredential.wrapIv,
          dataIv: providerCredential.dataIv,
          authTag: providerCredential.authTag,
          keyVersion: providerCredential.keyVersion,
          lastFour: providerCredential.lastFour,
          ownerEmail: user.email,
          ownerName: user.name,
        })
        .from(providerCredential)
        .innerJoin(user, eq(user.id, providerCredential.userId))
        .where(eq(providerCredential.id, id))
        .limit(1);
      if (!credential) {
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          action: "credential.reveal",
          resourceType: "provider_credential",
          resourceId: id,
          reason: parsedBody.data.reason,
          outcome: "failure",
          metadata: { errorCode: "CREDENTIAL_NOT_FOUND" },
        });
        return revealJson({ error: "Credential not found." }, 404);
      }

      const configured = process.env.CREDENTIAL_MASTER_KEY;
      if (!configured) {
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: credential.userId,
          action: "credential.reveal",
          resourceType: "provider_credential",
          resourceId: credential.id,
          reason: parsedBody.data.reason,
          outcome: "failure",
          metadata: { errorCode: "CREDENTIAL_VAULT_UNAVAILABLE" },
        });
        return revealJson({ error: "Credential vault unavailable." }, 503);
      }

      let plaintext: string;
      try {
        const masterKey = parseMasterKey(configured);
        try {
          plaintext = openCredential(
            credential,
            {
              credentialId: credential.id,
              userId: credential.userId,
              provider: credential.provider,
              keyVersion: credential.keyVersion,
            },
            masterKey,
          );
        } finally {
          masterKey.fill(0);
        }
      } catch {
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: credential.userId,
          action: "credential.reveal",
          resourceType: "provider_credential",
          resourceId: credential.id,
          reason: parsedBody.data.reason,
          outcome: "failure",
          metadata: { errorCode: "CREDENTIAL_OPEN_FAILED" },
        });
        return revealJson({ error: "Credential vault unavailable." }, 503);
      }

      // Decryption itself is the privileged access event, even if a later
      // notification enqueue fails and the plaintext is withheld from HTTP.
      const audit = await writeAuditEvent({
        actorUserId: authz.session!.user.id,
        subjectUserId: credential.userId,
        action: "credential.reveal",
        resourceType: "provider_credential",
        resourceId: credential.id,
        reason: parsedBody.data.reason,
        outcome: "success",
        metadata: { provider: credential.provider, lastFour: credential.lastFour },
      });
      try {
        await db.insert(notification).values({
          userId: credential.userId,
          type: "credential-revealed",
          title: "AI provider key accessed",
          body: `The administrator accessed your ${credential.provider.replaceAll("_", " ")} key after fresh MFA.`,
          actionUrl: "/settings?tab=ai",
        });
        await enqueueEmail({
          to: credential.ownerEmail,
          userId: credential.userId,
          template: "credential-revealed",
          variables: { name: credential.ownerName, provider: credential.provider },
          idempotencySeed: `${credential.id}:${audit.correlationId}`,
        });
      } catch {
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: credential.userId,
          action: "credential.reveal.notification",
          resourceType: "provider_credential",
          resourceId: credential.id,
          reason: parsedBody.data.reason,
          outcome: "failure",
          correlationId: audit.correlationId,
          metadata: { errorCode: "LEARNER_NOTIFICATION_FAILED" },
        }).catch(() => undefined);
        return revealJson(
          { error: "The key was accessed and audited, but learner notification failed; plaintext was withheld." },
          503,
        );
      }
      return revealJson({
        credential: plaintext,
        provider: credential.provider,
        lastFour: credential.lastFour,
        auditCorrelationId: audit.correlationId,
      });
    },
  );

  if (response.status === 429) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      action: "credential.reveal",
      resourceType: "provider_credential",
      resourceId: id,
      reason: parsedBody.data.reason,
      outcome: "denied",
      metadata: { denialCode: "RATE_LIMITED" },
    }).catch(() => undefined);
  }
  return response;
}
