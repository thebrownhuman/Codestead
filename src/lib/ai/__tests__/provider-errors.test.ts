import { afterEach, describe, expect, it, vi } from "vitest";

import { callProvider } from "../providers";

const messages = [
  { role: "system" as const, content: "Teach safely." },
  { role: "user" as const, content: "Explain variables." },
];

function request(provider: Parameters<typeof callProvider>[0]["provider"] = "nvidia_nim") {
  return { provider, apiKey: "provider-secret", model: "test-model", messages };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("provider protocol and response hardening", () => {
  it.each([
    ["nvidia_nim", "https://integrate.api.nvidia.com/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
    ["google", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
    ["openai", "https://api.openai.com/v1/chat/completions"],
    ["deepseek", "https://api.deepseek.com/v1/chat/completions"],
  ] as const)("uses the fixed %s endpoint", async (provider, endpoint) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "Safe response" }, finish_reason: "stop" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await callProvider(request(provider));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(endpoint);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe("error");
  });

  it("uses Anthropic's native protocol and separates system instructions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "anthropic-request",
      model: "claude-test",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "A variable stores a value." }],
      usage: { input_tokens: 12, output_tokens: 7 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await callProvider(request("anthropic"));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.headers).toMatchObject({
      "x-api-key": "provider-secret", "anthropic-version": "2023-06-01",
    });
    const body = JSON.parse(String(options.body));
    expect(body.system).toBe("Teach safely.");
    expect(body.messages).toEqual([{ role: "user", content: "Explain variables." }]);
    expect(String(options.body)).not.toContain("provider-secret");
    expect(response).toMatchObject({ content: "A variable stores a value.", inputTokens: 12, outputTokens: 7 });
  });

  it.each([
    [401, "AUTHENTICATION"], [403, "AUTHENTICATION"], [429, "RATE_LIMIT"],
    [500, "UNAVAILABLE"], [503, "UNAVAILABLE"], [400, "UNKNOWN"],
  ])("normalizes HTTP %s without reflecting the response body", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private prompt echoed here", {
      status,
      headers: status === 429 ? { "retry-after": "17" } : undefined,
    })));
    const error = await callProvider(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code, status });
    expect((error as Error).message).not.toContain("private prompt echoed here");
    if (status === 429) expect(error).toMatchObject({ retryAfterSeconds: 17 });
  });

  it.each([
    {},
    { choices: [] },
    { choices: [{ message: { content: null } }] },
    { choices: [{ message: { content: "   " } }] },
  ])("rejects malformed or empty OpenAI-compatible payload %#", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    await expect(callProvider(request())).rejects.toMatchObject({ code: "BAD_RESPONSE" });
  });

  it("normalizes network failures without exposing their details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("DNS failure including internal hostname")));
    const error = await callProvider(request()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UNAVAILABLE", message: "Provider request failed." });
  });

  it("normalizes aborts as timeouts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })));
    const pending = callProvider({ ...request(), timeoutMs: 1 });
    const rejection = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(1_001);
    await rejection;
  });

  it.each([
    [-10, 1], [0, 1], [2.9, 2], [100_000, 32_768], [Number.NaN, 1_500],
  ])("clamps output token request %s to %s", async (requested, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "Safe response" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await callProvider({ ...request(), maxOutputTokens: requested });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.max_tokens).toBe(expected);
  });

  it("blocks custom providers unless HTTPS and explicitly host-allowlisted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(callProvider(request("custom_openai_compatible")))
      .rejects.toMatchObject({ code: "POLICY" });

    vi.stubEnv("CUSTOM_OPENAI_BASE_URL", "http://llm.example.test/v1");
    vi.stubEnv("CUSTOM_OPENAI_ALLOWED_HOSTS", "llm.example.test");
    await expect(callProvider(request("custom_openai_compatible")))
      .rejects.toMatchObject({ code: "POLICY" });

    vi.stubEnv("CUSTOM_OPENAI_BASE_URL", "https://evil.example.test/v1");
    await expect(callProvider(request("custom_openai_compatible")))
      .rejects.toMatchObject({ code: "POLICY" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls an allowlisted custom provider without permitting URL path injection", async () => {
    vi.stubEnv("CUSTOM_OPENAI_BASE_URL", "https://llm.example.test/v1/");
    vi.stubEnv("CUSTOM_OPENAI_ALLOWED_HOSTS", "other.test, LLM.EXAMPLE.TEST");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "Safe response" }, finish_reason: "stop" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await callProvider(request("custom_openai_compatible"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://llm.example.test/v1/chat/completions");
  });
});
