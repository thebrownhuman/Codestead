import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createFallbackGrantCommand } from "@/lib/ai/fallback-grants";
import { db } from "@/lib/db/client";
import {
  adminFallbackGrant,
  providerCredential,
  providerPolicy,
  session,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";
import {
  consentPurposeForProvider,
  getCurrentConsents,
  isCurrentConsentAccepted,
} from "@/lib/privacy/consent";

const createSchema = z.object({
  learnerId: z.string().trim().min(1).max(200),
  credentialId: z.string().uuid(),
  model: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/),
  tokenBudget: z.number().int().min(100).max(10_000_000),
  rupeeBudgetPaise: z.number().int().min(100).max(10_000_000),
  inputPaisePerMillionTokens: z.number().int().min(1).max(100_000_000),
  outputPaisePerMillionTokens: z.number().int().min(1).max(100_000_000),
  expiresAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(8).max(500),
  requestId: z.string().uuid(),
});

const safeGrantColumns = {
  id: adminFallbackGrant.id,
  learnerId: adminFallbackGrant.learnerId,
  credentialId: adminFallbackGrant.credentialId,
  model: adminFallbackGrant.model,
  tokenBudget: adminFallbackGrant.tokenBudget,
  tokensUsed: adminFallbackGrant.tokensUsed,
  rupeeBudgetPaise: adminFallbackGrant.rupeeBudgetPaise,
  rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
  inputPaisePerMillionTokens: adminFallbackGrant.inputPaisePerMillionTokens,
  outputPaisePerMillionTokens: adminFallbackGrant.outputPaisePerMillionTokens,
  startsAt: adminFallbackGrant.startsAt,
  expiresAt: adminFallbackGrant.expiresAt,
  revokedAt: adminFallbackGrant.revokedAt,
  provider: adminFallbackGrant.provider,
  credentialLastFour: providerCredential.lastFour,
} as const;

export async function GET(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const learnerId = request.nextUrl.searchParams.get("learnerId")?.trim();
  const conditions = learnerId ? [eq(adminFallbackGrant.learnerId, learnerId)] : [];
  const [grants, availableCredentials, availableModels] = await Promise.all([
    db
      .select(safeGrantColumns)
      .from(adminFallbackGrant)
      .innerJoin(providerCredential, eq(providerCredential.id, adminFallbackGrant.credentialId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(adminFallbackGrant.createdAt))
      .limit(200),
    db
      .select({
        id: providerCredential.id,
        provider: providerCredential.provider,
        label: providerCredential.label,
        lastFour: providerCredential.lastFour,
      })
      .from(providerCredential)
      .where(
        and(
          eq(providerCredential.userId, authz.session.user.id),
          eq(providerCredential.status, "active"),
        ),
      )
      .orderBy(desc(providerCredential.updatedAt))
      .limit(100),
    db
      .select({ provider: providerPolicy.provider, model: providerPolicy.model })
      .from(providerPolicy)
      .where(and(eq(providerPolicy.operation, "tutor"), eq(providerPolicy.enabled, true)))
      .orderBy(providerPolicy.priority, providerPolicy.provider, providerPolicy.model)
      .limit(200),
  ]);
  const learnerConsents = learnerId ? await getCurrentConsents(learnerId) : null;
  return NextResponse.json(
    {
      grants,
      availableCredentials,
      availableModels,
      learnerConsent: learnerConsents ? {
        adminFallbackAi: isCurrentConsentAccepted(learnerConsents, "admin_fallback_ai"),
        providers: Object.fromEntries(
          availableCredentials.map((credential) => {
            const purpose = consentPurposeForProvider(credential.provider);
            return [credential.provider, purpose ? isCurrentConsentAccepted(learnerConsents, purpose) : false];
          }),
        ),
      } : null,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "fallback_grant_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = createSchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return NextResponse.json(
          { error: "Choose a learner, active administrator credential, enabled model, token and rupee caps, pricing snapshot, expiry, and reason." },
          { status: 400 },
        );
      }
      const now = new Date();
      const expiresAt = new Date(body.data.expiresAt);

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
          subjectUserId: body.data.learnerId,
          action: "fallback_grant.create",
          resourceType: "admin_fallback_grant",
          reason: body.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code },
        });
        return NextResponse.json({ error: gate.code }, { status: 403 });
      }

      const result = await createFallbackGrantCommand({
        actorUserId: authz.session.user.id,
        learnerId: body.data.learnerId,
        credentialId: body.data.credentialId,
        model: body.data.model,
        tokenBudget: body.data.tokenBudget,
        rupeeBudgetPaise: body.data.rupeeBudgetPaise,
        inputPaisePerMillionTokens: body.data.inputPaisePerMillionTokens,
        outputPaisePerMillionTokens: body.data.outputPaisePerMillionTokens,
        expiresAt,
        reason: body.data.reason,
        requestId: body.data.requestId,
        now,
      });
      if (!result.ok) {
        if (result.code === "INVALID_EXPIRY") {
          return NextResponse.json(
            { error: "Fallback access must expire between five minutes and 30 days from now." },
            { status: 400 },
          );
        }
        if (result.code === "LEARNER_OR_CREDENTIAL_NOT_FOUND") {
          return NextResponse.json(
            { error: "Eligible learner or administrator credential not found." },
            { status: 404 },
          );
        }
        if (result.code === "CONSENT_REQUIRED") {
          return NextResponse.json(
            { error: result.provider
              ? `The learner has not consented to ${result.provider} administrator fallback.`
              : "The learner has not opted in to administrator-funded AI fallback." },
            { status: 409 },
          );
        }
        if (result.code === "MODEL_UNAVAILABLE") {
          return NextResponse.json(
            { error: `Model ${body.data.model} is not an enabled tutor model for ${result.provider ?? "this provider"}.` },
            { status: 409 },
          );
        }
        return NextResponse.json(
          {
            error: result.code === "ACTIVE_GRANT_CONFLICT"
              ? "An active fallback grant already covers this learner, provider, and model. Revoke it before issuing another."
              : "This request ID was already used for a different fallback grant.",
            code: result.code,
          },
          { status: 409 },
        );
      }
      const created = result.value;
      return NextResponse.json(
        { grant: created },
        {
          status: 201,
          headers: {
            "Cache-Control": "private, no-store",
            "X-Idempotent-Replay": result.replayed ? "true" : "false",
          },
        },
      );
    },
  );
}
