import type {
  KnowledgeComponent,
  RequiredAchievement,
  SkillPrerequisite,
  SkillProgress,
} from "./types";

export interface PrerequisiteFailure {
  readonly prerequisite: SkillPrerequisite;
  readonly actualStage?: SkillProgress["stage"];
}

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly missing: readonly PrerequisiteFailure[];
}

const INDEPENDENT_OR_LATER = new Set<SkillProgress["stage"]>([
  "INDEPENDENT_PRACTICE",
  "EXAM_READY",
  "PASSED",
  "MASTERED",
  "REVIEW_DUE",
]);

const EXAM_READY_OR_LATER = new Set<SkillProgress["stage"]>([
  "EXAM_READY",
  "PASSED",
  "MASTERED",
  "REVIEW_DUE",
]);

export function hasAchievement(
  progress: SkillProgress,
  required: RequiredAchievement,
): boolean {
  switch (required) {
    case "INDEPENDENT_PRACTICE":
      return (
        INDEPENDENT_OR_LATER.has(progress.stage) ||
        progress.passedAtMs !== undefined ||
        progress.masteredAtMs !== undefined
      );
    case "EXAM_READY":
      return (
        EXAM_READY_OR_LATER.has(progress.stage) ||
        progress.passedAtMs !== undefined ||
        progress.masteredAtMs !== undefined
      );
    case "PASSED":
      return (
        progress.passedAtMs !== undefined ||
        progress.masteredAtMs !== undefined
      );
    case "MASTERED":
      return progress.masteredAtMs !== undefined;
  }
}

export function indexProgress(
  progress: readonly SkillProgress[],
): ReadonlyMap<string, SkillProgress> {
  const indexed = new Map<string, SkillProgress>();
  for (const item of progress) {
    if (indexed.has(item.skillId)) {
      throw new Error(`duplicate progress for skill ${item.skillId}`);
    }
    indexed.set(item.skillId, item);
  }
  return indexed;
}

export function evaluatePrerequisites(
  component: Pick<KnowledgeComponent, "prerequisites">,
  progressBySkill: ReadonlyMap<string, SkillProgress>,
): EligibilityResult {
  const missing: PrerequisiteFailure[] = [];

  for (const prerequisite of component.prerequisites) {
    const progress = progressBySkill.get(prerequisite.skillId);
    if (
      progress === undefined ||
      !hasAchievement(progress, prerequisite.requiredAchievement)
    ) {
      missing.push({
        prerequisite,
        actualStage: progress?.stage,
      });
    }
  }

  return { eligible: missing.length === 0, missing };
}

export function eligibleKnowledgeComponents(
  components: readonly KnowledgeComponent[],
  progressBySkill: ReadonlyMap<string, SkillProgress>,
): readonly KnowledgeComponent[] {
  return components.filter(
    (component) =>
      !progressBySkill.has(component.id) &&
      evaluatePrerequisites(component, progressBySkill).eligible,
  );
}

export function findPrerequisiteCycles(
  components: readonly Pick<KnowledgeComponent, "id" | "prerequisites">[],
): readonly (readonly string[])[] {
  const graph = new Map(
    components.map((component) => [
      component.id,
      component.prerequisites.map((item) => item.skillId),
    ]),
  );
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();

  const visit = (id: string): void => {
    if (!graph.has(id)) {
      return;
    }
    if (state.get(id) === "visited") {
      return;
    }
    if (state.get(id) === "visiting") {
      const start = stack.lastIndexOf(id);
      const cycle = [...stack.slice(start), id];
      const canonicalNodes = [...new Set(cycle.slice(0, -1))].sort();
      const key = canonicalNodes.join("|");
      if (!seenCycleKeys.has(key)) {
        seenCycleKeys.add(key);
        cycles.push(cycle);
      }
      return;
    }

    state.set(id, "visiting");
    stack.push(id);
    for (const prerequisite of graph.get(id) ?? []) {
      visit(prerequisite);
    }
    stack.pop();
    state.set(id, "visited");
  };

  for (const component of components) {
    visit(component.id);
  }

  return cycles;
}
