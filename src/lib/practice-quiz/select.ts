import { createHash } from "node:crypto";

import type { AssessmentBank, DeterministicAssessmentItem } from "@/lib/content";

import { isPracticePoolItem } from "./pool";

export const PRACTICE_QUIZ_MAX_ITEMS = 10;

export interface PracticeQuizSelectionInput {
  readonly banks: readonly AssessmentBank[];
  readonly courseId: string;
  readonly moduleId: string;
  readonly userId: string;
  readonly attemptNumber: number;
  /** Code items need the isolated runner; without it they are left out. */
  readonly runnerEnabled: boolean;
}

export interface SelectedPracticeItem {
  readonly bankId: string;
  readonly item: DeterministicAssessmentItem;
}

function order(seed: string, value: string): string {
  return createHash("sha256").update(`${seed}:${value}`).digest("hex");
}

/**
 * Picks a deterministic practice quiz for one module: one item per skill, or up to two per skill for
 * modules with fewer than three skills, capped at PRACTICE_QUIZ_MAX_ITEMS. Each retry reshuffles.
 * Only practice-pool items are ever returned.
 */
export function selectPracticeQuizItems(input: PracticeQuizSelectionInput): readonly SelectedPracticeItem[] {
  const seed = `practice-quiz:v1:${input.userId}:${input.moduleId}:${input.attemptNumber}`;
  const bySkill = new Map<string, SelectedPracticeItem[]>();
  for (const bank of input.banks) {
    if (bank.courseId !== input.courseId || bank.moduleId !== input.moduleId) continue;
    for (const item of bank.items) {
      if (!isPracticePoolItem(item)) continue;
      if (item.kind === "code" && !input.runnerEnabled) continue;
      const list = bySkill.get(item.skillId) ?? [];
      list.push({ bankId: bank.id, item });
      bySkill.set(item.skillId, list);
    }
  }
  const perSkill = bySkill.size < 3 ? 2 : 1;
  const skills = [...bySkill.keys()].sort((left, right) => order(seed, left).localeCompare(order(seed, right)));
  const picked: SelectedPracticeItem[] = [];
  for (const skillId of skills) {
    const candidates = [...bySkill.get(skillId)!]
      .sort((left, right) => order(seed, left.item.id).localeCompare(order(seed, right.item.id)));
    picked.push(...candidates.slice(0, perSkill));
  }
  return picked.slice(0, PRACTICE_QUIZ_MAX_ITEMS);
}
