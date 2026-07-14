export type SupportedProvider =
  | "nvidia_nim"
  | "openrouter"
  | "google"
  | "openai"
  | "anthropic"
  | "deepseek"
  | "custom_openai_compatible";

export interface TutorMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  provider: SupportedProvider;
  apiKey: string;
  model: string;
  messages: TutorMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ProviderResult {
  provider: SupportedProvider;
  model: string;
  content: string;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  requestId: string | null;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "AUTHENTICATION"
      | "RATE_LIMIT"
      | "TIMEOUT"
      | "UNAVAILABLE"
      | "BAD_RESPONSE"
      | "POLICY"
      | "UNKNOWN",
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
