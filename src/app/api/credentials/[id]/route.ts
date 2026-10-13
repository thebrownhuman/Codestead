import { readBoundedJson } from "@/lib/http/bounded-json";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { validateProviderCredential, type CredentialValidationStatus } from "@/lib/ai/credential-validation";
import { clearOtherCredentialPreferences } from "@/lib/ai/credential-preference";
import { providerCredentialUpdatedAtToken } from "@/lib/ai/provider-credential-outcome";
import { notifyCredentialChanged } from "@/lib/credential-notifications";
import { db } from "@/lib/db/client";
import { providerCredential } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import {
  openCredential,
  parseMasterKey,
  sealCredential,
} from "@/lib/security/credential-vault";
import { withRateLimit } from "@/lib/security/rate-limit";
import { requireRecentMfa } from "@/lib/security/recent-mfa";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";
import { consentPurposeForProvider, hasCurrentConsent } from "@/lib/privacy/consent";

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["prefer", "disable", "enable", "test"]), requestId: z.uuid() }),
  z.object({
    action: z.literal("replace"),
    secret: z.string().trim().min(8).max(4_096),
    requestId: z.uuid(),
  }),
]);
const deleteSchema = z.object({ requestId: z.uuid() }).strict();

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
      const jsonBody = await readBoundedJson(request);
      if (jsonBody.response?.status === 413) return jsonBody.response;
      const body = patchSchema.safeParse(jsonBody.value);
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
          status: providerCredential.status,
          ciphertext: providerCredential.ciphertext,
          wrappedDataKey: providerCredential.wrappedDataKey,
          wrapIv: providerCredential.wrapIv,
          dataIv: providerCredential.dataIv,
          authTag: providerCredential.authTag,
          keyVersion: providerCredential.keyVersion,
          updatedAtToken: providerCredentialUpdatedAtToken,
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
      let snapshotCondition = and(
        eq(providerCredential.id, owned.id),
        eq(providerCredential.userId, owned.userId),
        eq(providerCredential.keyVersion, owned.keyVersion),
        eq(providerCredentialUpdatedAtToken, owned.updatedAtToken),
      );
      // Advance even for two mutations in the same millisecond. Reuse the
      // microsecond-preserving timestamp as the existing mutation revision.
      const nextRevision = sql`greatest(clock_timestamp(), ${providerCredential.updatedAt} + interval '1 microsecond')`;
      const staleResult = () => NextResponse.json(
        { error: "Credential changed. Retry using its current state.", code: "STALE_CREDENTIAL" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
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

      let validationStatus: CredentialValidationStatus | null = null;
      if (body.data.action === "prefer") {
        const stalePreference = new Error("Stale credential preference");
        try {
          await db.transaction(async (tx) => {
            await lockUserAuthority(tx, authz.session.user.id);
            await clearOtherCredentialPreferences(tx, authz.session.user.id, owned.id);
            const updated = await tx
            .update(providerCredential)
            .set({ isPreferred: true, updatedAt: nextRevision })
            .where(snapshotCondition)
            .returning({ id: providerCredential.id });
            if (updated.length !== 1) throw stalePreference;
          });
        } catch (error) {
          if (error === stalePreference) return staleResult();
          throw error;
        }
      } else if (body.data.action === "disable") {
        const updated = await db
          .update(providerCredential)
          .set({
            status: "disabled",
            disabledAt: new Date(),
            updatedAt: nextRevision,
          })
          .where(snapshotCondition)
          .returning({ id: providerCredential.id });
        if (updated.length !== 1) return staleResult();
      } else {
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

          if (owned.status === "pending_validation") {
            // Legacy pending rows have no background job. Persist a retryable
            // outcome before probing so interruption or a failed ledger write
            // cannot leave this stored key appearing to validate forever.
            const [started] = await db.update(providerCredential).set({
              status: "unreachable",
              failureCode: "VALIDATION_INCOMPLETE",
              updatedAt: nextRevision,
            }).where(snapshotCondition).returning({ updatedAtToken: providerCredentialUpdatedAtToken });
            if (!started) return staleResult();
            snapshotCondition = and(
              eq(providerCredential.id, owned.id),
              eq(providerCredential.userId, owned.userId),
              eq(providerCredential.keyVersion, owned.keyVersion),
              eq(providerCredentialUpdatedAtToken, started.updatedAtToken),
            );
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
            const updated = await db
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
                lastValidatedAt: new Date(),
                disabledAt: null,
                updatedAt: nextRevision,
              })
              .where(snapshotCondition)
              .returning({ id: providerCredential.id });
            if (updated.length !== 1) return staleResult();
          } else {
            const updated = await db
              .update(providerCredential)
              .set({
                status: validation.status,
                failureCode: validation.failureCode,
                lastValidatedAt: new Date(),
                ...(body.data.action === "enable" ? { disabledAt: null } : {}),
                updatedAt: nextRevision,
              })
              .where(snapshotCondition)
              .returning({ id: providerCredential.id });
            if (updated.length !== 1) return staleResult();
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
          validationStatus && validationStatus !== "active"
            ? "failure"
            : "success",
        metadata: { provider: owned.provider, validationStatus },
      });
      await notifyCredentialChanged({
        userId: authz.session.user.id,
        provider: owned.provider,
        action: body.data.action,
        idempotencySeed: `${owned.id}:${body.data.action}:${body.data.requestId}`,
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
    { policy: "credential_write_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const jsonBody = await readBoundedJson(request);
      if (jsonBody.response?.status === 413) return jsonBody.response;
      const body = deleteSchema.safeParse(jsonBody.value);
      if (!body.success) {
        return NextResponse.json(
          { error: "A stable request ID is required." },
          { status: 400, headers: { "Cache-Control": "no-store" } },
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
      const deleted = await db
        .delete(providerCredential)
        .where(
          and(
            eq(providerCredential.id, id),
            eq(providerCredential.userId, authz.session.user.id),
          ),
        )
        .returning({ id: providerCredential.id, provider: providerCredential.provider });
      if (!deleted[0]) return NextResponse.json({ error: "Credential not found." }, { status: 404 });
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: authz.session.user.id,
        action: "credential.delete",
        resourceType: "provider_credential",
        resourceId: deleted[0].id,
        outcome: "success",
        metadata: { provider: deleted[0].provider },
      });
      await notifyCredentialChanged({
        userId: authz.session.user.id,
        provider: deleted[0].provider,
        action: "delete",
        idempotencySeed: `${deleted[0].id}:delete:${body.data.requestId}`,
      });
      return new NextResponse(null, { status: 204 });
    },
  );
}
