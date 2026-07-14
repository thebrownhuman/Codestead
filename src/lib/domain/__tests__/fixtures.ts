import type {
  EvidenceObservation,
  SkillProgress,
} from "../types";

export function evidence(
  overrides: Partial<EvidenceObservation> = {},
): EvidenceObservation {
  return {
    id: "evidence-1",
    skillId: "skill-a",
    itemVariantId: "variant-1",
    evidenceLevel: "E4",
    assistanceLevel: "A0",
    correct: true,
    occurredAtMs: 1_000,
    learningOpportunity: true,
    ...overrides,
  };
}

export function progress(
  overrides: Partial<SkillProgress> = {},
): SkillProgress {
  return {
    skillId: "skill-a",
    stage: "LEARNING",
    masteryProbability: 0.2,
    activeMisconceptions: [],
    evidence: [],
    ...overrides,
  };
}
