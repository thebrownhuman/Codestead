import { randomUUID } from "node:crypto";

import { callProvider } from "./providers";
import { AUTHORED_TUTOR_FALLBACK_MESSAGE } from "./context";
import { fallbackCostPaise } from "./fallback-budget";
import { ProviderError, type ProviderResult, type SupportedProvider, type TutorMessage } from "./types";

export interface ProviderCandidate {
  ownerUserId: string;
  credentialId: string;
  provider: SupportedProvider;
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  source: "learner" | "admin_fallback";
  fallbackGrantId?: string;
  fallbackStartsAt?: Date;
  fallbackExpiresAt?: Date;
  fallbackTokensRemaining?: number;
  fallbackCostRemainingPaise?: number;
  fallbackInputPaisePerMillionTokens?: number;
  fallbackOutputPaisePerMillionTokens?: number;
}

export interface RoutingFailure {
  credentialId: string;
  provider: SupportedProvider;
  code: ProviderError["code"];
  status?: number;
}

export interface FallbackReservation {
  reservationId: string;
  grantId: string;
  credentialId: string;
  provider: SupportedProvider;
  model: string;
  reservationTokens: number;
  reservationCostPaise: number;
}

export function conservativeMessageTokenUpperBound(messages: readonly TutorMessage[]) {
  // A UTF-8 byte bound is intentionally more conservative than a tokenizer
  // estimate for the supported text models and avoids provider-specific drift.
  return Math.max(1, Buffer.byteLength(JSON.stringify(messages), "utf8"));
}

export function canonicalProviderModelAlias(provider: SupportedProvider, value: string) {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!normalized || normalized.length > 200 || !/^[a-z0-9][a-z0-9._:/@+\-]*$/.test(normalized)) {
    return null;
  }
  const alias = provider === "google" && normalized.startsWith("models/")
    ? normalized.slice("models/".length)
    : normalized;
  return alias && /^[a-z0-9][a-z0-9._:/@+\-]*$/.test(alias) ? alias : null;
}

export async function routeTutorRequest(input: {
  learnerId: string;
  candidates: ProviderCandidate[];
  allowedProviders: readonly SupportedProvider[];
  messages: TutorMessage[];
  now?: Date;
  onFailure?: (failure: RoutingFailure) => Promise<void> | void;
  reserveFallback?: (reservation: FallbackReservation) => Promise<boolean>;
  reconcileFallback?: (
    reservation: FallbackReservation & { actualTokens: number; actualCostPaise: number },
  ) => Promise<void>;
}): Promise<{ result: ProviderResult; credentialId: string; source: ProviderCandidate["source"] }> {
  const now = input.now ?? new Date();
  const allowedProviders = new Set(input.allowedProviders);
  const candidates = input.candidates
    .map((candidate, ordinal) => ({ candidate, ordinal }))
    .filter(({ candidate }) => {
      if (!allowedProviders.has(candidate.provider)) return false;
      if (candidate.source === "learner") return candidate.ownerUserId === input.learnerId;
      return (
        candidate.fallbackGrantId !== undefined &&
        candidate.fallbackStartsAt !== undefined &&
        candidate.fallbackStartsAt <= now &&
        candidate.fallbackExpiresAt !== undefined &&
        candidate.fallbackExpiresAt > now &&
        (candidate.fallbackTokensRemaining ?? 0) > 0 &&
        (candidate.fallbackCostRemainingPaise ?? 0) > 0 &&
        (candidate.fallbackInputPaisePerMillionTokens ?? 0) > 0 &&
        (candidate.fallbackOutputPaisePerMillionTokens ?? 0) > 0
      );
    })
    // Learner-owned enabled keys are always exhausted in their supplied order
    // before an administrator-funded destination can receive the prompt.
    .sort((left, right) =>
      Number(left.candidate.source === "admin_fallback") -
        Number(right.candidate.source === "admin_fallback") ||
      left.ordinal - right.ordinal)
    .map(({ candidate }) => candidate);
  const inputTokenUpperBound = conservativeMessageTokenUpperBound(input.messages);

  for (const candidate of candidates) {
    let fallbackReservation: FallbackReservation | null = null;
    let maxOutputTokens = candidate.maxOutputTokens;
    if (candidate.source === "admin_fallback") {
      if (!input.reserveFallback || !input.reconcileFallback) continue;
      const remaining = Math.max(0, Math.floor(candidate.fallbackTokensRemaining ?? 0));
      const remainingPaise = Math.max(0, Math.floor(candidate.fallbackCostRemainingPaise ?? 0));
      const inputRate = Math.floor(candidate.fallbackInputPaisePerMillionTokens ?? 0);
      const outputRate = Math.floor(candidate.fallbackOutputPaisePerMillionTokens ?? 0);
      let availableOutput = remaining - inputTokenUpperBound;
      while (
        availableOutput > 0 &&
        fallbackCostPaise({
          inputTokens: inputTokenUpperBound,
          outputTokens: availableOutput,
          inputPaisePerMillionTokens: inputRate,
          outputPaisePerMillionTokens: outputRate,
        }) > remainingPaise
      ) {
        availableOutput = Math.floor(availableOutput / 2);
      }
      if (availableOutput < 1) continue;
      maxOutputTokens = Math.min(
        candidate.maxOutputTokens ?? availableOutput,
        availableOutput,
      );
      if (!candidate.fallbackGrantId) continue;
      const reservationCostPaise = fallbackCostPaise({
        inputTokens: inputTokenUpperBound,
        outputTokens: maxOutputTokens,
        inputPaisePerMillionTokens: inputRate,
        outputPaisePerMillionTokens: outputRate,
      });
      if (reservationCostPaise < 1 || reservationCostPaise > remainingPaise) continue;
      fallbackReservation = {
        reservationId: randomUUID(),
        grantId: candidate.fallbackGrantId,
        credentialId: candidate.credentialId,
        provider: candidate.provider,
        model: candidate.model,
        reservationTokens: inputTokenUpperBound + maxOutputTokens,
        reservationCostPaise,
      };
      if (!await input.reserveFallback(fallbackReservation)) continue;
    }

    let result: ProviderResult;
    try {
      result = await callProvider({
        provider: candidate.provider,
        apiKey: candidate.apiKey,
        model: candidate.model,
        messages: input.messages,
        maxOutputTokens,
        timeoutMs: candidate.timeoutMs,
      });
      const requestedModel = canonicalProviderModelAlias(candidate.provider, candidate.model);
      const reportedModel = canonicalProviderModelAlias(candidate.provider, result.model);
      if (!requestedModel || !reportedModel || reportedModel !== requestedModel) {
        throw new ProviderError("Provider reported an unexpected model.", "BAD_RESPONSE");
      }
    } catch (error) {
      const normalized =
        error instanceof ProviderError
          ? error
          : new ProviderError("Unexpected provider failure.", "UNKNOWN");
      if (fallbackReservation && input.reconcileFallback) {
        // Provider failure usage is unknowable from the local boundary. Keep
        // the full reservation charged so concurrency can never overspend the
        // administrator's hard caps, and close the reservation idempotently.
        await input.reconcileFallback({
          ...fallbackReservation,
          actualTokens: fallbackReservation.reservationTokens,
          actualCostPaise: fallbackReservation.reservationCostPaise,
        });
      }
      await input.onFailure?.({
        credentialId: candidate.credentialId,
        provider: candidate.provider,
        code: normalized.code,
        status: normalized.status,
      });
      continue;
    }

    if (fallbackReservation && input.reconcileFallback) {
      const measured = result.inputTokens !== null &&
        result.outputTokens !== null &&
        Number.isSafeInteger(result.inputTokens) &&
        Number.isSafeInteger(result.outputTokens) &&
        result.inputTokens >= 0 &&
        result.outputTokens >= 0;
      const actualTokens = measured
        ? result.inputTokens! + result.outputTokens!
        : fallbackReservation.reservationTokens;
      const measuredCost = measured
        ? fallbackCostPaise({
            inputTokens: result.inputTokens!,
            outputTokens: result.outputTokens!,
            inputPaisePerMillionTokens: candidate.fallbackInputPaisePerMillionTokens!,
            outputPaisePerMillionTokens: candidate.fallbackOutputPaisePerMillionTokens!,
          })
        : fallbackReservation.reservationCostPaise;
      const actualWithinReservation =
        actualTokens <= fallbackReservation.reservationTokens &&
        measuredCost <= fallbackReservation.reservationCostPaise;
      await input.reconcileFallback({
        ...fallbackReservation,
        actualTokens: actualWithinReservation
          ? actualTokens
          : fallbackReservation.reservationTokens,
        actualCostPaise: actualWithinReservation
          ? measuredCost
          : fallbackReservation.reservationCostPaise,
      });
    }
    return { result, credentialId: candidate.credentialId, source: candidate.source };
  }

  throw new ProviderError(
    AUTHORED_TUTOR_FALLBACK_MESSAGE,
    "UNAVAILABLE",
  );
}

export function hasMandatoryNimCredential(
  candidates: Array<Pick<ProviderCandidate, "provider" | "source" | "ownerUserId">>,
  learnerId: string,
) {
  return candidates.some(
    (candidate) =>
      candidate.provider === "nvidia_nim" &&
      candidate.source === "learner" &&
      candidate.ownerUserId === learnerId,
  );
}
