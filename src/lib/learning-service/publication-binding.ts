import {
  isExamEligibleItem,
  parseAssessmentBank,
  type DeterministicAssessmentItem,
} from "@/lib/content";

type JsonRecord = Readonly<Record<string, unknown>>;

function firstGapAnswers(item: Extract<DeterministicAssessmentItem, { kind: "fill-gap" }>) {
  return Object.fromEntries(
    item.gaps.map((gap) => [gap.id, item.answer.acceptedByGap[gap.id]?.[0] ?? ""]),
  );
}

function reviewedMisconceptions(item: DeterministicAssessmentItem): JsonRecord {
  return item.misconceptionMappings?.length
    ? { misconceptions: item.misconceptionMappings }
    : {};
}

/**
 * Build the runtime grader and learner-visible prompt from the immutable
 * reviewed item itself. The activity row contributes only the item id; its
 * mutable JSON can never replace reviewed wording, options, or answer keys.
 */
function canonicalSpecification(item: DeterministicAssessmentItem): JsonRecord {
  const base = {
    authoredItemId: item.id,
    itemKey: item.id,
    title: item.title,
    kind: item.kind,
    prompt: item.prompt,
    hints: item.hints,
    feedback: item.feedback,
    evidenceLevel: item.evidenceLevel,
  } as const;
  switch (item.kind) {
    case "mcq": {
      const multiple = item.answer.correctOptionIds.length > 1;
      return {
        ...base,
        options: item.options,
        multiple,
        grading: multiple
          ? { kind: "set", correctOptionIds: item.answer.correctOptionIds }
          : {
              kind: "choice",
              acceptedAnswers: item.answer.correctOptionIds,
              correctOptionIds: item.answer.correctOptionIds,
              ...reviewedMisconceptions(item),
            },
        solutionReveal: {
          answer: item.answer.correctOptionIds.join(", "),
          explanation: item.answer.explanation,
        },
      };
    }
    case "trace":
      return {
        ...base,
        artifact: item.artifact,
        grading: {
          kind: "exact",
          acceptedAnswers: item.answer.acceptedTraces,
          caseSensitive: item.answer.caseSensitive,
          ...reviewedMisconceptions(item),
        },
        solutionReveal: {
          answer: item.answer.acceptedTraces[0] ?? "",
          explanation: item.answer.explanation,
        },
      };
    case "fill-gap":
      return {
        ...base,
        template: item.template,
        gaps: item.gaps,
        grading: {
          kind: "gaps",
          acceptedByGap: item.answer.acceptedByGap,
          caseSensitive: item.answer.caseSensitive,
        },
        solutionReveal: {
          answer: JSON.stringify(firstGapAnswers(item)),
          explanation: item.answer.explanation,
        },
      };
    case "code":
      return {
        ...base,
        kind: "code-completion",
        starterCode: item.starterCode,
        language: item.runtime.language,
        grading: { kind: "runner" },
        solutionReveal: {
          answer: item.answer.referenceSolution,
          explanation: item.answer.explanation,
        },
      };
  }
}

export function reviewedAuthoredActivitySpecification(
  specification: JsonRecord,
  artifactContent: JsonRecord,
  expectedSkillId?: string,
): JsonRecord | null {
  const authoredItemId = specification.authoredItemId;
  if (typeof authoredItemId !== "string" || !authoredItemId.trim()) return null;
  try {
    const bank = parseAssessmentBank(artifactContent, "runtime:reviewed-activity-bank");
    const item = bank.items.find((candidate) => candidate.id === authoredItemId);
    if (
      !item
      || !isExamEligibleItem(bank, item)
      || (expectedSkillId !== undefined && (
        bank.skillId !== expectedSkillId || item.skillId !== expectedSkillId
      ))
    ) return null;
    return canonicalSpecification(item);
  } catch {
    return null;
  }
}

/**
 * Binds a materialized learner activity to one immutable, independently
 * reviewed authored item. A beta lesson row alone is not publication evidence.
 */
export function isReviewedAuthoredActivity(
  specification: JsonRecord,
  artifactContent: JsonRecord,
  expectedSkillId?: string,
): boolean {
  return reviewedAuthoredActivitySpecification(
    specification,
    artifactContent,
    expectedSkillId,
  ) !== null;
}
