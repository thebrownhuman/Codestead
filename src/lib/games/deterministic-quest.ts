import type { DeterministicAssessmentItem } from "@/lib/content";

export type QuestResponse =
  | { selectedOptionIds: string[] }
  | { gaps: Record<string, string> }
  | { trace: string };

export type QuestEvaluation = {
  correct: boolean;
  feedback: string;
  hint: string | null;
  stageAdvance: boolean;
  authoritativeEvidence: false;
};

function normalized(value: string, caseSensitive: boolean) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return caseSensitive ? trimmed : trimmed.toLocaleLowerCase("en-US");
}

export function evaluateDraftQuest(
  item: DeterministicAssessmentItem,
  response: QuestResponse,
  hintIndex = 0,
): QuestEvaluation {
  let correct = false;
  if (item.kind === "mcq" && "selectedOptionIds" in response) {
    const actual = [...new Set(response.selectedOptionIds)].sort();
    const expected = [...new Set(item.answer.correctOptionIds)].sort();
    correct = actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  } else if (item.kind === "fill-gap" && "gaps" in response) {
    correct = item.gaps.every((gap) => {
      const actual = response.gaps[gap.id];
      if (typeof actual !== "string") return false;
      const accepted = item.answer.acceptedByGap[gap.id] ?? [];
      return accepted.some((candidate) =>
        normalized(actual, item.answer.caseSensitive) === normalized(candidate, item.answer.caseSensitive));
    });
  } else if (item.kind === "trace" && "trace" in response) {
    correct = item.answer.acceptedTraces.some((candidate) =>
      normalized(response.trace, item.answer.caseSensitive) === normalized(candidate, item.answer.caseSensitive));
  }
  const hint = correct || !item.hints.length
    ? null
    : item.hints[Math.min(Math.max(0, hintIndex), item.hints.length - 1)] ?? null;
  return {
    correct,
    feedback: correct ? item.feedback.correct : item.feedback.incorrect,
    hint,
    stageAdvance: correct,
    authoritativeEvidence: false,
  };
}
