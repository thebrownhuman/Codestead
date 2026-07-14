import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  adminFallbackGrant,
  providerCredential,
  providerPolicy,
  user,
} from "@/lib/db/schema";
import {
  consentPurposeForProvider,
  getCurrentConsentsFrom,
  isCurrentConsentAccepted,
} from "@/lib/privacy/consent";
import { writeAuditEventInTransaction } from "@/lib/security/audit-writer";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

import { notifyFallbackGrantChangedInTransaction } from "./fallback-notifications";
import { canonicalProviderOperationHash } from "./provider-operation-idempotency";
import type { SupportedProvider } from "./types";

const grantProjection = {
  id: adminFallbackGrant.id,
  learnerId: adminFallbackGrant.learnerId,
  credentialId: adminFallbackGrant.credentialId,
  provider: adminFallbackGrant.provider,
  model: adminFallbackGrant.model,
  tokenBudget: adminFallbackGrant.tokenBudget,
  tokensUsed: adminFallbackGrant.tokensUsed,
  rupeeBudgetPaise: adminFallbackGrant.rupeeBudgetPaise,
  rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
  inputPaisePerMillionTokens: adminFallbackGrant.inputPaisePerMillionTokens,
  outputPaisePerMillionTokens: adminFallbackGrant.outputPaisePerMillionTokens,
  startsAt: adminFallbackGrant.startsAt,
  expiresAt: adminFallbackGrant.expiresAt,
  status: adminFallbackGrant.status,
  revokedAt: adminFallbackGrant.revokedAt,
  createRequestHash: adminFallbackGrant.createRequestHash,
  revokeRequestId: adminFallbackGrant.revokeRequestId,
  revokeRequestHash: adminFallbackGrant.revokeRequestHash,
  revokedBy: adminFallbackGrant.revokedBy,
} as const;

export type FallbackGrantView = Readonly<{
  id: string;
  learnerId: string;
  credentialId: string;
  provider: SupportedProvider;
  model: string;
  tokenBudget: number;
  tokensUsed: number;
  rupeeBudgetPaise: number;
  rupeesUsedPaise: number;
  inputPaisePerMillionTokens: number;
  outputPaisePerMillionTokens: number;
  startsAt: Date;
  expiresAt: Date;
  status: string;
  revokedAt: Date | null;
  credentialLastFour: string;
}>;

function toFallbackGrantView(input: FallbackGrantView): FallbackGrantView {
  return {
    id: input.id,
    learnerId: input.learnerId,
    credentialId: input.credentialId,
    provider: input.provider,
    model: input.model,
    tokenBudget: input.tokenBudget,
    tokensUsed: input.tokensUsed,
    rupeeBudgetPaise: input.rupeeBudgetPaise,
    rupeesUsedPaise: input.rupeesUsedPaise,
    inputPaisePerMillionTokens: input.inputPaisePerMillionTokens,
    outputPaisePerMillionTokens: input.outputPaisePerMillionTokens,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    status: input.status,
    revokedAt: input.revokedAt,
    credentialLastFour: input.credentialLastFour,
  };
}

export type FallbackGrantCommandErrorCode =
  | "IDEMPOTENCY_KEY_REUSED"
  | "INVALID_EXPIRY"
  | "ACTIVE_GRANT_CONFLICT"
  | "LEARNER_OR_CREDENTIAL_NOT_FOUND"
  | "MODEL_UNAVAILABLE"
  | "CONSENT_REQUIRED"
  | "GRANT_NOT_FOUND"
  | "GRANT_ALREADY_REVOKED";

export type FallbackGrantCommandResult<T> =
  | Readonly<{ ok: true; value: T; replayed: boolean }>
  | Readonly<{
      ok: false;
      code: FallbackGrantCommandErrorCode;
      provider?: SupportedProvider;
    }>;

function createHash(input: CreateFallbackGrantInput) {
  return canonicalProviderOperationHash({
    action: "fallback_grant.create",
    learnerId: input.learnerId,
    credentialId: input.credentialId,
    model: input.model,
    tokenBudget: input.tokenBudget,
    rupeeBudgetPaise: input.rupeeBudgetPaise,
    inputPaisePerMillionTokens: input.inputPaisePerMillionTokens,
    outputPaisePerMillionTokens: input.outputPaisePerMillionTokens,
    expiresAt: input.expiresAt.toISOString(),
    reason: input.reason,
  });
}

export type CreateFallbackGrantInput = Readonly<{
  actorUserId: string;
  learnerId: string;
  credentialId: string;
  model: string;
  tokenBudget: number;
  rupeeBudgetPaise: number;
  inputPaisePerMillionTokens: number;
  outputPaisePerMillionTokens: number;
  expiresAt: Date;
  reason: string;
  requestId: string;
  now?: Date;
}>;

export async function createFallbackGrantCommand(
  input: CreateFallbackGrantInput,
): Promise<FallbackGrantCommandResult<FallbackGrantView>> {
  const now = input.now ?? new Date();
  const inputHash = createHash(input);
  return db.transaction(async (tx) => {
    await lockUserAuthority(tx, input.learnerId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fallback-create:${input.actorUserId}:${input.requestId}`}))`);
    const [existing] = await tx
      .select({ ...grantProjection, credentialLastFour: providerCredential.lastFour })
      .from(adminFallbackGrant)
      .innerJoin(providerCredential, eq(providerCredential.id, adminFallbackGrant.credentialId))
      .where(and(
        eq(adminFallbackGrant.grantedBy, input.actorUserId),
        eq(adminFallbackGrant.createRequestId, input.requestId),
      ))
      .limit(1);
    if (existing) {
      if (existing.createRequestHash !== inputHash) return { ok: false, code: "IDEMPOTENCY_KEY_REUSED" };
      return { ok: true, value: toFallbackGrantView(existing), replayed: true };
    }
    if (
      input.expiresAt.getTime() < now.getTime() + 5 * 60_000 ||
      input.expiresAt.getTime() > now.getTime() + 30 * 24 * 60 * 60_000
    ) return { ok: false, code: "INVALID_EXPIRY" };

    const [learner] = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(
        eq(user.id, input.learnerId),
        eq(user.role, "learner"),
        inArray(user.status, ["pending", "active"]),
      ))
      .limit(1);
    const [credential] = await tx
      .select({
        id: providerCredential.id,
        provider: providerCredential.provider,
        lastFour: providerCredential.lastFour,
      })
      .from(providerCredential)
      .where(and(
        eq(providerCredential.id, input.credentialId),
        eq(providerCredential.userId, input.actorUserId),
        eq(providerCredential.status, "active"),
      ))
      .limit(1)
      .for("update");
    if (!learner || !credential) return { ok: false, code: "LEARNER_OR_CREDENTIAL_NOT_FOUND" };

    const [modelPolicy] = await tx
      .select({ id: providerPolicy.id })
      .from(providerPolicy)
      .where(and(
        eq(providerPolicy.provider, credential.provider),
        eq(providerPolicy.operation, "tutor"),
        eq(providerPolicy.model, input.model),
        eq(providerPolicy.enabled, true),
      ))
      .limit(1);
    if (!modelPolicy) return { ok: false, code: "MODEL_UNAVAILABLE", provider: credential.provider };

    const consents = await getCurrentConsentsFrom(tx, input.learnerId);
    const providerPurpose = consentPurposeForProvider(credential.provider);
    if (
      !isCurrentConsentAccepted(consents, "admin_fallback_ai") ||
      !providerPurpose ||
      !isCurrentConsentAccepted(consents, providerPurpose)
    ) {
      return { ok: false, code: "CONSENT_REQUIRED", provider: credential.provider };
    }

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fallback-active:${input.learnerId}:${credential.provider}:${input.model}`}))`);
    const [activeConflict] = await tx
      .select({ id: adminFallbackGrant.id })
      .from(adminFallbackGrant)
      .where(and(
        eq(adminFallbackGrant.learnerId, input.learnerId),
        eq(adminFallbackGrant.provider, credential.provider),
        eq(adminFallbackGrant.model, input.model),
        eq(adminFallbackGrant.status, "active"),
        lte(adminFallbackGrant.startsAt, now),
        gt(adminFallbackGrant.expiresAt, now),
      ))
      .limit(1);
    if (activeConflict) return { ok: false, code: "ACTIVE_GRANT_CONFLICT" };

    const [grant] = await tx
      .insert(adminFallbackGrant)
      .values({
        learnerId: learner.id,
        credentialId: credential.id,
        provider: credential.provider,
        model: input.model,
        tokenBudget: input.tokenBudget,
        rupeeBudgetPaise: input.rupeeBudgetPaise,
        inputPaisePerMillionTokens: input.inputPaisePerMillionTokens,
        outputPaisePerMillionTokens: input.outputPaisePerMillionTokens,
        startsAt: now,
        expiresAt: input.expiresAt,
        status: "active",
        grantedBy: input.actorUserId,
        createRequestId: input.requestId,
        createRequestHash: inputHash,
      })
      .returning();
    if (!grant) throw new Error("Fallback grant insertion failed.");

    await writeAuditEventInTransaction(tx, {
      actorUserId: input.actorUserId,
      subjectUserId: grant.learnerId,
      action: "fallback_grant.create",
      resourceType: "admin_fallback_grant",
      resourceId: grant.id,
      reason: input.reason,
      outcome: "success",
      metadata: {
        provider: grant.provider,
        model: grant.model,
        usageUnitLimit: grant.tokenBudget,
        currencyLimitPaise: grant.rupeeBudgetPaise,
        inputRatePaisePerMillionUnits: grant.inputPaisePerMillionTokens,
        outputRatePaisePerMillionUnits: grant.outputPaisePerMillionTokens,
        expiresAt: grant.expiresAt.toISOString(),
      },
    });
    await notifyFallbackGrantChangedInTransaction(tx, {
      learnerId: grant.learnerId,
      provider: grant.provider,
      action: "enabled",
      summary: `${grant.model}; ${grant.tokenBudget} tokens; INR ${(grant.rupeeBudgetPaise / 100).toFixed(2)} until ${grant.expiresAt.toISOString()}`,
      idempotencySeed: `${grant.id}:enabled`,
    });
    return {
      ok: true,
      value: toFallbackGrantView({ ...grant, credentialLastFour: credential.lastFour }),
      replayed: false,
    };
  });
}

export type RevokeFallbackGrantInput = Readonly<{
  actorUserId: string;
  grantId: string;
  reason: string;
  requestId: string;
  now?: Date;
}>;

export async function revokeFallbackGrantCommand(
  input: RevokeFallbackGrantInput,
): Promise<FallbackGrantCommandResult<{ id: string; learnerId: string; provider: SupportedProvider; revokedAt: Date }>> {
  const revokedAt = input.now ?? new Date();
  const inputHash = canonicalProviderOperationHash({
    action: "fallback_grant.revoke",
    grantId: input.grantId,
    reason: input.reason,
  });
  // Revocation intentionally remains available while an account is becoming
  // unavailable because it can only reduce provider authority. It still
  // resolves the learner and joins the global user-authority lock order before
  // taking request or grant-row locks.
  const [destination] = await db
    .select({ learnerId: adminFallbackGrant.learnerId })
    .from(adminFallbackGrant)
    .where(eq(adminFallbackGrant.id, input.grantId))
    .limit(1);
  if (!destination) return { ok: false, code: "GRANT_NOT_FOUND" };
  return db.transaction(async (tx) => {
    await lockUserAuthority(tx, destination.learnerId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fallback-revoke:${input.actorUserId}:${input.requestId}`}))`);
    const [priorCommand] = await tx
      .select(grantProjection)
      .from(adminFallbackGrant)
      .where(and(
        eq(adminFallbackGrant.revokedBy, input.actorUserId),
        eq(adminFallbackGrant.revokeRequestId, input.requestId),
      ))
      .limit(1);
    if (priorCommand) {
      if (
        priorCommand.id !== input.grantId ||
        priorCommand.revokeRequestHash !== inputHash ||
        !priorCommand.revokedAt
      ) return { ok: false, code: "IDEMPOTENCY_KEY_REUSED" };
      return {
        ok: true,
        value: {
          id: priorCommand.id,
          learnerId: priorCommand.learnerId,
          provider: priorCommand.provider,
          revokedAt: priorCommand.revokedAt,
        },
        replayed: true,
      };
    }

    const [grant] = await tx
      .select(grantProjection)
      .from(adminFallbackGrant)
      .where(eq(adminFallbackGrant.id, input.grantId))
      .limit(1)
      .for("update");
    if (!grant) return { ok: false, code: "GRANT_NOT_FOUND" };
    if (grant.status !== "active" || grant.revokedAt) {
      return { ok: false, code: "GRANT_ALREADY_REVOKED" };
    }
    const [revoked] = await tx
      .update(adminFallbackGrant)
      .set({
        status: "revoked",
        revokedAt,
        revokedBy: input.actorUserId,
        revokeRequestId: input.requestId,
        revokeRequestHash: inputHash,
      })
      .where(and(
        eq(adminFallbackGrant.id, input.grantId),
        eq(adminFallbackGrant.status, "active"),
      ))
      .returning({ id: adminFallbackGrant.id });
    if (!revoked) return { ok: false, code: "GRANT_ALREADY_REVOKED" };

    await writeAuditEventInTransaction(tx, {
      actorUserId: input.actorUserId,
      subjectUserId: grant.learnerId,
      action: "fallback_grant.revoke",
      resourceType: "admin_fallback_grant",
      resourceId: grant.id,
      reason: input.reason,
      outcome: "success",
      metadata: { provider: grant.provider, revokedAt: revokedAt.toISOString() },
    });
    await notifyFallbackGrantChangedInTransaction(tx, {
      learnerId: grant.learnerId,
      provider: grant.provider,
      action: "revoked",
      summary: `Access ended at ${revokedAt.toISOString()}`,
      idempotencySeed: `${grant.id}:revoked`,
    });
    return {
      ok: true,
      value: { id: grant.id, learnerId: grant.learnerId, provider: grant.provider, revokedAt },
      replayed: false,
    };
  });
}
