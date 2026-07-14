import { afterEach, describe, expect, it, vi } from "vitest";

import { callProvider } from "../providers";
import { routeTutorRequest } from "../router";
import { ProviderError } from "../types";

const messages = [{ role: "user" as const, content: "Explain variables." }];

afterEach(() => vi.unstubAllGlobals());

describe("provider adapters", () => {
  it("calls NVIDIA's server-owned endpoint without leaking the key in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "request-1",
          model: "test-model",
          choices: [{ message: { content: "A variable is a labeled box." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callProvider({
      provider: "nvidia_nim",
      apiKey: "test-only-provider-secret",
      model: "test-model",
      messages,
    });

    expect(result.content).toContain("labeled box");
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect((options.headers as Record<string, string>).authorization).toContain(
      "test-only-provider-secret",
    );
    expect(options.body).not.toContain("test-only-provider-secret");
  });

  it("normalizes authentication errors without returning provider bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "echoed-secret" } }), {
          status: 401,
        }),
      ),
    );
    await expect(
      callProvider({
        provider: "nvidia_nim",
        apiKey: "test-only-provider-secret",
        model: "test-model",
        messages,
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION" });
  });
});

describe("provider routing", () => {
  it("never uses another learner's credential and can use an active capped fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Fallback answer" } }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const routed = await routeTutorRequest({
      learnerId: "learner-1",
      allowedProviders: ["nvidia_nim", "openrouter"],
      messages,
      candidates: [
        {
          ownerUserId: "other-learner",
          credentialId: "forbidden",
          provider: "nvidia_nim",
          apiKey: "forbidden-key",
          model: "model",
          source: "learner",
        },
        {
          ownerUserId: "learner-1",
          credentialId: "own",
          provider: "nvidia_nim",
          apiKey: "own-key",
          model: "model",
          source: "learner",
        },
        {
          ownerUserId: "admin",
          credentialId: "fallback",
          provider: "openrouter",
          apiKey: "fallback-key",
          model: "model",
          source: "admin_fallback",
          fallbackGrantId: "grant-1",
          fallbackStartsAt: new Date("2026-07-11T00:00:00Z"),
          fallbackExpiresAt: new Date("2026-08-01T00:00:00Z"),
          fallbackTokensRemaining: 1_000,
          fallbackCostRemainingPaise: 1_000,
          fallbackInputPaisePerMillionTokens: 100_000,
          fallbackOutputPaisePerMillionTokens: 200_000,
        },
      ],
      now: new Date("2026-07-12T00:00:00Z"),
      reserveFallback: async () => true,
      reconcileFallback: async () => undefined,
    });

    expect(routed.credentialId).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const serializedCalls = JSON.stringify(fetchMock.mock.calls);
    expect(serializedCalls).not.toContain("forbidden-key");
  });

  it("returns a clear degraded-mode error when all providers fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    await expect(
      routeTutorRequest({
        learnerId: "learner-1",
        allowedProviders: ["nvidia_nim"],
        messages,
        candidates: [
          {
            ownerUserId: "learner-1",
            credentialId: "own",
            provider: "nvidia_nim",
            apiKey: "own-key",
            model: "model",
            source: "learner",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
