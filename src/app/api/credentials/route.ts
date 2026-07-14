import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { validateProviderCredential } from "@/lib/ai/credential-validation";
import { notifyCredentialChanged } from "@/lib/credential-notifications";
import { db } from "@/lib/db/client";
import { providerCredential } from "@/lib/db/schema";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { parseMasterKey, sealCredential } from "@/lib/security/credential-vault";
import { withRateLimit } from "@/lib/security/rate-limit";
import { requireRecentMfa } from "@/lib/security/recent-mfa";
import {
  consentPurposeForProvider,
  getCurrentConsents,
  hasCurrentConsent,
  isCurrentConsentAccepted,
} from "@/lib/privacy/consent";

const providers = [
  "nvidia_nim",
  "openrouter",
  "google",
  "openai",
  "anthropic",
  "deepseek",
  "custom_openai_compatible",
] as const;

const createSchema = z.object({
  provider: z.enum(providers),
  label: z.string().trim().min(2).max(60),
  secret: z.string().trim().min(8).max(4_096),
  preferred: z.boolean().default(false),
});

function masterKey() {
  const configured = process.env.CREDENTIAL_MASTER_KEY;
  if (!configured) throw new Error("CREDENTIAL_MASTER_KEY is not configured.");
  return parseMasterKey(configured);
}

export async function GET() {
  const authz = await requireAuth({ allowPending: true });
  if (!authz.session) return authz.response;
  const credentials = await db
    .select({
      id: providerCredential.id,
      provider: providerCredential.provider,
      label: providerCredential.label,
      lastFour: providerCredential.lastFour,
      status: providerCredential.status,
      isPreferred: providerCredential.isPreferred,
      lastValidatedAt: providerCredential.lastValidatedAt,
      lastUsedAt: providerCredential.lastUsedAt,
      failureCode: providerCredential.failureCode,
      createdAt: providerCredential.createdAt,
    })
    .from(providerCredential)
    .where(eq(providerCredential.userId, authz.session.user.id))
    .orderBy(asc(providerCredential.createdAt));
  const currentConsents = await getCurrentConsents(authz.session.user.id);
  return NextResponse.json(
    {
      credentials: credentials.map((credential) => {
        const purpose = consentPurposeForProvider(credential.provider);
        return {
          ...credential,
          routingConsented: purpose ? isCurrentConsentAccepted(currentConsents, purpose) : false,
        };
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth({ allowPending: true });
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "credential_write_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
  const mfa = await requireRecentMfa({
    sessionId: authz.session.session.id,
    userId: authz.session.user.id,
    action: "credential.add",
  });
  if (!mfa.allowed) return mfa.response;

  const body = createSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "Provider, label, and a valid key are required." }, { status: 400 });
  }
  const providerPurpose = consentPurposeForProvider(body.data.provider);
  if (!providerPurpose || !(await hasCurrentConsent(authz.session.user.id, providerPurpose))) {
    return NextResponse.json(
      {
        error: "Explicit consent for this AI provider is required before storing or using its key.",
        code: "PROVIDER_CONSENT_REQUIRED",
      },
      { status: 409 },
    );
  }

  let wrappingKey: Buffer;
  try {
    wrappingKey = masterKey();
  } catch {
    return NextResponse.json(
      { error: "Credential storage is not configured by the administrator." },
      { status: 503 },
    );
  }

  const credentialId = randomUUID();
  const context = {
    credentialId,
    userId: authz.session.user.id,
    provider: body.data.provider,
    keyVersion: 1,
  };
  const sealed = sealCredential(body.data.secret, context, wrappingKey);
  wrappingKey.fill(0);

  if (body.data.preferred) {
    await db
      .update(providerCredential)
      .set({ isPreferred: false })
      .where(
        and(
          eq(providerCredential.userId, authz.session.user.id),
          eq(providerCredential.provider, body.data.provider),
        ),
      );
  }
  await db.insert(providerCredential).values({
    id: credentialId,
    userId: authz.session.user.id,
    provider: body.data.provider,
    label: body.data.label,
    ciphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    wrapIv: sealed.wrapIv,
    dataIv: sealed.dataIv,
    authTag: sealed.authTag,
    keyVersion: sealed.keyVersion,
    lastFour: sealed.lastFour,
    isPreferred: body.data.preferred,
  });

  const validation = await validateProviderCredential({
    userId: authz.session.user.id,
    credentialId,
    provider: body.data.provider,
    secret: body.data.secret,
  });
  const { status, failureCode } = validation;
  if (validation.model) {
    await db
      .update(providerCredential)
      .set({ status, failureCode, lastValidatedAt: new Date() })
      .where(eq(providerCredential.id, credentialId));
  }

  await writeAuditEvent({
    actorUserId: authz.session.user.id,
    subjectUserId: authz.session.user.id,
    action: "credential.add",
    resourceType: "provider_credential",
    resourceId: credentialId,
    outcome: status === "active" || status === "pending_validation" ? "success" : "failure",
    metadata: { provider: body.data.provider, status, lastFour: sealed.lastFour },
  });
  await notifyCredentialChanged({
    userId: authz.session.user.id,
    provider: body.data.provider,
    action: "add",
    idempotencySeed: `${credentialId}:add`,
  });
  return NextResponse.json(
    {
      credential: {
        id: credentialId,
        provider: body.data.provider,
        label: body.data.label,
        lastFour: sealed.lastFour,
        status,
        isPreferred: body.data.preferred,
      },
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    },
  );
}
