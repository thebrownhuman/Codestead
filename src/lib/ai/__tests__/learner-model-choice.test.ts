// @vitest-environment node
import { describe, expect, it } from "vitest";
import { learnerModelSettings, prioritizeLearnerModel } from "../learner-model-choice";
import type { ProviderCandidate } from "../router";

const policies = [
  { id: "a", provider: "openai", model: "default", operation: "tutor", enabled: true, priority: 1 },
  { id: "b", provider: "google", model: "chosen", operation: "tutor", enabled: true, priority: 2 },
  { id: "c", provider: "openrouter", model: "disabled", operation: "tutor", enabled: false, priority: 0 },
  { id: "d", provider: "openai", model: "connection", operation: "provider_configuration", enabled: true, priority: 0 },
];
describe("learner model choice", () => {
  it("exposes only enabled tutor models and no connection or key metadata", () => {
    const settings = learnerModelSettings(policies, "b");
    expect(settings.models.map((model) => model.key)).toEqual(["a", "b"]);
    expect(settings.selectedKey).toBe("b");
    expect(settings.defaultModel?.name).toBe("default");
    expect(Object.keys(settings.models[0]).sort()).toEqual(["key", "name", "provider"]);
  });
  it.each(["c", "d", "missing"])("uses default and shows a notice for unavailable saved choice %s", (key) => {
    expect(learnerModelSettings(policies, key)).toMatchObject({ selectedKey: null, unavailable: true, defaultModel: { name: "default" } });
  });
  it("use default has no unavailable notice", () => {
    expect(learnerModelSettings(policies, null)).toMatchObject({ selectedKey: null, unavailable: false });
  });
  it("promotes the chosen model while preserving owned keys and the remaining fallback order", () => {
    const candidates = [
      { provider: "openai", model: "default", source: "learner" },
      { provider: "openai", model: "default", source: "platform" },
      { provider: "google", model: "chosen", source: "platform" },
      { provider: "openrouter", model: "last", source: "platform" },
    ] as ProviderCandidate[];
    expect(prioritizeLearnerModel(candidates, policies[1])).toEqual([candidates[0], candidates[2], candidates[1], candidates[3]]);
    expect(prioritizeLearnerModel(candidates, { ...policies[1], enabled: false })).toEqual(candidates);
    expect(prioritizeLearnerModel(candidates, null)).toEqual(candidates);
  });
});
