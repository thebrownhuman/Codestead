import type {
  ActivityApplicability,
  ActivityMode,
  ActivitySpecificationBlock,
  AtomicSkill,
  AuthoredFallbackLessonBlueprint,
  ContentEvidenceType,
  ContentIndex,
  CourseManifest,
  LessonBlueprintBlock,
  LessonBlueprintSourceLink,
  WorkedExampleSpecification,
} from "./types";

export const DSA_IMPLEMENTATION_LANGUAGES = ["C", "C++", "Java", "Python"] as const;
export type DsaImplementationLanguage = (typeof DSA_IMPLEMENTATION_LANGUAGES)[number];

export interface LessonBlueprintCompilerOptions {
  readonly selectedLanguage?: DsaImplementationLanguage;
}

interface AuthoringProfile {
  readonly artifactType: string;
  readonly startingState: string;
  readonly requiredSteps: readonly string[];
  readonly validationRequirements: readonly string[];
  readonly accessibilityRequirements: readonly string[];
}

const COMMON_STEPS = [
  "State the problem, input assumptions and observable result.",
  "Show the starting state before applying the target skill.",
  "Apply the target skill in concept-labeled steps rather than line-by-line narration.",
  "Show the final state or output and explain why it satisfies the objective.",
  "Add a faded variant and a neutral-context independent variant.",
] as const;

const COMMON_ACCESSIBILITY = [
  "Use a logical heading order and descriptive control or link names.",
  "Keep every interaction keyboard operable and expose visible focus.",
  "Do not communicate correctness or state through color alone.",
  "Render code, output and diagnostics as selectable text with a declared language.",
  "Provide a linear text equivalent for every diagram, animation or state trace.",
] as const;

const COURSE_PROFILES: Readonly<Record<string, AuthoringProfile>> = {
  "programming-foundations": {
    artifactType: "language-neutral pseudocode and state table",
    startingState: "A small everyday problem with explicit inputs and no language syntax assumed.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Trace every state transition deterministically.",
      "Use only the published pseudocode conventions.",
      "Include normal, boundary and invalid examples.",
    ],
    accessibilityRequirements: COMMON_ACCESSIBILITY,
  },
  c: {
    artifactType: "complete portable C source plus tests",
    startingState: "A minimal C23 program compiled with strict warnings.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Compile in the pinned C23 mode with strict warnings.",
      "Run deterministic normal, boundary and failure tests.",
      "Run AddressSanitizer and UndefinedBehaviorSanitizer when memory or arithmetic behavior is involved.",
      "Label undefined, implementation-defined and toolchain-specific behavior instead of tracing it as authoritative.",
    ],
    accessibilityRequirements: COMMON_ACCESSIBILITY,
  },
  cpp: {
    artifactType: "complete modern C++ source plus tests",
    startingState: "A minimal C++20 project using value semantics and standard-library facilities.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Compile in the pinned C++ mode with strict warnings.",
      "Prefer RAII and standard containers over manual ownership.",
      "Run deterministic tests and applicable address/undefined-behavior sanitizers.",
      "Label C++23-only behavior explicitly.",
    ],
    accessibilityRequirements: COMMON_ACCESSIBILITY,
  },
  java: {
    artifactType: "complete Java class or package plus JUnit tests",
    startingState: "A minimal Java SE 21 application with preview features disabled.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Compile and run on the pinned JDK 21 LTS environment.",
      "Use JUnit tests for normal, boundary and exceptional behavior.",
      "Preserve package, generic-type and exception contracts.",
    ],
    accessibilityRequirements: COMMON_ACCESSIBILITY,
  },
  python: {
    artifactType: "complete Python module plus automated tests",
    startingState: "A Python 3.14 script or module in the pinned virtual environment.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Run on CPython 3.14 with deterministic inputs.",
      "Test normal, boundary and exception behavior.",
      "Make mutability, aliasing, iterator consumption and type-hint limitations explicit when relevant.",
    ],
    accessibilityRequirements: COMMON_ACCESSIBILITY,
  },
  html: {
    artifactType: "standards-mode semantic HTML document or fragment",
    startingState: "Unstyled semantic content whose meaning is understandable without scripts.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Pass the configured HTML conformance checks.",
      "Inspect headings, landmarks, names, roles and states in the accessibility tree.",
      "Verify keyboard order and operation before CSS or JavaScript enhancements.",
    ],
    accessibilityRequirements: [
      ...COMMON_ACCESSIBILITY,
      "Prefer native HTML semantics and require a documented reason for ARIA.",
    ],
  },
  css: {
    artifactType: "CSS stylesheet plus semantic HTML fixture",
    startingState: "A semantic HTML fixture with representative short, long and zoomed content.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Inspect winning declarations and computed values in browser developer tools.",
      "Test narrow, wide, zoomed, long-content and right-to-left scenarios as applicable.",
      "Measure contrast and verify focus, reflow and reduced-motion behavior.",
    ],
    accessibilityRequirements: [
      ...COMMON_ACCESSIBILITY,
      "Provide text values for measured contrast, viewport and computed-style evidence.",
    ],
  },
  javascript: {
    artifactType: "native ES module with browser fixture and tests",
    startingState: "A semantic HTML fixture and isolated ECMAScript module graph.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Run in the declared browser matrix using deterministic fixtures.",
      "Test synchronous, asynchronous, error and cancellation states as applicable.",
      "Treat remote, storage and DOM-derived data as untrusted and avoid injection sinks.",
    ],
    accessibilityRequirements: [
      ...COMMON_ACCESSIBILITY,
      "Announce important asynchronous status changes without stealing focus.",
    ],
  },
  react: {
    artifactType: "React 19.2 function component or feature plus user-centered tests",
    startingState: "A pinned React client project with semantic HTML and explicit props/state ownership.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Render under Strict Mode in development.",
      "Test by accessible role, name, label and realistic user interaction.",
      "Cover loading, empty, success, failure and stale-result states when asynchronous.",
      "Avoid implementation-detail assertions and unnecessary effects or memoization.",
    ],
    accessibilityRequirements: [
      ...COMMON_ACCESSIBILITY,
      "Verify route or view changes provide an updated title and perceivable focus context.",
    ],
  },
  "git-tooling": {
    artifactType: "disposable repository transcript and resulting repository state",
    startingState: "A disposable repository with a recorded clean status and no production credentials.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Record status, diff and graph evidence before and after each state-changing command.",
      "Use disposable repositories for destructive or history-rewriting operations.",
      "Verify builds or tests before integration and scan the resulting diff for secrets.",
    ],
    accessibilityRequirements: COMMON_ACCESSIBILITY,
  },
  ai: {
    artifactType: "bounded Python experiment, decision artifact and evaluation report",
    startingState: "A versioned toy dataset, fixed baseline and seeded Python 3.14 environment.",
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      "Separate training, validation and test evidence and record seeds and versions.",
      "Compare a meaningful baseline and report more than one context-appropriate metric.",
      "Document data provenance, limitations, intended use, human review and residual risk.",
      "Use mocked model APIs by default and never include learner credentials or autonomous external actions.",
    ],
    accessibilityRequirements: [
      ...COMMON_ACCESSIBILITY,
      "Provide data tables and prose summaries for every chart, model diagram and metric visualization.",
    ],
  },
};

function dsaProfile(language: DsaImplementationLanguage | undefined): AuthoringProfile {
  const selected = language ?? "the learner-selected supported language";
  return {
    artifactType: `${selected} implementation, tests, trace and complexity note`,
    startingState: `A language-neutral algorithm contract mapped to ${selected}.`,
    requiredSteps: COMMON_STEPS,
    validationRequirements: [
      `Run the equivalent visible and hidden behavioral tests in ${selected}.`,
      "State the time and auxiliary-space target and test adversarial edge cases.",
      "Keep conceptual evidence separate from language-specific syntax, library and ownership evidence.",
      ...(language === "C" || language === "C++"
        ? ["Run memory/lifetime diagnostics and explain ownership for allocated nodes or buffers."]
        : []),
    ],
    accessibilityRequirements: [
      ...COMMON_ACCESSIBILITY,
      "Linearize every structure or algorithm animation as ordered state transitions.",
    ],
  };
}

function profileFor(
  course: CourseManifest,
  options: LessonBlueprintCompilerOptions,
): AuthoringProfile {
  if (course.id === "dsa") return dsaProfile(options.selectedLanguage);
  return (
    COURSE_PROFILES[course.id] ?? {
      artifactType: `${course.runtime.language} learning artifact`,
      startingState: `A minimal artifact in ${course.runtime.language}.`,
      requiredSteps: COMMON_STEPS,
      validationRequirements: [
        `Validate in the pinned ${course.runtime.standard} environment.`,
        "Test normal, boundary and failure behavior.",
      ],
      accessibilityRequirements: COMMON_ACCESSIBILITY,
    }
  );
}

function sourcesFor(course: CourseManifest, skill: AtomicSkill): readonly LessonBlueprintSourceLink[] {
  const byId = new Map(course.authoritative_sources.map((source) => [source.id, source]));
  return skill.source_refs.map((sourceId) => {
    const source = byId.get(sourceId);
    if (!source) throw new RangeError(`Skill '${skill.id}' has unresolved source '${sourceId}'.`);
    return {
      id: source.id,
      title: source.title,
      url: source.url,
      versionOrDate: source.version_or_date,
    };
  });
}

function applicabilityFor(
  mode: ActivityMode,
  evidenceTypes: readonly ContentEvidenceType[],
): ActivityApplicability {
  const expected: Readonly<Record<ActivityMode, readonly ContentEvidenceType[]>> = {
    trace: ["trace", "visual", "debug"],
    check: ["concept-check", "explain", "review"],
    code: ["code", "artifact", "performance", "project"],
    transfer: ["transfer", "design", "project"],
  };
  return expected[mode].some((evidence) => evidenceTypes.includes(evidence))
    ? "required"
    : mode === "code"
      ? "author-review"
      : "recommended";
}

function activityBlock(
  skill: AtomicSkill,
  mode: ActivityMode,
  index: number,
): ActivitySpecificationBlock {
  const promptSeeds: Readonly<Record<ActivityMode, string>> = {
    trace: `Trace a minimal ${skill.title} example from declared starting state to observable result, naming every state transition.`,
    check: `Ask the learner to predict or explain ${skill.title} and distinguish it from a plausible misconception.`,
    code: `Have the learner construct, repair or test a bounded artifact demonstrating: ${skill.outcomes[0]}`,
    transfer: `Remove any analogy and apply ${skill.title} in a structurally equivalent but surface-different context.`,
  };
  return {
    id: `${skill.id}.block.${index}.${mode}`,
    kind: `activity-${mode}`,
    title: `${mode[0].toUpperCase()}${mode.slice(1)} activity specification`,
    authoringStatus: "blueprint-draft",
    mode,
    applicability: applicabilityFor(mode, skill.evidence_types),
    promptSeed: promptSeeds[mode],
    acceptanceSignals: [
      ...skill.outcomes,
      `Evidence must be scorable as: ${skill.evidence_types.join(", ")}.`,
    ],
    neutralContextRequired: mode === "transfer",
  };
}

export function compileAuthoredFallbackLessonBlueprint(
  index: ContentIndex,
  skillId: string,
  options: LessonBlueprintCompilerOptions = {},
): AuthoredFallbackLessonBlueprint {
  if (
    options.selectedLanguage &&
    !(DSA_IMPLEMENTATION_LANGUAGES as readonly string[]).includes(options.selectedLanguage)
  ) {
    throw new RangeError(`Unsupported DSA implementation language '${options.selectedLanguage}'.`);
  }
  const location = index.skillLocationById.get(skillId);
  if (!location) throw new RangeError(`Unknown atomic skill '${skillId}'.`);
  const { course, module, skill } = location;
  const profile = profileFor(course, options);
  const sources = sourcesFor(course, skill);
  const prerequisiteTitles = skill.prerequisites
    .map((prerequisiteId) =>
      index.skillById.get(prerequisiteId)?.title ?? index.moduleById.get(prerequisiteId)?.title,
    )
    .filter((title): title is string => Boolean(title));

  const workedExample: WorkedExampleSpecification = {
    runtimeLabel:
      course.id === "dsa" && options.selectedLanguage
        ? `${options.selectedLanguage}; ${course.runtime.standard}`
        : `${course.runtime.language}; ${course.runtime.standard}`,
    artifactType: profile.artifactType,
    goal: skill.outcomes[0],
    startingState: profile.startingState,
    requiredSteps: profile.requiredSteps,
    validationRequirements: profile.validationRequirements,
    expectedEvidence: skill.evidence_types,
    executableContent: null,
    authoredExampleRequired: true,
  };

  const blocks: LessonBlueprintBlock[] = [
    {
      id: `${skill.id}.block.0.objective`,
      kind: "objective",
      title: "Observable objective",
      authoringStatus: "blueprint-draft",
      outcomes: skill.outcomes,
      evidenceTypes: skill.evidence_types,
    },
    {
      id: `${skill.id}.block.1.mental-model`,
      kind: "mental-model",
      title: "Plain-language mental model seed",
      authoringStatus: "blueprint-draft",
      plainLanguageSeed: `${skill.description} Explain this in concrete state-and-effect terms before introducing shorthand or analogy.`,
      canonicalTerms: [skill.title, ...prerequisiteTitles].slice(0, 5),
      authorPrompt: "Replace this seed with source-reviewed learner-facing prose and an explicit boundary where the model stops being accurate.",
    },
    {
      id: `${skill.id}.block.2.explanation`,
      kind: "source-linked-explanation-seed",
      title: "Source-linked explanation seed",
      authoringStatus: "blueprint-draft",
      seed: `${skill.description} Align every claim to the linked sources and these outcomes: ${skill.outcomes.join(" ")}`,
      sources,
      quotationAllowed: false,
    },
    {
      id: `${skill.id}.block.3.worked-example`,
      kind: "worked-example-specification",
      title: "Language-aware worked example specification",
      authoringStatus: "blueprint-draft",
      specification: workedExample,
    },
    {
      id: `${skill.id}.block.4.misconceptions`,
      kind: "misconception-prompts",
      title: "Misconception discovery prompts",
      authoringStatus: "blueprint-draft",
      prompts: [
        `What incorrect prediction would result from confusing ${skill.title} with ${prerequisiteTitles[0] ?? "a prerequisite concept"}?`,
        `Which empty, boundary, invalid or failure case would expose superficial understanding of ${skill.title}?`,
        `Which runtime- or language-specific shortcut would violate this skill's stated outcome or assumptions?`,
      ],
      confirmedMisconceptions: [],
      authorConfirmationRequired: true,
    },
    activityBlock(skill, "trace", 5),
    activityBlock(skill, "check", 6),
    activityBlock(skill, "code", 7),
    activityBlock(skill, "transfer", 8),
    {
      id: `${skill.id}.block.9.analogy`,
      kind: "analogy-slot",
      title: "Optional confirmed-interest analogy slot",
      authoringStatus: "blueprint-draft",
      enabledByDefault: false,
      approvedAnalogyIds: [],
      userConfirmationRequired: true,
      canonicalLessonMustStandAlone: true,
      limitationsRequired: true,
    },
    {
      id: `${skill.id}.block.10.recap`,
      kind: "recap",
      title: "Recap and delayed-review specification",
      authoringStatus: "blueprint-draft",
      prompts: [
        `Explain ${skill.title} without the worked example or analogy.`,
        `Name the assumptions, boundary cases and observable evidence for: ${skill.outcomes[0]}`,
        `Compare the chosen approach with one plausible alternative or misconception.`,
      ],
      delayedReviewRequired: true,
    },
    {
      id: `${skill.id}.block.11.accessibility`,
      kind: "accessibility-text",
      title: "Accessibility text and interaction requirements",
      authoringStatus: "blueprint-draft",
      textAlternativeSeed: `Provide a linear text account of the starting state, each transition and the final evidence for ${skill.title}.`,
      requirements: profile.accessibilityRequirements,
    },
  ];

  return {
    id: `${course.id}.${course.version}.${skill.id}.authored-fallback-v1`,
    courseId: course.id,
    courseVersion: course.version,
    moduleId: module.id,
    skillId: skill.id,
    title: skill.title,
    runtime: course.runtime,
    provenance: {
      compiler: "deterministic-authored-fallback-v1",
      contentStatus: "blueprint-draft",
      canonicalContent: false,
      editorialReviewRequired: true,
      notice:
        "This deterministic blueprint is derived from an authored coverage manifest. Its seeds and specifications are not editorially verified learner-facing prose, examples, answers or rubrics.",
    },
    blocks,
  };
}
