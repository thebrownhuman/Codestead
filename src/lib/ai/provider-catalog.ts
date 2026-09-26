/**
 * Self-serve provider list shown in onboarding and settings. Kept separate
 * from providerDefinitions (src/lib/ai/providers.ts) because it's UI copy,
 * not routing config. custom_openai_compatible is intentionally left out:
 * it only works when an administrator has configured an allowlisted base
 * URL, so it isn't a self-serve option here.
 */
export type CatalogProviderId =
  | "google"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "deepseek"
  | "nvidia_nim";

export const AI_PROVIDER_CATALOG: ReadonlyArray<{
  id: CatalogProviderId;
  label: string;
  hint: string;
  keyUrl: string;
}> = [
  { id: "google", label: "Google Gemini", hint: "Has a free tier — a good default if you don't have a key yet.", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openai", label: "OpenAI", hint: "GPT models. Pay-as-you-go API key.", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic", hint: "Claude models. Pay-as-you-go API key.", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openrouter", label: "OpenRouter", hint: "One key routes to many providers' models.", keyUrl: "https://openrouter.ai/keys" },
  { id: "deepseek", label: "DeepSeek", hint: "Low-cost API key, strong for code.", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "nvidia_nim", label: "NVIDIA NIM", hint: "Hosted open models via NVIDIA's API.", keyUrl: "https://build.nvidia.com/" },
];

/**
 * Default model per provider used when no administrator has configured a
 * provider_policy row (tutor operation or credential validation). Without
 * this, any provider besides nvidia_nim has no route at all: a learner with
 * only e.g. a Google key gets silently skipped even though their key works.
 * Each default is overridable per-provider via the listed env var; an admin
 * provider_policy row always takes precedence over both.
 */
const DEFAULT_MODEL_ENV: Record<CatalogProviderId, string> = {
  google: "GOOGLE_TUTOR_MODEL",
  openai: "OPENAI_TUTOR_MODEL",
  anthropic: "ANTHROPIC_TUTOR_MODEL",
  openrouter: "OPENROUTER_TUTOR_MODEL",
  deepseek: "DEEPSEEK_TUTOR_MODEL",
  nvidia_nim: "NVIDIA_NIM_TUTOR_MODEL",
};

const DEFAULT_MODEL_FALLBACK: Record<CatalogProviderId, string> = {
  google: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
  openrouter: "openai/gpt-4o-mini",
  deepseek: "deepseek-chat",
  nvidia_nim: "openai/gpt-oss-20b",
};

export function defaultModelForProvider(provider: CatalogProviderId): string {
  const configured = process.env[DEFAULT_MODEL_ENV[provider]]?.trim();
  return configured || DEFAULT_MODEL_FALLBACK[provider];
}
