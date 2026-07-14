export const LEARNING_STAGES = [
  "UNSEEN",
  "DIAGNOSTIC",
  "LEARNING",
  "GUIDED_PRACTICE",
  "INDEPENDENT_PRACTICE",
  "EXAM_READY",
  "PASSED",
  "MASTERED",
  "REVIEW_DUE",
  "REMEDIATION",
] as const;

export type LearningStage = (typeof LEARNING_STAGES)[number];

export const EVIDENCE_LEVELS = [
  "E0",
  "E1",
  "E2",
  "E3",
  "E4",
  "E5",
  "E6",
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const ASSISTANCE_LEVELS = ["A0", "A1", "A2", "A3", "A4"] as const;

export type AssistanceLevel = (typeof ASSISTANCE_LEVELS)[number];

export interface EvidenceObservation {
  readonly id: string;
  readonly skillId: string;
  readonly itemVariantId: string;
  readonly evidenceLevel: EvidenceLevel;
  readonly assistanceLevel: AssistanceLevel;
  readonly correct: boolean;
  readonly occurredAtMs: number;
  readonly learningOpportunity: boolean;
  readonly solutionRevealed?: boolean;
  readonly misconceptionTags?: readonly string[];
}

export interface ActiveMisconception {
  readonly tag: string;
  readonly blocking: boolean;
  readonly confirmedAtMs: number;
}

export interface SkillProgress {
  readonly skillId: string;
  readonly stage: LearningStage;
  readonly masteryProbability: number;
  readonly passedAtMs?: number;
  readonly masteredAtMs?: number;
  readonly activeMisconceptions: readonly ActiveMisconception[];
  readonly evidence: readonly EvidenceObservation[];
}

export type RequiredAchievement =
  | "INDEPENDENT_PRACTICE"
  | "EXAM_READY"
  | "PASSED"
  | "MASTERED";

export interface SkillPrerequisite {
  readonly skillId: string;
  readonly requiredAchievement: RequiredAchievement;
}

export interface KnowledgeComponent {
  readonly id: string;
  readonly prerequisites: readonly SkillPrerequisite[];
  readonly goalPriority: number;
  readonly prerequisiteCentrality: number;
  readonly optional?: boolean;
}

export function evidenceRank(level: EvidenceLevel): number {
  return EVIDENCE_LEVELS.indexOf(level);
}

export function assistanceRank(level: AssistanceLevel): number {
  return ASSISTANCE_LEVELS.indexOf(level);
}

export function assertFiniteNonNegative(
  value: number,
  name: string,
): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

export function assertProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
}
