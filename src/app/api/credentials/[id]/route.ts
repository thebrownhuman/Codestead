import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { validateProviderCredential } from "@/lib/ai/credential-validation";
import { notifyCredentialChangedInTransaction } from "@/lib/credential-notifications";
import { db } from "@/lib/db/client";
import { providerCredential } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEventInTransaction } from "@/lib/security/audit-writer";
import {
  openCredential,
  parseMasterKey,
  sealCredential,
} from "@/lib/security/credential-vault";
import { withRateLimit } from "@/lib/security/rate-limit";
import { requireRecentMfa } from "@/lib/security/recent-mfa";
import { consentPurposeForProvider, hasCurrentConsent } from "@/lib/privacy/consent";

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["prefer", "disable", "enable", "test"]),
    requestId: z.uuid(),
  }).strict(),
  z.object({
    action: z.literal("replace"),
    requestId: z.uuid(),
    secret: z.string().trim().min(8).max(4_096),
  }).strict(),
]);
const deleteSchema = z.object({ requestId: z.uuid() }).strict();

type CredentialMutationTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

function masterKey() {
  const configured = process.env.CREDENTIAL_MASTER_KEY;
  if (!configured) throw new Error("CREDENTIAL_MASTER_KEY is not configured.");
  return parseMasterKey(configured);
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAuth({ allowPending: true });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "credential_write_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = patchSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return NextResponse.json({ error: "Unknown credential action." }, { status: 400 });
      const { id } = await context.params;
      const mfa = await requireRecentMfa({
        sessionId: authz.session.session.id,
        userId: authz.session.user.id,
        action: `credential.${body.data.action}`,
        resourceId: id,
      });
      if (!mfa.allowed) return mfa.response;
      const [owned] = await db
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
        })
        .from(providerCredential)
        .where(
          and(
            eq(providerCredential.id, id),
            eq(providerCredential.userId, authz.session.user.id),
          ),
        )
        .limit(1);
      if (!owned) return NextResponse.json({ error: "Credential not found." }, { status: 404 });
      if (body.data.action !== "disable") {
        const purpose = consentPurposeForProvider(owned.provider);
        if (!purpose || !(await hasCurrentConsent(authz.session.user.id, purpose))) {
          return NextResponse.json(
            {
              error: "Re-enable consent for this provider in privacy settings before using or changing its routing state.",
              code: "PROVIDER_CONSENT_REQUIRED",
            },
            { status: 409 },
          );
        }
      }

      let validationStatus: "active" | "invalid" | "rate_limited" | "pending_validation" | null = null;
      let applyValidatedChange:
        | ((tx: CredentialMutationTransaction) => Promise<void>)
        | undefined;

      if (body.data.action === "test" || body.data.action === "replace") {
        let wrappingKey: Buffer;
        try {
          wrappingKey = masterKey();
        } catch {
          return NextResponse.json(
            { error: "Credential vault unavailable." },
            { status: 503, headers: { "Cache-Control": "no-store" } },
          );
        }

        try {
          let secret: string;
          if (body.data.action === "replace") {
            secret = body.data.secret;
          } else {
            try {
              secret = openCredential(
                owned,
                {
                  credentialId: owned.id,
                  userId: owned.userId,
                  provider: owned.provider,
                  keyVersion: owned.keyVersion,
                },
                wrappingKey,
              );
            } catch {
              return NextResponse.json(
                { error: "Credential could not be opened safely." },
                { status: 503, headers: { "Cache-Control": "no-store" } },
              );
            }
          }

          const validation = await validateProviderCredential({
            userId: authz.session.user.id,
            credentialId: owned.id,
            provider: owned.provider,
            secret,
          });
          validationStatus = validation.status;
          if (body.data.action === "replace") {
            const sealed = sealCredential(
              secret,
              {
                credentialId: owned.id,
                userId: owned.userId,
                provider: owned.provider,
                keyVersion: owned.keyVersion + 1,
              },
              wrappingKey,
            );
            applyValidatedChange = async (tx) => {
              await tx
                .update(providerCredential)
                .set({
                  ciphertext: sealed.ciphertext,
                  wrappedDataKey: sealed.wrappedDataKey,
                  wrapIv: sealed.wrapIv,
                  dataIv: sealed.dataIv,
                  authTag: sealed.authTag,
                  keyVersion: sealed.keyVersion,
                  lastFour: sealed.lastFour,
                  status: validation.status,
                  failureCode: validation.failureCode,
                  lastValidatedAt: validation.model ? new Date() : null,
                  disabledAt: null,
                })
                .where(eq(providerCredential.id, owned.id));
            };
          } else {
            applyValidatedChange = async (tx) => {
              await tx
                .update(providerCredential)
                .set({
                  status: validation.status,
                  failureCode: validation.failureCode,
                  lastValidatedAt: validation.model ? new Date() : null,
                })
                .where(eq(providerCredential.id, owned.id));
            };
          }
        } finally {
          wrappingKey.fill(0);
        }
      }

      await db.transaction(async (tx) => {
        if (body.data.action === "prefer") {
          await tx
            .update(providerCredential)
            .set({ isPreferred: false })
            .where(
              and(
                eq(providerCredential.userId, authz.session.user.id),
                eq(providerCredential.provider, owned.provider),
              ),
            );
          await tx
            .update(providerCredential)
            .set({ isPreferred: true })
            .where(eq(providerCredential.id, owned.id));
        } else if (
          body.data.action === "disable"
          || body.data.action === "enable"
        ) {
          await tx
            .update(providerCredential)
            .set({
              status:
                body.data.action === "disable"
                  ? "disabled"
                  : "pending_validation",
              disabledAt: body.data.action === "disable" ? new Date() : null,
            })
            .where(eq(providerCredential.id, owned.id));
        } else {
          if (!applyValidatedChange) {
            throw new Error("Credential validation result is unavailable.");
          }
          await applyValidatedChange(tx);
        }

        await writeAuditEventInTransaction(tx, {
          actorUserId: authz.session.user.id,
          subjectUserId: authz.session.user.id,
          action: `credential.${body.data.action}`,
          resourceType: "provider_credential",
          resourceId: owned.id,
          outcome:
            validationStatus
              && !["active", "pending_validation"].includes(validationStatus)
              ? "failure"
              : "success",
          metadata: { provider: owned.provider, validationStatus },
        });
        await notifyCredentialChangedInTransaction(tx, {
          userId: authz.session.user.id,
          provider: owned.provider,
          action: body.data.action,
          idempotencySeed:
            `${owned.id}:${body.data.action}:${body.data.requestId}`,
        });
      });

      return NextResponse.json(
        { ok: true, ...(validationStatus ? { status: validationStatus } : {}) },
        { headers: { "Cache-Control": "no-store" } },
      );
        }

        try {
          let secret: string;
          if (body.data.action === "replace") {
            secret = body.data.secret;
          } else {
            try {
              secret = openCredential(
                owned,
                {
                  credentialId: owned.id,
                  userId: owned.userId,
                  provider: owned.provider,
                  keyVersion: owned.keyVersion,
                },
                wrappingKey,
              );
            } catch {
              return NextResponse.json(
                { error: "Credential could not be opened safely." },
                { status: 503, headers: { "Cache-Control": "no-store" } },
              );
            }
          }

          const validation = await validateProviderCredential({
            userId: authz.session.user.id,
            credentialId: owned.id,
            provider: owned.provider,
            secret,
          });
          validationStatus = validation.status;

          if (body.data.action === "replace") {
            const sealed = sealCredential(
              secret,
              {
                credentialId: owned.id,
                userId: owned.userId,
                provider: owned.provider,
                keyVersion: owned.keyVersion + 1,
              },
              wrappingKey,
            );
            await db
              .update(providerCredential)
              .set({
                ciphertext: sealed.ciphertext,
                wrappedDataKey: sealed.wrappedDataKey,
                wrapIv: sealed.wrapIv,
                dataIv: sealed.dataIv,
                authTag: sealed.authTag,
                keyVersion: sealed.keyVersion,
                lastFour: sealed.lastFour,
                status: validation.status,
                failureCode: validation.failureCode,
                lastValidatedAt: validation.model ? new Date() : null,
                disabledAt: null,
              })
              .where(eq(providerCredential.id, owned.id));
          } else {
            await db
              .update(providerCredential)
              .set({
                status: validation.status,
                failureCode: validation.failureCode,
                lastValidatedAt: validation.model ? new Date() : null,
              })
              .where(eq(providerCredential.id, owned.id));
          }
        } finally {
          wrappingKey.fill(0);
        }
      }
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: authz.session.user.id,
        action: `credential.${body.data.action}`,
        resourceType: "provider_credential",
        resourceId: owned.id,
        outcome:
          validationStatus && !["active", "pending_validation"].includes(validationStatus)
            ? "failure"
            : "success",
        metadata: { provider: owned.provider, validationStatus },
      });
      await notifyCredentialChanged({
        userId: authz.session.user.id,
        provider: owned.provider,
        action: body.data.action,
        idempotencySeed: `${owned.id}:${body.data.action}:${Date.now()}`,
      });
      return NextResponse.json(
        { ok: true, ...(validationStatus ? { status: validationStatus } : {}) },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAuth({ allowPending: true });
  if (!authz.session) return authz.response;
  return withRateLimit(
    {
      policy: "credential_write_user",
      identity: { kind: "user", value: authz.session.user.id },
    },
    async () => {
      const body = deleteSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!body.success) {
        return NextResponse.json(
          { error: "A stable request ID is required." },
          { status: 400 },
        );
      }
      const { id } = await context.params;
      const mfa = await requireRecentMfa({
        sessionId: authz.session.session.id,
        userId: authz.session.user.id,
        action: "credential.delete",
        resourceId: id,
      });
      if (!mfa.allowed) return mfa.response;

      const deleted = await db.transaction(async (tx) => {
        const rows = await tx
          .delete(providerCredential)
          .where(
            and(
              eq(providerCredential.id, id),
              eq(providerCredential.userId, authz.session.user.id),
            ),
          )
          .returning({
            id: providerCredential.id,
            provider: providerCredential.provider,
          });
        const credential = rows[0];
        if (!credential) return null;
        await writeAuditEventInTransaction(tx, {
          actorUserId: authz.session.user.id,
          subjectUserId: authz.session.user.id,
          action: "credential.delete",
          resourceType: "provider_credential",
          resourceId: credential.id,
          outcome: "success",
          metadata: { provider: credential.provider },
        });
        await notifyCredentialChangedInTransaction(tx, {
          userId: authz.session.user.id,
          provider: credential.provider,
          action: "delete",
          idempotencySeed:
            `${credential.id}:delete:${body.data.requestId}`,
        });
        return credential;
      });
      if (!deleted) {
        return NextResponse.json(
          { error: "Credential not found." },
          { status: 404 },
        );
      }
      return new NextResponse(null, { status: 204 });
    },
  );
}