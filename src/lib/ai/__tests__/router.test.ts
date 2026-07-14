import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callProvider: vi.fn() }));
vi.mock("../providers", () => ({ callProvider: mocks.callProvider }));

import {
  canonicalProviderModelAlias,
  conservativeMessageTokenUpperBound,
  hasMandatoryNimCredential,
  routeTutorRequest,
  type FallbackReservation,
  type ProviderCandidate,
} from "../router";
import { fallbackCostPaise } from "../fallback-budget";
import { ProviderError, type ProviderResult } from "../types";

const NOW = new Date("2026-07-12T00:00:00.000Z");
const messages = [{ role: "user" as const, content: "Explain loops." }];
const allowedProviders = ["nvidia_nim", "openrouter", "deepseek"] as const;

function candidate(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    ownerUserId: "learner-1",
    credentialId: "credential-1",
    provider: "nvidia_nim",
    apiKey: "provider-secret",
    model: "model-1",
    maxOutputTokens: 500,
    timeoutMs: 10_000,
    source: "learner",
    ...overrides,
  };
}

function result(overrides: Partial<ProviderResult> = {}): ProviderResult {
  return {
    provider: "nvidia_nim",
    model: "model-1",
    content: "A loop repeats work.",
    finishReason: "stop",
    inputTokens: 10,
    outputTokens: 8,
    latencyMs: 20,
    requestId: "request-1",
    ...overrides,
  };
}

describe("AI provider isolation and fallback policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the first successful permitted provider with source attribution", async () => {
    mocks.callProvider.mockResolvedValue(result());
    await expect(routeTutorRequest({
      learnerId: "learner-1", candidates: [candidate()], allowedProviders, messages, now: NOW,
    })).resolves.toEqual({ result: result(), credentialId: "credential-1", source: "learner" });
    expect(mocks.callProvider).toHaveBeenCalledWith({
      provider: "nvidia_nim",
      apiKey: "provider-secret",
      model: "model-1",
      messages,
      maxOutputTokens: 500,
      timeoutMs: 10_000,
    });
  });

  it("never calls another learner's key or an expired, exhausted, or incomplete fallback grant", async () => {
    mocks.callProvider.mockResolvedValue(result());
    const own = candidate({ credentialId: "own-final" });
    await routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      messages,
      now: NOW,
      candidates: [
        candidate({ ownerUserId: "learner-2", credentialId: "foreign", apiKey: "foreign-secret" }),
        candidate({ provider: "openai", credentialId: "unconsented", apiKey: "unconsented-secret" }),
        candidate({ source: "admin_fallback", ownerUserId: "admin", credentialId: "no-expiry" }),
        candidate({ source: "admin_fallback", ownerUserId: "admin", credentialId: "expired", fallbackExpiresAt: NOW, fallbackTokensRemaining: 100 }),
        candidate({ source: "admin_fallback", ownerUserId: "admin", credentialId: "exhausted", fallbackExpiresAt: new Date(NOW.getTime() + 1), fallbackTokensRemaining: 0 }),
        candidate({ source: "admin_fallback", ownerUserId: "admin", credentialId: "negative", fallbackExpiresAt: new Date(NOW.getTime() + 1), fallbackTokensRemaining: -1 }),
        own,
      ],
    });
    expect(mocks.callProvider).toHaveBeenCalledOnce();
    expect(mocks.callProvider.mock.calls[0]?.[0]).toMatchObject({ apiKey: own.apiKey });
    expect(JSON.stringify(mocks.callProvider.mock.calls)).not.toContain("foreign-secret");
    expect(JSON.stringify(mocks.callProvider.mock.calls)).not.toContain("unconsented-secret");
  });

  it("allows a non-expired fallback with positive remaining budget regardless of credential owner", async () => {
    mocks.callProvider.mockResolvedValue(result({ provider: "openrouter" }));
    const fallback = candidate({
      source: "admin_fallback",
      ownerUserId: "admin",
      credentialId: "fallback",
      provider: "openrouter",
      fallbackGrantId: "grant-1",
      fallbackStartsAt: new Date(NOW.getTime() - 1),
      fallbackExpiresAt: new Date(NOW.getTime() + 60_000),
      fallbackTokensRemaining: conservativeMessageTokenUpperBound(messages) + 7,
      fallbackCostRemainingPaise: 100,
      fallbackInputPaisePerMillionTokens: 100_000,
      fallbackOutputPaisePerMillionTokens: 200_000,
    });
    const routed = await routeTutorRequest({
      learnerId: "learner-1", candidates: [fallback], allowedProviders, messages, now: NOW,
      reserveFallback: async () => true,
      reconcileFallback: async () => undefined,
    });
    expect(routed).toMatchObject({ credentialId: "fallback", source: "admin_fallback" });
    expect(mocks.callProvider).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 7 }));
  });

  it("atomically reserves a fallback upper bound before the provider call and reconciles measured use", async () => {
    mocks.callProvider.mockResolvedValue(result({ provider: "openrouter", inputTokens: 10, outputTokens: 8 }));
    const inputBound = conservativeMessageTokenUpperBound(messages);
    const reserveFallback = vi.fn(async (reservation: FallbackReservation) => {
      void reservation;
      return true;
    });
    const reconcileFallback = vi.fn(async (
      reservation: FallbackReservation & { actualTokens: number; actualCostPaise: number },
    ) => {
      void reservation;
    });
    await routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      messages,
      now: NOW,
      candidates: [candidate({
        source: "admin_fallback",
        ownerUserId: "admin",
        credentialId: "fallback",
        fallbackGrantId: "grant-1",
        provider: "openrouter",
        fallbackStartsAt: new Date(NOW.getTime() - 1),
        fallbackExpiresAt: new Date(NOW.getTime() + 60_000),
        fallbackTokensRemaining: inputBound + 40,
        fallbackCostRemainingPaise: 100,
        fallbackInputPaisePerMillionTokens: 100_000,
        fallbackOutputPaisePerMillionTokens: 200_000,
      })],
      reserveFallback,
      reconcileFallback,
    });
    const reservedCost = fallbackCostPaise({
      inputTokens: inputBound,
      outputTokens: 40,
      inputPaisePerMillionTokens: 100_000,
      outputPaisePerMillionTokens: 200_000,
    });
    const [reservation] = reserveFallback.mock.calls[0] ?? [];
    expect(reservation).toEqual({
      reservationId: expect.any(String),
      grantId: "grant-1",
      credentialId: "fallback",
      provider: "openrouter",
      model: "model-1",
      reservationTokens: inputBound + 40,
      reservationCostPaise: reservedCost,
    });
    expect(reconcileFallback).toHaveBeenCalledWith({
      reservationId: reservation!.reservationId,
      grantId: "grant-1",
      credentialId: "fallback",
      provider: "openrouter",
      model: "model-1",
      reservationTokens: inputBound + 40,
      reservationCostPaise: reservedCost,
      actualTokens: 18,
      actualCostPaise: 3,
    });
  });

  it("never calls a fallback provider when the atomic reservation loses a race", async () => {
    const inputBound = conservativeMessageTokenUpperBound(messages);
    const reserveFallback = vi.fn(async () => false);
    const promise = routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      messages,
      now: NOW,
      candidates: [candidate({
        source: "admin_fallback",
        ownerUserId: "admin",
        credentialId: "fallback",
        fallbackGrantId: "grant-1",
        fallbackStartsAt: new Date(NOW.getTime() - 1),
        fallbackExpiresAt: new Date(NOW.getTime() + 60_000),
        fallbackTokensRemaining: inputBound + 100,
        fallbackCostRemainingPaise: 100,
        fallbackInputPaisePerMillionTokens: 100_000,
        fallbackOutputPaisePerMillionTokens: 200_000,
      })],
      reserveFallback,
      reconcileFallback: async () => undefined,
    });
    await expect(promise).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(reserveFallback).toHaveBeenCalledOnce();
    expect(mocks.callProvider).not.toHaveBeenCalled();
  });

  it("reports normalized failures in order and continues to the next candidate", async () => {
    mocks.callProvider
      .mockRejectedValueOnce(new ProviderError("rate limited", "RATE_LIMIT", 429, 30))
      .mockRejectedValueOnce(new Error("opaque unexpected failure"))
      .mockResolvedValueOnce(result({ provider: "deepseek" }));
    const onFailure = vi.fn(async () => undefined);
    const routed = await routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      messages,
      candidates: [
        candidate({ credentialId: "first" }),
        candidate({ credentialId: "second", provider: "openrouter" }),
        candidate({ credentialId: "third", provider: "deepseek" }),
      ],
      onFailure,
    });
    expect(routed.credentialId).toBe("third");
    expect(onFailure.mock.calls).toEqual([
      [{ credentialId: "first", provider: "nvidia_nim", code: "RATE_LIMIT", status: 429 }],
      [{ credentialId: "second", provider: "openrouter", code: "UNKNOWN", status: undefined }],
    ]);
  });

  it("exhausts enabled learner keys in order before an eligible fallback even when fallback is supplied first", async () => {
    const inputBound = conservativeMessageTokenUpperBound(messages);
    mocks.callProvider
      .mockRejectedValueOnce(new ProviderError("unavailable", "UNAVAILABLE", 503))
      .mockRejectedValueOnce(new ProviderError("rate limited", "RATE_LIMIT", 429))
      .mockResolvedValueOnce(result({ provider: "openrouter" }));
    const routed = await routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      messages,
      now: NOW,
      candidates: [
        candidate({
          source: "admin_fallback",
          ownerUserId: "admin",
          credentialId: "admin-last",
          apiKey: "admin-key",
          provider: "openrouter",
          fallbackGrantId: "grant-1",
          fallbackStartsAt: new Date(NOW.getTime() - 1),
          fallbackExpiresAt: new Date(NOW.getTime() + 60_000),
          fallbackTokensRemaining: inputBound + 100,
          fallbackCostRemainingPaise: 100,
          fallbackInputPaisePerMillionTokens: 100_000,
          fallbackOutputPaisePerMillionTokens: 200_000,
        }),
        candidate({ credentialId: "preferred-first", apiKey: "preferred-key" }),
        candidate({ credentialId: "secondary-second", apiKey: "secondary-key" }),
      ],
      reserveFallback: async () => true,
      reconcileFallback: async () => undefined,
    });
    expect(routed).toMatchObject({ credentialId: "admin-last", source: "admin_fallback" });
    expect(mocks.callProvider.mock.calls.map(([request]) => request.apiKey)).toEqual([
      "preferred-key",
      "secondary-key",
      "admin-key",
    ]);
  });

  it("keeps the full fallback reservation when usage is missing and when the provider fails", async () => {
    const inputBound = conservativeMessageTokenUpperBound(messages);
    const fallback = candidate({
      source: "admin_fallback",
      ownerUserId: "admin",
      credentialId: "fallback",
      provider: "openrouter",
      fallbackGrantId: "grant-1",
      fallbackStartsAt: new Date(NOW.getTime() - 1),
      fallbackExpiresAt: new Date(NOW.getTime() + 60_000),
      fallbackTokensRemaining: inputBound + 20,
      fallbackCostRemainingPaise: 100,
      fallbackInputPaisePerMillionTokens: 100_000,
      fallbackOutputPaisePerMillionTokens: 200_000,
    });
    const reconcileMissing = vi.fn(async (
      reservation: FallbackReservation & { actualTokens: number; actualCostPaise: number },
    ) => {
      void reservation;
    });
    mocks.callProvider.mockResolvedValueOnce(result({
      provider: "openrouter",
      inputTokens: null,
      outputTokens: null,
    }));
    await routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      candidates: [fallback],
      messages,
      now: NOW,
      reserveFallback: async () => true,
      reconcileFallback: reconcileMissing,
    });
    expect(reconcileMissing).toHaveBeenCalledWith(expect.objectContaining({
      actualTokens: inputBound + 20,
      actualCostPaise: expect.any(Number),
    }));
    const missingReservation = reconcileMissing.mock.calls[0]?.[0];
    expect(missingReservation?.actualCostPaise).toBe(missingReservation?.reservationCostPaise);

    const reconcileFailure = vi.fn(async (
      reservation: FallbackReservation & { actualTokens: number; actualCostPaise: number },
    ) => {
      void reservation;
    });
    mocks.callProvider.mockRejectedValueOnce(new ProviderError("unavailable", "UNAVAILABLE", 503));
    await expect(routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      candidates: [fallback],
      messages,
      now: NOW,
      reserveFallback: async () => true,
      reconcileFallback: reconcileFailure,
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const failedReservation = reconcileFailure.mock.calls[0]?.[0];
    expect(failedReservation?.actualTokens).toBe(failedReservation?.reservationTokens);
    expect(failedReservation?.actualCostPaise).toBe(failedReservation?.reservationCostPaise);
  });

  it("rejects a mismatched provider-reported model and keeps the full fallback reservation", async () => {
    const inputBound = conservativeMessageTokenUpperBound(messages);
    const reconcileFallback = vi.fn(async (
      _reservation: FallbackReservation & { actualTokens: number; actualCostPaise: number },
    ) => {
      void _reservation;
    });
    const onFailure = vi.fn(async () => undefined);
    mocks.callProvider.mockResolvedValueOnce(result({
      provider: "openrouter",
      model: "different-model",
      inputTokens: 1,
      outputTokens: 1,
    }));

    await expect(routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      messages,
      now: NOW,
      candidates: [candidate({
        source: "admin_fallback",
        ownerUserId: "admin",
        credentialId: "fallback",
        provider: "openrouter",
        model: "model-1",
        fallbackGrantId: "grant-1",
        fallbackStartsAt: new Date(NOW.getTime() - 1),
        fallbackExpiresAt: new Date(NOW.getTime() + 60_000),
        fallbackTokensRemaining: inputBound + 20,
        fallbackCostRemainingPaise: 100,
        fallbackInputPaisePerMillionTokens: 100_000,
        fallbackOutputPaisePerMillionTokens: 200_000,
      })],
      reserveFallback: async () => true,
      reconcileFallback,
      onFailure,
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const reconciled = reconcileFallback.mock.calls[0]?.[0];
    expect(reconciled?.actualTokens).toBe(reconciled?.reservationTokens);
    expect(reconciled?.actualCostPaise).toBe(reconciled?.reservationCostPaise);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "BAD_RESPONSE" }));
  });

  it("accepts Google's documented models/ alias and rejects malformed aliases", async () => {
    mocks.callProvider.mockResolvedValueOnce(result({
      provider: "google",
      model: "models/gemini-2.5-flash",
    }));
    await expect(routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders: ["google"],
      messages,
      candidates: [candidate({ provider: "google", model: "gemini-2.5-flash" })],
    })).resolves.toMatchObject({ result: { model: "models/gemini-2.5-flash" } });
    expect(canonicalProviderModelAlias("openai", " model\nname ")).toBeNull();
    expect(canonicalProviderModelAlias("google", "models/")).toBeNull();
  });

  it("fails in deterministic degraded mode without calling a provider when none is permitted", async () => {
    const promise = routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders,
      messages,
      now: NOW,
      candidates: [
        candidate({ ownerUserId: "someone-else" }),
        candidate({ source: "admin_fallback", fallbackExpiresAt: new Date(NOW.getTime() - 1), fallbackTokensRemaining: 10 }),
      ],
    });
    await expect(promise).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("authored lesson and deterministic practice are still available"),
    });
    expect(mocks.callProvider).not.toHaveBeenCalled();
  });
});

describe("mandatory NVIDIA credential policy", () => {
  it("requires the learner's own NVIDIA NIM credential", () => {
    expect(hasMandatoryNimCredential([
      { provider: "nvidia_nim", source: "learner", ownerUserId: "learner-1" },
    ], "learner-1")).toBe(true);
    expect(hasMandatoryNimCredential([
      { provider: "nvidia_nim", source: "learner", ownerUserId: "learner-2" },
      { provider: "nvidia_nim", source: "admin_fallback", ownerUserId: "admin" },
      { provider: "openai", source: "learner", ownerUserId: "learner-1" },
    ], "learner-1")).toBe(false);
  });
});
