import { AI_PROVIDER_CATALOG } from "./provider-catalog";
import type { ProviderCandidate } from "./router";

export interface LearnerModelPolicy {
  id: string;
  provider: string;
  model: string;
  operation: string;
  enabled: boolean;
  priority: number;
}

export function learnerModelSettings(policies: readonly LearnerModelPolicy[], preferredId: string | null) {
  const enabled = policies.filter((row) => row.operation === "tutor" && row.enabled)
    .sort((left, right) => left.priority - right.priority);
  const models = enabled.map((row) => ({
    key: row.id,
    name: row.model,
    provider: AI_PROVIDER_CATALOG.find((provider) => provider.id === row.provider)?.label ?? "Custom OpenAI-compatible",
  }));
  const selected = models.find((model) => model.key === preferredId);
  return {
    models,
    selectedKey: selected?.key ?? null,
    defaultModel: models[0] ?? null,
    unavailable: preferredId !== null && !selected,
  };
}

// Preserve learner-owned key precedence and every remaining fallback position.
// Frozen administrator fallback grants are never changed by a preference.
export function prioritizeLearnerModel(candidates: readonly ProviderCandidate[], policy: LearnerModelPolicy | null | undefined): ProviderCandidate[] {
  if (!policy?.enabled || policy.operation !== "tutor") return [...candidates];
  const matches = (candidate: ProviderCandidate) => candidate.source !== "admin_fallback"
    && candidate.provider === policy.provider && candidate.model === policy.model;
  return [...candidates].sort((left, right) => {
    const ownerOrder = Number(left.source !== "learner") - Number(right.source !== "learner");
    return ownerOrder || Number(matches(right)) - Number(matches(left));
  });
}
