import type { AuthoredLesson } from "./authored-types";
import type { AtomicSkill, CourseManifest, CourseModule, RuntimeKind } from "./types";

export const BEGINNER_QUALITY_CONTRACT_VERSION = "1.0.0" as const;

export type BeginnerQualityIssueCode =
  | "opening-missing"
  | "opening-dense"
  | "opening-generic"
  | "prerequisite-recap-missing"
  | "prerequisite-recap-inaccurate"
  | "mental-model-missing"
  | "worked-example-missing"
  | "coding-example-not-concrete"
  | "trace-incomplete"
  | "trace-text-alternative-mismatch"
  | "common-mistake-missing"
  | "short-practice-missing"
  | "short-practice-too-long"
  | "practice-example-mismatch"
  | "recap-incomplete"
  | "next-step-missing"
  | "canonical-rule-repeated"
  | "section-too-dense";

export interface BeginnerQualityIssue {
  readonly code: BeginnerQualityIssueCode;
  readonly message: string;
}

export interface BeginnerQualityContext {
  readonly prerequisiteLabels: readonly string[];
  readonly assumedKnowledge: readonly string[];
  readonly nextSkillTitle: string | null;
  readonly runtimeKind: RuntimeKind;
}

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "before", "between", "case", "from", "have", "into",
  "lesson", "only", "result", "should", "that", "their", "then", "there", "these", "this",
  "through", "using", "what", "when", "where", "which", "with", "your",
]);

const CODING_RUNTIME_KINDS = new Set<RuntimeKind>([
  "programming-language",
  "markup",
  "styling",
  "library",
  "multi-language",
]);

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim().replace(/\s+/g, " ");
}

function words(value: string) {
  return value.trim().split(/\s+/).filter(Boolean);
}

function significantTokens(value: string) {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token)),
  );
}

function significantTokenOverlap(left: string, right: string) {
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  return [...leftTokens].filter((token) => rightTokens.has(token)).length;
}

function sentenceWordCounts(value: string) {
  return value
    .split(/[.!?](?:\s|$)/)
    .map((sentence) => words(sentence).length)
    .filter((count) => count > 0);
}

function ensureSentence(value: string) {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lowercaseFirst(value: string) {
  return value.length === 0 ? value : `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function stripSentenceEnd(value: string) {
  return value.trim().replace(/[.!?]+$/, "");
}

function directPrerequisites(
  course: CourseManifest,
  courseModule: CourseModule,
  skill: AtomicSkill,
) {
  const labels = new Map<string, string>();
  for (const manifestModule of course.modules) {
    labels.set(manifestModule.id, manifestModule.title);
    for (const candidate of manifestModule.skills) labels.set(candidate.id, candidate.title);
  }
  return [...courseModule.prerequisites, ...skill.prerequisites].map(
    (id) => labels.get(id) ?? id.replace(/[._-]+/g, " "),
  );
}

export function createBeginnerQualityContext(
  course: CourseManifest,
  courseModule: CourseModule,
  skill: AtomicSkill,
): BeginnerQualityContext {
  const orderedSkills = course.modules.flatMap((module) => module.skills);
  const currentIndex = orderedSkills.findIndex((candidate) => candidate.id === skill.id);
  return {
    prerequisiteLabels: directPrerequisites(course, courseModule, skill),
    assumedKnowledge: course.audience.assumed_knowledge,
    nextSkillTitle: orderedSkills[currentIndex + 1]?.title ?? null,
    runtimeKind: course.runtime.kind,
  };
}

function prerequisiteRecap(context: BeginnerQualityContext) {
  const prerequisiteLabels = [
    ...new Map(context.prerequisiteLabels.map((label) => [normalize(label), label])).values(),
  ];
  if (prerequisiteLabels.length > 0) {
    return `Review these declared prerequisites first: ${prerequisiteLabels.join("; ")}. If one is unfamiliar, revisit it before continuing.`;
  }
  if (context.assumedKnowledge.length > 0) {
    return `This skill has no declared earlier lesson. The course assumes: ${context.assumedKnowledge.join("; ")}. You can continue when those ideas feel familiar.`;
  }
  return "This skill has no declared earlier lesson. You only need to read the stated case and compare a prediction with an observable result.";
}

function containsCanonicalSummary(value: string, canonicalSummary: string) {
  const normalizedSummary = normalize(canonicalSummary);
  return normalizedSummary.length >= 60 && normalize(value).includes(normalizedSummary);
}

function beginnerWalkthrough(
  existing: readonly string[],
  canonicalSummary: string,
  correction: string,
) {
  const fallback = [
    "Identify the input, state, or artifact named in the situation.",
    "Use the core rule above to predict one observable result.",
    `Compare the prediction with this check: ${correction}`,
  ];
  return Array.from({ length: Math.max(3, existing.length) }, (_, index) => {
    const current = existing[index] ?? fallback[index] ?? fallback[2]!;
    const detail = containsCanonicalSummary(current, canonicalSummary)
      ? fallback[index] ?? "Use the core rule above without copying it."
      : current.replace(/^Step\s+\d+\s*[—:.-]\s*/i, "");
    return `Step ${index + 1} — ${detail}`;
  });
}

function traceTextAlternative(lesson: AuthoredLesson) {
  const startingArtifact = lesson.trace.artifact[0] ?? lesson.examples[0]?.situation ?? lesson.title;
  const steps = lesson.trace.steps.map((step) => {
    const state = Object.entries(step.state)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; ");
    return `Step ${step.step}, ${step.focus}. State: ${state}. ${step.explanation}`;
  });
  return `Starting artifact: ${startingArtifact} ${steps.join(" ")}`;
}

export function applyBeginnerQualityTemplate(
  lesson: AuthoredLesson,
  context: BeginnerQualityContext,
): AuthoredLesson {
  const firstExample = lesson.examples[0];
  const firstOutcome = lesson.outcomes[0] ?? `explain ${lesson.title}`;
  const misconception = lesson.misconceptions[0];
  const correction = misconception?.correction ?? "Compare the prediction with the declared boundary.";
  const boundary = lesson.scope.excludes[0] ?? misconception?.mistakenBelief ?? "Do not extend the rule beyond the stated case.";
  const opening = firstExample
    ? `Start with this case: ${ensureSentence(firstExample.situation)} Your goal is to ${lowercaseFirst(stripSentenceEnd(firstOutcome))}. Work through the example one step at a time, then use the boundary to check your answer.`
    : `Start with the learner outcome for ${lesson.title}. Your goal is to ${lowercaseFirst(stripSentenceEnd(firstOutcome))}. Use the core rule and boundary together before attempting practice.`;
  const oldSections = lesson.canonicalExplanation.sections.filter(
    (section) => !/^(start here|before you begin)$/i.test(section.heading.trim()),
  );
  const examples = lesson.examples.map((example) => ({
    ...example,
    walkthrough: beginnerWalkthrough(
      example.walkthrough,
      lesson.canonicalExplanation.summary,
      correction,
    ),
    result: containsCanonicalSummary(example.result, lesson.canonicalExplanation.summary)
      ? `This case demonstrates the declared outcome: ${firstOutcome}`
      : example.result,
  }));
  const expectedEvidence = firstExample
    ? [
        `Named example: ${firstExample.title}.`,
        `Starting evidence: ${firstExample.situation}`,
        `Core rule: ${lesson.canonicalExplanation.summary}`,
        `Observable result: ${examples[0]?.result ?? firstExample.result}`,
        `Boundary check: ${correction}`,
      ]
    : lesson.practice.faded.expectedEvidence;
  const marker = `Beginner-quality contract ${BEGINNER_QUALITY_CONTRACT_VERSION}`;
  const changeSummary = lesson.publication.changeSummary.includes(marker)
    ? lesson.publication.changeSummary
    : `${lesson.publication.changeSummary} ${marker} applied deterministically from existing source-linked draft facts; publication stage and reviewer state are unchanged.`;

  return {
    ...lesson,
    publication: { ...lesson.publication, changeSummary },
    canonicalExplanation: {
      ...lesson.canonicalExplanation,
      sections: [
        { heading: "Start here", body: opening },
        { heading: "Before you begin", body: prerequisiteRecap(context) },
        ...oldSections,
      ],
    },
    examples,
    trace: {
      ...lesson.trace,
      textAlternative: traceTextAlternative(lesson),
    },
    practice: {
      ...lesson.practice,
      faded: {
        ...lesson.practice.faded,
        prompt: firstExample
          ? `Quick check for “${firstExample.title}”: state its starting evidence, apply the ${lesson.title} rule, and give the observable result in three short lines.`
          : `Quick check for ${lesson.title}: state the starting evidence, apply the core rule, and give the observable result in three short lines.`,
        scaffold: [
          "Line 1: name the starting evidence.",
          "Line 2: state the part of the core rule that applies.",
          "Line 3: give the result and reject the common mistake.",
        ],
        expectedEvidence,
      },
    },
    recap: {
      ...lesson.recap,
      summary: `You should now be able to ${lowercaseFirst(stripSentenceEnd(firstOutcome))}. Keep this boundary in view: ${boundary}`,
      nextReviewPrompt: context.nextSkillTitle
        ? `Next: continue to “${context.nextSkillTitle}”. Before moving on, answer one retrieval prompt without reopening the explanation.`
        : "Next: use this skill in the module checkpoint and one independent practice attempt. Before moving on, answer one retrieval prompt without reopening the explanation.",
    },
  };
}

function concreteCodingEvidence(lesson: AuthoredLesson) {
  const evidence = [
    ...lesson.examples.flatMap((example) => [example.situation, ...example.walkthrough]),
    ...lesson.trace.artifact,
  ].join(" ");
  const syntaxOrArtifact = /[{}();=<>\[\]@\/]|\b(?:array|button|class|column|component|const|data|def|div|dom|field|for|function|graph|if|import|index|input|item|layout|let|list|method|model|node|parameter|pipeline|property|public|query|queue|record|register|return|route|selector|sensor|stack|state|static|test|tree|url|value|variable|while)\b/i;
  const observableOperation = /\b(?:add|align|assign|bind|build|change|check|choose|compare|compile|compute|decode|derive|encode|evaluate|execute|fetch|filter|fit|format|handle|impute|map|measure|navigate|parse|predict|read|render|route|run|scale|select|sort|store|test|transform|update|validate|write)\w*\b/i;
  return syntaxOrArtifact.test(evidence) && observableOperation.test(evidence);
}

function hasLessonSpecificMentalModel(lesson: AuthoredLesson) {
  const modelSection = lesson.canonicalExplanation.sections.find((section) =>
    !/^(start here|before you begin)$/i.test(section.heading.trim()) &&
    /(?:model|rule|invariant|state|object|distinction|technology)/i.test(section.heading),
  );
  if (!modelSection) return false;
  const referenceTokens = significantTokens([
    lesson.canonicalExplanation.summary,
    lesson.sources.map((source) => source.claim).join(" "),
    lesson.outcomes.join(" "),
  ].join(" "));
  const modelTokens = significantTokens(modelSection.body);
  return [...referenceTokens].filter((token) => modelTokens.has(token)).length >= 3;
}

function traceAlternativeMatchesSteps(lesson: AuthoredLesson) {
  const alternative = lesson.trace.textAlternative;
  return lesson.trace.steps.every((step) =>
    normalize(alternative).includes(normalize(step.focus)) &&
    significantTokenOverlap(
      `${Object.values(step.state).join(" ")} ${step.explanation}`,
      alternative,
    ) >= 2,
  );
}

function practiceMatchesNamedExample(lesson: AuthoredLesson) {
  const example = lesson.examples[0];
  if (!example) return false;
  const evidence = lesson.practice.faded.expectedEvidence.join(" ");
  return normalize(lesson.practice.faded.prompt).includes(normalize(example.title)) &&
    significantTokenOverlap(example.situation, evidence) >= 2 &&
    significantTokenOverlap(example.result, evidence) >= 2;
}

export function auditBeginnerLessonQuality(
  lesson: AuthoredLesson,
  context: BeginnerQualityContext,
): readonly BeginnerQualityIssue[] {
  const issues: BeginnerQualityIssue[] = [];
  const opening = lesson.canonicalExplanation.sections.find((section) =>
    /^start here$/i.test(section.heading.trim()),
  );
  if (!opening) {
    issues.push({ code: "opening-missing", message: "Add a lesson-specific plain-language opening." });
  } else {
    const openingWords = words(opening.body).length;
    const sentenceLengths = sentenceWordCounts(opening.body);
    if (openingWords < 25 || openingWords > 180 || sentenceLengths.some((count) => count > 80)) {
      issues.push({ code: "opening-dense", message: "Opening must use 25-180 words with no sentence over 80 words." });
    }
    const overlap = significantTokenOverlap(
      `${lesson.examples[0]?.situation ?? ""} ${lesson.outcomes[0] ?? ""}`,
      opening.body,
    );
    if (overlap < 3) {
      issues.push({ code: "opening-generic", message: "Opening does not contain enough lesson-specific case or outcome language." });
    }
  }

  const prerequisite = lesson.canonicalExplanation.sections.find((section) =>
    /^before you begin$/i.test(section.heading.trim()),
  );
  if (!prerequisite || words(prerequisite.body).length < 12) {
    issues.push({ code: "prerequisite-recap-missing", message: "Add an explicit prerequisite or assumed-knowledge recap." });
  } else if (
    context.prerequisiteLabels.some((label) => !normalize(prerequisite.body).includes(normalize(label)))
  ) {
    issues.push({ code: "prerequisite-recap-inaccurate", message: "The recap omits a declared module or skill prerequisite." });
  }

  if (!hasLessonSpecificMentalModel(lesson)) {
    issues.push({ code: "mental-model-missing", message: "Add a lesson-specific operational model tied to the source claim and learner outcome." });
  }

  if (
    lesson.examples.length === 0 ||
    lesson.examples.some((example) =>
      words(example.situation).length < 8 ||
      example.walkthrough.length < 3 ||
      new Set(example.walkthrough.map(normalize)).size !== example.walkthrough.length ||
      words(example.result).length < 6 ||
      significantTokenOverlap(
        `${lesson.title} ${lesson.canonicalExplanation.summary} ${lesson.outcomes.join(" ")} ${lesson.scope.excludes.join(" ")} ${lesson.misconceptions.map((item) => `${item.mistakenBelief} ${item.correction}`).join(" ")}`,
        `${example.situation} ${example.walkthrough.join(" ")} ${example.result}`,
      ) < 2,
    )
  ) {
    issues.push({ code: "worked-example-missing", message: "Every example needs a concrete situation, three distinct steps, and an observable result." });
  }
  if (CODING_RUNTIME_KINDS.has(context.runtimeKind) && !concreteCodingEvidence(lesson)) {
    issues.push({ code: "coding-example-not-concrete", message: "Coding lessons need a code-, data-structure-, markup-, or state-shaped example." });
  }

  if (
    lesson.trace.steps.length < 3 ||
    new Set(lesson.trace.steps.map((step) => normalize(step.focus))).size < 3 ||
    lesson.trace.steps.some((step, index) =>
      step.step !== index + 1 ||
      words(step.explanation).length < 6 ||
      Object.keys(step.state).length === 0,
    ) ||
    words(lesson.trace.textAlternative).length < 15
  ) {
    issues.push({ code: "trace-incomplete", message: "Trace needs sequential, explained steps and a meaningful text alternative." });
  }
  if (!traceAlternativeMatchesSteps(lesson)) {
    issues.push({ code: "trace-text-alternative-mismatch", message: "Trace text alternative must communicate every named step and its actual state/explanation." });
  }
  if (
    lesson.misconceptions.length === 0 ||
    lesson.misconceptions.some((item) =>
      words(item.mistakenBelief).length < 5 ||
      words(item.correction).length < 6 ||
      normalize(item.mistakenBelief) === normalize(item.correction),
    )
  ) {
    issues.push({ code: "common-mistake-missing", message: "Add a plausible common mistake and an explanatory correction." });
  }

  const practiceWords = words(lesson.practice.faded.prompt).length;
  const practiceEvidence = lesson.practice.faded.expectedEvidence.join(" ");
  const practiceIsLessonSpecific =
    significantTokenOverlap(
      `${lesson.title} ${lesson.examples[0]?.title ?? ""} ${lesson.examples[0]?.situation ?? ""}`,
      lesson.practice.faded.prompt,
    ) >= 2 || /worked example|case above|trace above/i.test(lesson.practice.faded.prompt);
  const practiceEvidenceIsGrounded = significantTokenOverlap(
    `${lesson.canonicalExplanation.summary} ${lesson.outcomes.join(" ")} ${lesson.misconceptions.map((item) => item.correction).join(" ")}`,
    practiceEvidence,
  ) >= 1;
  if (
    practiceWords < 12 ||
    lesson.practice.faded.scaffold.length < 2 ||
    new Set(lesson.practice.faded.scaffold.map(normalize)).size !== lesson.practice.faded.scaffold.length ||
    lesson.practice.faded.expectedEvidence.length === 0 ||
    !practiceIsLessonSpecific ||
    !practiceEvidenceIsGrounded
  ) {
    issues.push({ code: "short-practice-missing", message: "Add a short, scaffolded practice check with expected evidence." });
  } else if (practiceWords > 55) {
    issues.push({ code: "short-practice-too-long", message: "The first practice check exceeds 55 words." });
  }
  if (!practiceMatchesNamedExample(lesson)) {
    issues.push({ code: "practice-example-mismatch", message: "The faded prompt and expected evidence must name and describe the same actual worked example." });
  }

  if (
    words(lesson.recap.summary).length < 12 ||
    lesson.recap.retrievalPrompts.length < 2 ||
    significantTokenOverlap(
      `${lesson.outcomes.join(" ")} ${lesson.scope.excludes.join(" ")}`,
      lesson.recap.summary,
    ) < 2
  ) {
    issues.push({ code: "recap-incomplete", message: "Recap needs a meaningful summary and at least two retrieval prompts." });
  }
  if (
    !lesson.recap.nextReviewPrompt.startsWith("Next:") ||
    (context.nextSkillTitle && !normalize(lesson.recap.nextReviewPrompt).includes(normalize(context.nextSkillTitle)))
  ) {
    issues.push({ code: "next-step-missing", message: "Name the actual next skill or module checkpoint." });
  }

  const summary = normalize(lesson.canonicalExplanation.summary);
  if (summary.length >= 60) {
    const learnerNarratives = [
      ...lesson.canonicalExplanation.sections.map((section) => section.body),
      ...lesson.examples.flatMap((example) => [...example.walkthrough, example.result]),
      lesson.trace.textAlternative,
      lesson.recap.summary,
    ];
    const repetitions = learnerNarratives.filter((value) => normalize(value).includes(summary)).length;
    if (repetitions >= 3) {
      issues.push({ code: "canonical-rule-repeated", message: "The same long canonical rule is pasted into three or more learner-facing blocks." });
    }
  }
  if (
    lesson.canonicalExplanation.sections.some((section) =>
      words(section.body).length > 220 || sentenceWordCounts(section.body).some((count) => count > 100),
    )
  ) {
    issues.push({ code: "section-too-dense", message: "Canonical sections must stay below 220 words and 100 words per sentence." });
  }
  return issues;
}
