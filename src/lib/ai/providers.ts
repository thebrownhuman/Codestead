import { z } from "zod";

import {
  ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type SupportedProvider,
} from "./types";

const openAiResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullable() }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

const anthropicResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
  usage: z
    .object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() })
    .optional(),
});

export const providerDefinitions: Record<
  Exclude<SupportedProvider, "custom_openai_compatible">,
  { baseUrl: string; protocol: "openai" | "anthropic" }
> = {
  nvidia_nim: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    protocol: "openai",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "openai",
  },
  openai: { baseUrl: "https://api.openai.com/v1", protocol: "openai" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
};

function providerError(status: number, retryAfter: string | null) {
  if (status === 401 || status === 403) {
    return new ProviderError("Provider rejected the credential.", "AUTHENTICATION", status);
  }
  if (status === 429) {
    const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : undefined;
    return new ProviderError(
      "Provider rate limit reached.",
      "RATE_LIMIT",
      status,
      Number.isFinite(seconds) ? seconds : undefined,
    );
  }
  if (status >= 500) {
    return new ProviderError("Provider is temporarily unavailable.", "UNAVAILABLE", status);
  }
  return new ProviderError("Provider request was rejected.", "UNKNOWN", status);
}

function safeCustomBaseUrl() {
  const configured = process.env.CUSTOM_OPENAI_BASE_URL;
  if (!configured) {
    throw new ProviderError(
      "Custom provider is not configured by the administrator.",
      "POLICY",
    );
  }
  const url = new URL(configured);
  if (url.protocol !== "https:") {
    throw new ProviderError("Custom provider must use HTTPS.", "POLICY");
  }
  const allowedHosts = (process.env.CUSTOM_OPENAI_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new ProviderError("Custom provider host is not allowlisted.", "POLICY");
  }
  return configured.replace(/\/$/, "");
}

export async function callProvider(request: ProviderRequest): Promise<ProviderResult> {
  const startedAt = performance.now();
  const definition =
    request.provider === "custom_openai_compatible"
      ? { baseUrl: safeCustomBaseUrl(), protocol: "openai" as const }
      : providerDefinitions[request.provider];
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 30_000, 1_000), 120_000);
  const requestedOutputTokens = request.maxOutputTokens ?? 1_500;
  const maxOutputTokens = Number.isFinite(requestedOutputTokens)
    ? Math.min(Math.max(Math.trunc(requestedOutputTokens), 1), 32_768)
    : 1_500;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const isAnthropic = definition.protocol === "anthropic";
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const url = `${definition.baseUrl}/${isAnthropic ? "messages" : "chat/completions"}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (isAnthropic) {
      headers["x-api-key"] = request.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${request.apiKey}`;
      if (request.provider === "openrouter") {
        headers["http-referer"] = process.env.APP_URL ?? "http://localhost:3000";
        headers["x-title"] = process.env.APP_NAME ?? "Codestead";
      }
    }

    const body = isAnthropic
      ? {
          model: request.model,
          system: system || undefined,
          messages: request.messages
            .filter((message) => message.role !== "system")
            .map((message) => ({ role: message.role, content: message.content })),
          temperature: request.temperature ?? 0.2,
          max_tokens: maxOutputTokens,
        }
      : {
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: maxOutputTokens,
          stream: false,
        };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });

    if (!response.ok) {
      // Do not include provider response bodies: they can reflect submitted content.
      throw providerError(response.status, response.headers.get("retry-after"));
    }

    const raw: unknown = await response.json();
    if (isAnthropic) {
      const parsed = anthropicResponseSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError("Malformed provider response.", "BAD_RESPONSE");
      const content = parsed.data.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      if (!content) throw new ProviderError("Provider returned no tutor text.", "BAD_RESPONSE");
      return {
        provider: request.provider,
        model: parsed.data.model ?? request.model,
        content,
        finishReason: parsed.data.stop_reason ?? null,
        inputTokens: parsed.data.usage?.input_tokens ?? null,
        outputTokens: parsed.data.usage?.output_tokens ?? null,
        latencyMs: Math.round(performance.now() - startedAt),
        requestId: parsed.data.id ?? response.headers.get("request-id"),
      };
    }

    const parsed = openAiResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError("Malformed provider response.", "BAD_RESPONSE");
    const choice = parsed.data.choices[0];
    const content = choice?.message.content?.trim();
    if (!content) throw new ProviderError("Provider returned no tutor text.", "BAD_RESPONSE");
    return {
      provider: request.provider,
      model: parsed.data.model ?? request.model,
      content,
      finishReason: choice.finish_reason ?? null,
      inputTokens: parsed.data.usage?.prompt_tokens ?? null,
      outputTokens: parsed.data.usage?.completion_tokens ?? null,
      latencyMs: Math.round(performance.now() - startedAt),
      requestId: parsed.data.id ?? response.headers.get("x-request-id"),
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ProviderError("Provider request timed out.", "TIMEOUT");
    }
    throw new ProviderError("Provider request failed.", "UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}
