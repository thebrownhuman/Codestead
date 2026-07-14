import { and, eq, gt, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  adminFallbackGrant,
  adminFallbackReservation,
  providerCredential,
  user,
} from "@/lib/db/schema";
import {
  consentPurposeForProvider,
  getCurrentConsentsFrom,
  isCurrentConsentAccepted,
} from "@/lib/privacy/consent";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

import type { SupportedProvider } from "./types";

const TOKENS_PER_MILLION = 1_000_000n;

function isSafeNonNegativeInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function fallbackCostPaise(input: {
  inputTokens: number;
  outputTokens: number;
  inputPaisePerMillionTokens: number;
  outputPaisePerMillionTokens: number;
}) {
  if (
    !isSafeNonNegativeInteger(input.inputTokens) ||
    !isSafeNonNegativeInteger(input.outputTokens) ||
    !isSafeNonNegativeInteger(input.inputPaisePerMillionTokens) ||
    !isSafeNonNegativeInteger(input.outputPaisePerMillionTokens)
  ) {
    throw new RangeError("Fallback token counts and pricing must be safe non-negative integers.");
  }
  const numerator =
    BigInt(input.inputTokens) * BigInt(input.inputPaisePerMillionTokens) +
    BigInt(input.outputTokens) * BigInt(input.outputPaisePerMillionTokens);
  const roundedUp = numerator === 0n
    ? 0n
    : (numerator + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;
  const result = Number(roundedUp);
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("Fallback cost exceeds safe accounting bounds.");
  }
  return result;
}

class FallbackBudgetUnavailableError extends Error {}

export async function reserveFallbackBudget(input: {
  reservationId: string;
  grantId: string;
  learnerId: string;
  credentialId: string;
  provider: SupportedProvider;
  model: string;
  tokens: number;
  costPaise: number;
  now?: Date;
}) {
  if (
    !Number.isSafeInteger(input.tokens) ||
    !Number.isSafeInteger(input.costPaise) ||
    input.tokens < 1 ||
    input.costPaise < 1
  ) {
    return false;
  }
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      // Consent mutation takes this same per-learner lock before appending a
      // decision. Whichever transaction commits first therefore determines
      // whether this reservation may authorize provider transmission.
      await lockUserAuthority(tx, input.learnerId);
      const [authority] = await tx
        .select({
          grantId: adminFallbackGrant.id,
          learnerId: adminFallbackGrant.learnerId,
          credentialId: adminFallbackGrant.credentialId,
          provider: adminFallbackGrant.provider,
          model: adminFallbackGrant.model,
          grantedBy: adminFallbackGrant.grantedBy,
          tokenBudget: adminFallbackGrant.tokenBudget,
          tokensUsed: adminFallbackGrant.tokensUsed,
          rupeeBudgetPaise: adminFallbackGrant.rupeeBudgetPaise,
          rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
          credentialOwnerId: providerCredential.userId,
        })
        .from(adminFallbackGrant)
        .innerJoin(providerCredential, eq(providerCredential.id, adminFallbackGrant.credentialId))
        .innerJoin(user, eq(user.id, adminFallbackGrant.learnerId))
        .where(and(
          eq(adminFallbackGrant.id, input.grantId),
          eq(adminFallbackGrant.learnerId, input.learnerId),
          eq(adminFallbackGrant.credentialId, input.credentialId),
          eq(adminFallbackGrant.provider, input.provider),
          eq(adminFallbackGrant.model, input.model),
          eq(adminFallbackGrant.status, "active"),
          eq(user.status, "active"),
          lte(adminFallbackGrant.startsAt, now),
          gt(adminFallbackGrant.expiresAt, now),
          eq(providerCredential.status, "active"),
        ))
        .limit(1)
        .for("update");
      if (
        !authority ||
        authority.credentialOwnerId !== authority.grantedBy ||
        authority.tokensUsed + input.tokens > authority.tokenBudget ||
        authority.rupeesUsedPaise + input.costPaise > authority.rupeeBudgetPaise
      ) throw new FallbackBudgetUnavailableError();

      const currentConsents = await getCurrentConsentsFrom(tx, input.learnerId);
      const providerPurpose = consentPurposeForProvider(authority.provider);
      if (
        !isCurrentConsentAccepted(currentConsents, "admin_fallback_ai") ||
        !providerPurpose ||
        !isCurrentConsentAccepted(currentConsents, providerPurpose)
      ) throw new FallbackBudgetUnavailableError();

      const inserted = await tx
        .insert(adminFallbackReservation)
        .values({
          id: input.reservationId,
          grantId: input.grantId,
          learnerId: input.learnerId,
          reservedTokens: input.tokens,
          reservedPaise: input.costPaise,
        })
        .onConflictDoNothing({ target: adminFallbackReservation.id })
        .returning({ id: adminFallbackReservation.id });
      if (!inserted[0]) {
        const [existing] = await tx
          .select({
            grantId: adminFallbackReservation.grantId,
            learnerId: adminFallbackReservation.learnerId,
            reservedTokens: adminFallbackReservation.reservedTokens,
            reservedPaise: adminFallbackReservation.reservedPaise,
            status: adminFallbackReservation.status,
          })
          .from(adminFallbackReservation)
          .where(eq(adminFallbackReservation.id, input.reservationId))
          .limit(1);
        return existing?.grantId === input.grantId &&
          existing.learnerId === input.learnerId &&
          existing.reservedTokens === input.tokens &&
          existing.reservedPaise === input.costPaise &&
          existing.status === "reserved";
      }

      const [reserved] = await tx
        .update(adminFallbackGrant)
        .set({
          tokensUsed: sql`${adminFallbackGrant.tokensUsed} + ${input.tokens}`,
          rupeesUsedPaise: sql`${adminFallbackGrant.rupeesUsedPaise} + ${input.costPaise}`,
        })
        .where(
          and(
            eq(adminFallbackGrant.id, input.grantId),
            eq(adminFallbackGrant.learnerId, input.learnerId),
            eq(adminFallbackGrant.credentialId, input.credentialId),
            eq(adminFallbackGrant.provider, input.provider),
            eq(adminFallbackGrant.model, input.model),
            eq(adminFallbackGrant.status, "active"),
            lte(adminFallbackGrant.startsAt, now),
            gt(adminFallbackGrant.expiresAt, now),
            sql`${adminFallbackGrant.tokensUsed} + ${input.tokens} <= ${adminFallbackGrant.tokenBudget}`,
            sql`${adminFallbackGrant.rupeesUsedPaise} + ${input.costPaise} <= ${adminFallbackGrant.rupeeBudgetPaise}`,
          ),
        )
        .returning({
          tokensUsed: adminFallbackGrant.tokensUsed,
          rupeesUsedPaise: adminFallbackGrant.rupeesUsedPaise,
        });
      if (!reserved) throw new FallbackBudgetUnavailableError();
      return true;
    });
  } catch (error) {
    if (error instanceof FallbackBudgetUnavailableError) return false;
    throw error;
  }
}

export async function reconcileFallbackBudget(input: {
  reservationId: string;
  grantId: string;
  learnerId: string;
  reservedTokens: number;
  reservedCostPaise: number;
  actualTokens: number;
  actualCostPaise: number;
  now?: Date;
}) {
  if (
    !Number.isSafeInteger(input.reservedTokens) ||
    !Number.isSafeInteger(input.reservedCostPaise) ||
    !Number.isSafeInteger(input.actualTokens) ||
    !Number.isSafeInteger(input.actualCostPaise) ||
    input.reservedTokens < 1 ||
    input.reservedCostPaise < 1 ||
    input.actualTokens < 0 ||
    input.actualCostPaise < 0 ||
    input.actualTokens > input.reservedTokens ||
    input.actualCostPaise > input.reservedCostPaise
  ) {
    throw new RangeError("Fallback reconciliation is outside the reservation.");
  }
  await db.transaction(async (tx) => {
    const [reservation] = await tx
      .select({
        grantId: adminFallbackReservation.grantId,
        learnerId: adminFallbackReservation.learnerId,
        reservedTokens: adminFallbackReservation.reservedTokens,
        reservedPaise: adminFallbackReservation.reservedPaise,
        actualTokens: adminFallbackReservation.actualTokens,
        actualPaise: adminFallbackReservation.actualPaise,
        status: adminFallbackReservation.status,
      })
      .from(adminFallbackReservation)
      .where(eq(adminFallbackReservation.id, input.reservationId))
      .limit(1)
      .for("update");
    if (
      !reservation ||
      reservation.grantId !== input.grantId ||
      reservation.learnerId !== input.learnerId ||
      reservation.reservedTokens !== input.reservedTokens ||
      reservation.reservedPaise !== input.reservedCostPaise
    ) {
      throw new Error("Fallback reservation was not found or did not match.");
    }
    if (reservation.status === "reconciled") {
      if (
        reservation.actualTokens === input.actualTokens &&
        reservation.actualPaise === input.actualCostPaise
      ) return;
      throw new Error("Fallback reservation was already reconciled differently.");
    }

    const tokenRefund = input.reservedTokens - input.actualTokens;
    const costRefund = input.reservedCostPaise - input.actualCostPaise;
    const [grant] = await tx
      .update(adminFallbackGrant)
      .set({
        tokensUsed: sql`greatest(0, ${adminFallbackGrant.tokensUsed} - ${tokenRefund})`,
        rupeesUsedPaise: sql`greatest(0, ${adminFallbackGrant.rupeesUsedPaise} - ${costRefund})`,
      })
      .where(
        and(
          eq(adminFallbackGrant.id, input.grantId),
          eq(adminFallbackGrant.learnerId, input.learnerId),
        ),
      )
      .returning({ id: adminFallbackGrant.id });
    if (!grant) throw new Error("Fallback grant no longer exists.");

    await tx
      .update(adminFallbackReservation)
      .set({
        actualTokens: input.actualTokens,
        actualPaise: input.actualCostPaise,
        status: "reconciled",
        reconciledAt: input.now ?? new Date(),
      })
      .where(eq(adminFallbackReservation.id, input.reservationId));
  });
}
