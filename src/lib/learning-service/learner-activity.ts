import type {
  ActivityContext,
  AttemptCreationResult,
  DeterministicEvaluation,
  PracticeFeedback,
  PracticeHelpKind,
  SubmissionInput,
  SupportedAttemptKind,
} from "./types";

type JsonRecord = Readonly<Record<string, unknown>>;

export type LearnerPracticeKind =
  | "mcq"
  | "trace"
  | "fill-gap"
  | "code-completion"
  | "short-answer";

export interface LearnerPracticeSpecification {
  readonly kind: LearnerPracticeKind;
  readonly itemKey: string;
  readonly title: string;
  readonly prompt: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly multiple: boolean;
  readonly artifact: readonly string[];
  readonly template: string | null;
  readonly gaps: readonly { readonly id: string; readonly label: string }[];
  readonly starterCode: string | null;
  readonly language: string | null;
  readonly help: {
    readonly totalSteps: number;
    readonly hintSteps: number;
    readonly hasAlternateExplanation: boolean;
    readonly hasWorkedExample: boolean;
    readonly hasSolution: boolean;
  };
}

export interface LearnerPracticeActivity {
  readonly id: string;
  readonly slug: string;
  readonly skillId: string;
  readonly courseVersion: string;
  readonly languageContext: string;
  readonly specification: LearnerPracticeSpecification;
}

export interface LearnerAttemptCreationPayload {
  readonly state: "ready" | "degraded";
  readonly attempt: {
    readonly id: string;
    readonly kind: string;
    readonly attemptNumber: number;
    readonly status: string;
    readonly contentVersion: string;
  } | null;
  readonly activity: LearnerPracticeActivity | null;
  readonly idempotent: boolean;
  readonly reason?: "activity_unavailable" | "publication_unavailable" | "activity_unsupported";
}

export interface PracticeHelpStep {
  readonly step: number;
  readonly kind: PracticeHelpKind;
  readonly assistanceLevel: "A1" | "A2" | "A3" | "A4";
  readonly solutionRevealed: boolean;
  readonly content: string;
  readonly answer: string | null;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function boundedString(value: unknown, max = 8_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function boundedStrings(value: unknown, maximum = 12, maxLength = 2_000): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedString(item, maxLength))
    .filter((item): item is string => item !== null)
    .slice(0, maximum);
}

function identifier(value: unknown, fallback: string): string {
  const candidate = boundedString(value, 160);
  return candidate && /^[A-Za-z0-9_.:-]{1,160}$/.test(candidate) ? candidate : fallback;
}

function practiceKind(activity: ActivityContext): LearnerPracticeKind | null {
  const declared = String(
    activity.specification.kind
      ?? activity.specification.itemKind
      ?? activity.specification.type
      ?? activity.activityType,
  ).toLocaleLowerCase("en-US");
  if (/^(?:mcq|choice|multiple-choice)$/.test(declared) || declared.includes("quiz")) return "mcq";
  if (declared.includes("trace") || declared.includes("output")) return "trace";
  if (declared.includes("fill") || declared.includes("gap")) return "fill-gap";
  if (declared.includes("code-completion") || declared.includes("code_completion") || declared.includes("debug")) {
    return "code-completion";
  }
  if (declared.includes("short") || declared.includes("exact") || declared.includes("practice")) return "short-answer";
  return null;
}

function safeOptions(value: unknown): readonly { readonly id: string; readonly text: string }[] {
  if (!Array.isArray(value)) return [];
  const options: { id: string; text: string }[] = [];
  for (const candidate of value.slice(0, 20)) {
    const item = record(candidate);
    const id = boundedString(item?.id, 100);
    const text = boundedString(item?.text, 2_000);
    if (id && text && /^[A-Za-z0-9_.:-]{1,100}$/.test(id)) options.push({ id, text });
  }
  return options;
}

function safeGaps(value: unknown): readonly { readonly id: string; readonly label: string }[] {
  if (!Array.isArray(value)) return [];
  const gaps: { id: string; label: string }[] = [];
  for (const candidate of value.slice(0, 12)) {
    const item = record(candidate);
    const id = boundedString(item?.id, 100);
    const label = boundedString(item?.label, 500);
    if (id && label && /^[A-Za-z0-9_.:-]{1,100}$/.test(id)) gaps.push({ id, label });
  }
  return gaps;
}

/**
 * Returns the only activity fields that may cross the learner API boundary.
 * Graders, accepted answers, private feedback, rubrics, hidden tests and reference
 * solutions are deliberately never copied, even if an author adds new keys later.
 */
export function toLearnerPracticeActivity(activity: ActivityContext): LearnerPracticeActivity | null {
  const kind = practiceKind(activity);
  const prompt = boundedString(activity.specification.prompt ?? activity.specification.instructions, 12_000);
  const grading = record(activity.specification.grading);
  const gradingKind = boundedString(grading?.kind, 40);
  if (!kind || !prompt || !gradingKind || !["exact", "choice", "set", "numeric", "gaps"].includes(gradingKind)) return null;
  const options = safeOptions(activity.specification.options);
  if (kind === "mcq" && options.length < 2) return null;
  const gaps = safeGaps(activity.specification.gaps);
  if (kind === "fill-gap" && gaps.length < 1) return null;
  const solutionReveal = record(activity.specification.solutionReveal);
  const solutionAnswer = boundedString(solutionReveal?.answer, 8_000);
  const solutionExplanation = boundedString(solutionReveal?.explanation, 8_000);
  const hints = boundedStrings(activity.specification.hints, 6, 2_000);
  const alternateExplanation = boundedString(activity.specification.alternateExplanation, 8_000);
  const workedExample = boundedString(activity.specification.workedExample, 12_000);
  const hasSolution = Boolean(solutionAnswer && solutionExplanation);
  return {
    id: activity.activityId,
    slug: activity.activitySlug,
    skillId: activity.skillId,
    courseVersion: activity.courseVersion,
    languageContext: activity.languageContext,
    specification: {
      kind,
      itemKey: identifier(
        activity.specification.itemKey ?? activity.specification.authoredItemId,
        activity.activitySlug,
      ),
      title: boundedString(activity.specification.title, 500) ?? "Practice check",
      prompt,
      options,
      multiple: activity.specification.multiple === true,
      artifact: boundedStrings(activity.specification.artifact, 80, 2_000),
      template: boundedString(activity.specification.template, 12_000),
      gaps,
      starterCode: boundedString(activity.specification.starterCode, 32_000),
      language: boundedString(activity.specification.language, 80),
      help: {
        totalSteps: hints.length + Number(Boolean(alternateExplanation)) + Number(Boolean(workedExample)) + Number(hasSolution),
        hintSteps: hints.length,
        hasAlternateExplanation: Boolean(alternateExplanation),
        hasWorkedExample: Boolean(workedExample),
        hasSolution,
      },
    },
  };
}

/**
 * Narrows the general reviewed-practice projection to the formats permitted by
 * an attempt surface. An official topic checkpoint is represented by the
 * existing `quiz` attempt kind and must fail closed unless its published item
 * is an MCQ. Mixed-format activities remain available in the Practice tab.
 */
export function toLearnerActivityForAttemptKind(
  activity: ActivityContext,
  kind: SupportedAttemptKind,
): LearnerPracticeActivity | null {
  const learnerActivity = toLearnerPracticeActivity(activity);
  if (!learnerActivity) return null;
  if (kind !== "quiz") return learnerActivity;
  if (learnerActivity.specification.kind !== "mcq") return null;

  const grading = record(activity.specification.grading);
  if (!grading || typeof grading.kind !== "string") return null;
  const optionIds = new Set(learnerActivity.specification.options.map((option) => option.id));
  if (learnerActivity.specification.multiple) {
    const expected = Array.isArray(grading.correctOptionIds)
      ? grading.correctOptionIds.filter((value): value is string => typeof value === "string")
      : [];
    if (
      grading.kind !== "set"
      || expected.length < 2
      || new Set(expected).size !== expected.length
      || expected.some((optionId) => !optionIds.has(optionId))
    ) return null;
  } else {
    const accepted = Array.isArray(grading.acceptedAnswers)
      ? grading.acceptedAnswers.filter((value): value is string => typeof value === "string")
      : Array.isArray(grading.correctOptionIds)
        ? grading.correctOptionIds.filter((value): value is string => typeof value === "string")
        : [];
    if (
      !["choice", "exact"].includes(grading.kind)
      || accepted.length !== 1
      || !optionIds.has(accepted[0]!)
    ) return null;
  }
  return learnerActivity;
}

/** Resolves exactly one server-authoritative help step. It is intentionally not
 * embedded in creation payloads; callers persist the step before returning it. */
export function practiceHelpAt(activity: ActivityContext, step: number): PracticeHelpStep | null {
  if (!Number.isSafeInteger(step) || step < 1 || !toLearnerPracticeActivity(activity)) return null;
  const hints = boundedStrings(activity.specification.hints, 6, 2_000);
  const ladder: Omit<PracticeHelpStep, "step">[] = hints.map((content, index) => ({
    kind: "hint" as const,
    assistanceLevel: index === 0 ? "A1" as const : index === 1 ? "A2" as const : "A3" as const,
    solutionRevealed: false,
    content,
    answer: null,
  }));
  const alternate = boundedString(activity.specification.alternateExplanation, 8_000);
  if (alternate) ladder.push({ kind: "alternate", assistanceLevel: "A3", solutionRevealed: false, content: alternate, answer: null });
  const example = boundedString(activity.specification.workedExample, 12_000);
  if (example) ladder.push({ kind: "example", assistanceLevel: "A3", solutionRevealed: false, content: example, answer: null });
  const solution = record(activity.specification.solutionReveal);
  const answer = boundedString(solution?.answer, 8_000);
  const explanation = boundedString(solution?.explanation, 8_000);
  if (answer && explanation) ladder.push({ kind: "solution", assistanceLevel: "A4", solutionRevealed: true, content: explanation, answer });
  const selected = ladder[step - 1];
  return selected ? { step, ...selected } : null;
}

export function toLearnerAttemptCreationPayload(
  result: AttemptCreationResult,
): LearnerAttemptCreationPayload {
  if (result.state === "degraded" || !result.attempt || !result.activity) {
    return {
      state: "degraded",
      attempt: null,
      activity: null,
      idempotent: result.idempotent,
      reason: result.reason ?? "activity_unavailable",
    };
  }
  const activity = toLearnerActivityForAttemptKind(result.activity, result.attempt.kind);
  if (!activity) {
    return {
      state: "degraded",
      attempt: null,
      activity: null,
      idempotent: result.idempotent,
      reason: "activity_unsupported",
    };
  }
  return {
    state: "ready",
    attempt: {
      id: result.attempt.id,
      kind: result.attempt.kind,
      attemptNumber: result.attempt.attemptNumber,
      status: result.attempt.status,
      contentVersion: result.attempt.contentVersion,
    },
    activity,
    idempotent: result.idempotent,
  };
}

function remediationFor(
  specification: JsonRecord,
  tags: readonly string[],
): PracticeFeedback["remediation"] {
  if (!Array.isArray(specification.remediation)) return [];
  const tagSet = new Set(tags);
  const items: { tag: string; explanation: string; retryPrompt: string }[] = [];
  for (const candidate of specification.remediation.slice(0, 12)) {
    const item = record(candidate);
    const tag = boundedString(item?.tag ?? item?.misconceptionTag ?? item?.misconceptionId, 64);
    const explanation = boundedString(item?.explanation, 8_000);
    const retryPrompt = boundedString(item?.retryPrompt, 8_000);
    if (tag && explanation && retryPrompt && (!tagSet.size || tagSet.has(tag))) {
      items.push({ tag, explanation, retryPrompt });
    }
  }
  return items;
}

/** Server-only result feedback. Dedicated solutionReveal fields are returned only
 * after the reveal has already been persisted as assisted, non-mastery evidence. */
export function practiceFeedbackFor(
  activity: ActivityContext,
  evaluation: DeterministicEvaluation,
  response: Pick<SubmissionInput, "assistanceLevel" | "solutionRevealed">,
): PracticeFeedback {
  const feedback = record(activity.specification.feedback);
  const correctText = boundedString(feedback?.correct, 8_000);
  const incorrectText = boundedString(feedback?.incorrect, 8_000);
  const why = evaluation.correct
    ? correctText ?? "Your response matched the reviewed deterministic rule for this activity."
    : incorrectText ?? "Your response did not match the reviewed deterministic rule for this activity.";
  const solutionReveal = response.solutionRevealed ? record(activity.specification.solutionReveal) : null;
  const solutionAnswer = boundedString(solutionReveal?.answer, 8_000);
  const solutionExplanation = boundedString(solutionReveal?.explanation, 8_000);
  const independent = response.assistanceLevel === "A0" && !response.solutionRevealed;
  return {
    correct: evaluation.correct,
    headline: evaluation.correct ? "Correct" : "Not yet",
    why,
    misconceptionTags: evaluation.misconceptionTags,
    remediation: evaluation.correct ? [] : remediationFor(activity.specification, evaluation.misconceptionTags),
    independent,
    assistanceLevel: response.assistanceLevel,
    solutionRevealed: response.solutionRevealed,
    solution: response.solutionRevealed && solutionAnswer && solutionExplanation
      ? { answer: solutionAnswer, explanation: solutionExplanation }
      : null,
    nextAction: evaluation.correct && independent ? "continue" : "retry_fresh",
  };
}
