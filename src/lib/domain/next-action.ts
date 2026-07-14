import {
  evaluatePrerequisites,
  indexProgress,
} from "./prerequisites";
import {
  computeReviewPriority,
  isReviewDue,
  type ReviewSchedule,
} from "./review";
import type {
  KnowledgeComponent,
  SkillProgress,
} from "./types";

export type NextActionKind =
  | "REMEDIATE"
  | "REVIEW"
  | "CONTINUE_SKILL"
  | "START_SKILL"
  | "CHALLENGE"
  | "NONE";

export interface SessionActionCounts {
  readonly completedActions: number;
  readonly reviewActions: number;
  readonly reviewOnly?: boolean;
}

export interface AdaptiveSelectionPolicy {
  readonly maxReviewFraction: number;
  readonly minimumReviewsBeforeCap: number;
}

export interface AdaptiveSelectionInput {
  readonly components: readonly KnowledgeComponent[];
  readonly progress: readonly SkillProgress[];
  readonly reviewSchedules: readonly ReviewSchedule[];
  readonly currentGoalSkillIds: ReadonlySet<string>;
  readonly challengeAvailableSkillIds: ReadonlySet<string>;
  readonly nowMs: number;
  readonly session: SessionActionCounts;
}

export interface NextAction {
  readonly kind: NextActionKind;
  readonly skillId?: string;
  readonly reason: string;
  readonly priorityScore: number;
}

export const DEFAULT_ADAPTIVE_SELECTION_POLICY: AdaptiveSelectionPolicy =
  Object.freeze({
    maxReviewFraction: 0.4,
    minimumReviewsBeforeCap: 1,
  });

function validatePolicy(policy: AdaptiveSelectionPolicy): void {
  if (
    !Number.isFinite(policy.maxReviewFraction) ||
    policy.maxReviewFraction < 0 ||
    policy.maxReviewFraction > 1
  ) {
    throw new RangeError("maxReviewFraction must be between 0 and 1");
  }
  if (
    !Number.isInteger(policy.minimumReviewsBeforeCap) ||
    policy.minimumReviewsBeforeCap < 0
  ) {
    throw new RangeError(
      "minimumReviewsBeforeCap must be a non-negative integer",
    );
  }
}

function validateInput(input: AdaptiveSelectionInput): void {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError("nowMs must be a finite non-negative number");
  }
  for (const [name, value] of Object.entries({
    completedActions: input.session.completedActions,
    reviewActions: input.session.reviewActions,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative integer`);
    }
  }
  if (input.session.reviewActions > input.session.completedActions) {
    throw new RangeError(
      "reviewActions cannot exceed completedActions",
    );
  }

  const componentIds = new Set<string>();
  for (const component of input.components) {
    if (componentIds.has(component.id)) {
      throw new Error(`duplicate component ${component.id}`);
    }
    componentIds.add(component.id);
  }
}

function pickHighest(
  candidates: readonly {
    skillId: string;
    score: number;
  }[],
): { skillId: string; score: number } | undefined {
  return [...candidates].sort(
    (left, right) =>
      right.score - left.score ||
      left.skillId.localeCompare(right.skillId),
  )[0];
}

function reviewAllowed(
  session: SessionActionCounts,
  policy: AdaptiveSelectionPolicy,
): boolean {
  if (session.reviewOnly) {
    return true;
  }
  if (session.reviewActions < policy.minimumReviewsBeforeCap) {
    return true;
  }
  if (session.completedActions === 0) {
    return true;
  }
  return (
    (session.reviewActions + 1) / (session.completedActions + 1) <=
    policy.maxReviewFraction
  );
}

export function selectNextAction(
  input: AdaptiveSelectionInput,
  policy: AdaptiveSelectionPolicy =
    DEFAULT_ADAPTIVE_SELECTION_POLICY,
): NextAction {
  validatePolicy(policy);
  validateInput(input);

  const progressBySkill = indexProgress(input.progress);
  const componentById = new Map(
    input.components.map((component) => [component.id, component]),
  );

  const remediation = pickHighest(
    input.progress
      .filter(
        (progress) =>
          progress.stage === "REMEDIATION" ||
          progress.activeMisconceptions.some(
            (misconception) => misconception.blocking,
          ),
      )
      .map((progress) => {
        const component = componentById.get(progress.skillId);
        return {
          skillId: progress.skillId,
          score:
            1_000_000 +
            (component?.goalPriority ?? 0) * 100 +
            (component?.prerequisiteCentrality ?? 0) * 10,
        };
      }),
  );
  if (remediation !== undefined) {
    return {
      kind: "REMEDIATE",
      skillId: remediation.skillId,
      reason: "confirmed blocking misconception",
      priorityScore: remediation.score,
    };
  }

  const dueReviews = input.reviewSchedules
    .filter((schedule) => isReviewDue(schedule, input.nowMs))
    .flatMap((schedule) => {
      const component = componentById.get(schedule.skillId);
      if (component === undefined) {
        return [];
      }
      return [
        {
          skillId: schedule.skillId,
          score: computeReviewPriority({
            schedule,
            nowMs: input.nowMs,
            goalPriority: component.goalPriority,
            prerequisiteCentrality: component.prerequisiteCentrality,
          }),
        },
      ];
    });
  const dueReview = pickHighest(dueReviews);
  if (
    dueReview !== undefined &&
    reviewAllowed(input.session, policy)
  ) {
    return {
      kind: "REVIEW",
      skillId: dueReview.skillId,
      reason: "due review prioritized by overdue risk and goal relevance",
      priorityScore: 100_000 + dueReview.score,
    };
  }

  if (input.session.reviewOnly) {
    return {
      kind: "NONE",
      reason: "no due reviews",
      priorityScore: 0,
    };
  }

  const activeGoalSkill = pickHighest(
    input.components.flatMap((component) => {
      if (!input.currentGoalSkillIds.has(component.id)) {
        return [];
      }
      const progress = progressBySkill.get(component.id);
      if (
        progress === undefined ||
        progress.passedAtMs !== undefined ||
        progress.masteredAtMs !== undefined
      ) {
        return [];
      }
      if (!evaluatePrerequisites(component, progressBySkill).eligible) {
        return [];
      }
      return [
        {
          skillId: component.id,
          score:
            (1 - progress.masteryProbability) * 1_000 +
            component.goalPriority * 100 +
            component.prerequisiteCentrality * 10,
        },
      ];
    }),
  );
  if (activeGoalSkill !== undefined) {
    return {
      kind: "CONTINUE_SKILL",
      skillId: activeGoalSkill.skillId,
      reason: "weakest ready skill on the current goal path",
      priorityScore: 10_000 + activeGoalSkill.score,
    };
  }

  const newSkill = pickHighest(
    input.components.flatMap((component) => {
      if (progressBySkill.has(component.id)) {
        return [];
      }
      if (!evaluatePrerequisites(component, progressBySkill).eligible) {
        return [];
      }
      return [
        {
          skillId: component.id,
          score:
            component.goalPriority * 100 +
            component.prerequisiteCentrality * 10 -
            (component.optional ? 1 : 0),
        },
      ];
    }),
  );
  if (newSkill !== undefined) {
    return {
      kind: "START_SKILL",
      skillId: newSkill.skillId,
      reason: "highest-priority new skill with satisfied prerequisites",
      priorityScore: 1_000 + newSkill.score,
    };
  }

  const challenge = [...input.challengeAvailableSkillIds]
    .filter((skillId) => progressBySkill.has(skillId))
    .sort()[0];
  if (challenge !== undefined) {
    return {
      kind: "CHALLENGE",
      skillId: challenge,
      reason: "optional challenge after required work",
      priorityScore: 100,
    };
  }

  return {
    kind: "NONE",
    reason: "no eligible activity",
    priorityScore: 0,
  };
}
