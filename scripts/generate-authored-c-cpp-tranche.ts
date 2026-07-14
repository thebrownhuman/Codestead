import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AssessmentBank,
  AuthoredLesson,
  AtomicSkill,
  CourseManifest,
  CourseModule,
} from "../src/lib/content";
import {
  applyBeginnerQualityTemplate,
  createBeginnerQualityContext,
} from "../src/lib/content/beginner-quality";
import {
  C_CPP_TRANCHE_SEEDS,
  type LanguageTeachingSeed,
} from "./content-seeds/c-cpp-tranche";

interface CodeSpec {
  readonly prompt: string;
  readonly starterCode: string;
  readonly referenceSolution: string;
  readonly tests: readonly {
    readonly id: string;
    readonly visibility: "visible" | "hidden";
    readonly category: "normal" | "boundary";
    readonly stdin: string;
    readonly expectedStdout: string;
  }[];
}

const CODE_SPECS: Readonly<Record<string, CodeSpec>> = {
  "c.types.operators": {
    prompt: "Read one integer x, compute x multiplied by two and then increased by one using a clear grouped C expression, and print only the resulting integer.",
    starterCode: "#include <stdio.h>\n\nint main(void) {\n    long long x;\n    if (scanf(\"%lld\", &x) != 1) return 1;\n    /* compute and print */\n    return 0;\n}\n",
    referenceSolution: "#include <stdio.h>\n\nint main(void) {\n    long long x;\n    if (scanf(\"%lld\", &x) != 1) return 1;\n    printf(\"%lld\\n\", x * 2 + 1);\n    return 0;\n}\n",
    tests: [
      { id: "operators-visible-positive", visibility: "visible", category: "normal", stdin: "4\n", expectedStdout: "9\n" },
      { id: "operators-hidden-zero", visibility: "hidden", category: "boundary", stdin: "0\n", expectedStdout: "1\n" },
      { id: "operators-hidden-negative", visibility: "hidden", category: "boundary", stdin: "-3\n", expectedStdout: "-5\n" },
    ],
  },
  "c.control.selection": {
    prompt: "Read one integer and print negative, zero, or positive using a mutually exclusive C selection whose boundary behavior is explicit.",
    starterCode: "#include <stdio.h>\n\nint main(void) {\n    int value;\n    if (scanf(\"%d\", &value) != 1) return 1;\n    /* classify value */\n    return 0;\n}\n",
    referenceSolution: "#include <stdio.h>\n\nint main(void) {\n    int value;\n    if (scanf(\"%d\", &value) != 1) return 1;\n    if (value < 0) puts(\"negative\");\n    else if (value == 0) puts(\"zero\");\n    else puts(\"positive\");\n    return 0;\n}\n",
    tests: [
      { id: "selection-visible-positive", visibility: "visible", category: "normal", stdin: "8\n", expectedStdout: "positive\n" },
      { id: "selection-hidden-zero", visibility: "hidden", category: "boundary", stdin: "0\n", expectedStdout: "zero\n" },
      { id: "selection-hidden-negative", visibility: "hidden", category: "normal", stdin: "-1\n", expectedStdout: "negative\n" },
    ],
  },
  "c.control.loops": {
    prompt: "Read an unsigned integer n no greater than 100000 and use a terminating C loop to print the sum of all integers from one through n; print zero for n equal to zero.",
    starterCode: "#include <stdio.h>\n\nint main(void) {\n    unsigned n;\n    if (scanf(\"%u\", &n) != 1 || n > 100000u) return 1;\n    unsigned long long sum = 0;\n    /* loop and print */\n    return 0;\n}\n",
    referenceSolution: "#include <stdio.h>\n\nint main(void) {\n    unsigned n;\n    if (scanf(\"%u\", &n) != 1 || n > 100000u) return 1;\n    unsigned long long sum = 0;\n    for (unsigned i = 1; i <= n; ++i) sum += i;\n    printf(\"%llu\\n\", sum);\n    return 0;\n}\n",
    tests: [
      { id: "loops-visible-five", visibility: "visible", category: "normal", stdin: "5\n", expectedStdout: "15\n" },
      { id: "loops-hidden-zero", visibility: "hidden", category: "boundary", stdin: "0\n", expectedStdout: "0\n" },
      { id: "loops-hidden-one", visibility: "hidden", category: "boundary", stdin: "1\n", expectedStdout: "1\n" },
    ],
  },
  "c.arrays.one-dimensional": {
    prompt: "Read a count from one to 100 followed by that many integers, traverse the C array within bounds, and print only the greatest value.",
    starterCode: "#include <stdio.h>\n\nint main(void) {\n    size_t count;\n    int values[100];\n    if (scanf(\"%zu\", &count) != 1 || count == 0 || count > 100) return 1;\n    /* read, traverse, print maximum */\n    return 0;\n}\n",
    referenceSolution: "#include <stdio.h>\n\nint main(void) {\n    size_t count;\n    int values[100];\n    if (scanf(\"%zu\", &count) != 1 || count == 0 || count > 100) return 1;\n    for (size_t i = 0; i < count; ++i) if (scanf(\"%d\", &values[i]) != 1) return 1;\n    int maximum = values[0];\n    for (size_t i = 1; i < count; ++i) if (values[i] > maximum) maximum = values[i];\n    printf(\"%d\\n\", maximum);\n    return 0;\n}\n",
    tests: [
      { id: "array-visible-mixed", visibility: "visible", category: "normal", stdin: "4\n-2 7 3 7\n", expectedStdout: "7\n" },
      { id: "array-hidden-single", visibility: "hidden", category: "boundary", stdin: "1\n-9\n", expectedStdout: "-9\n" },
      { id: "array-hidden-negative", visibility: "hidden", category: "boundary", stdin: "3\n-8 -2 -5\n", expectedStdout: "-2\n" },
    ],
  },
  "c.pointers.address": {
    prompt: "Read two integers, call a C function that swaps the caller-owned integer objects through valid pointers, and print the swapped values separated by one space.",
    starterCode: "#include <stdio.h>\n\nstatic void swap_ints(int *left, int *right) {\n    /* swap through the pointers */\n}\n\nint main(void) {\n    int a, b;\n    if (scanf(\"%d %d\", &a, &b) != 2) return 1;\n    swap_ints(&a, &b);\n    printf(\"%d %d\\n\", a, b);\n    return 0;\n}\n",
    referenceSolution: "#include <stdio.h>\n\nstatic void swap_ints(int *left, int *right) {\n    int temporary = *left;\n    *left = *right;\n    *right = temporary;\n}\n\nint main(void) {\n    int a, b;\n    if (scanf(\"%d %d\", &a, &b) != 2) return 1;\n    swap_ints(&a, &b);\n    printf(\"%d %d\\n\", a, b);\n    return 0;\n}\n",
    tests: [
      { id: "pointers-visible-distinct", visibility: "visible", category: "normal", stdin: "2 9\n", expectedStdout: "9 2\n" },
      { id: "pointers-hidden-equal", visibility: "hidden", category: "boundary", stdin: "4 4\n", expectedStdout: "4 4\n" },
      { id: "pointers-hidden-negative", visibility: "hidden", category: "normal", stdin: "-1 6\n", expectedStdout: "6 -1\n" },
    ],
  },
  "c.memory.allocate": {
    prompt: "Read a count from one to 100 followed by that many integers, allocate exactly the required C array with checked size and result, print their sum, and free the allocation on every completed path.",
    starterCode: "#include <stdio.h>\n#include <stdlib.h>\n\nint main(void) {\n    size_t count;\n    if (scanf(\"%zu\", &count) != 1 || count == 0 || count > 100) return 1;\n    /* allocate, read, sum, free */\n    return 0;\n}\n",
    referenceSolution: "#include <stdio.h>\n#include <stdlib.h>\n\nint main(void) {\n    size_t count;\n    if (scanf(\"%zu\", &count) != 1 || count == 0 || count > 100) return 1;\n    int *values = malloc(count * sizeof *values);\n    if (values == NULL) return 1;\n    long long sum = 0;\n    for (size_t i = 0; i < count; ++i) {\n        if (scanf(\"%d\", &values[i]) != 1) { free(values); return 1; }\n        sum += values[i];\n    }\n    printf(\"%lld\\n\", sum);\n    free(values);\n    return 0;\n}\n",
    tests: [
      { id: "allocate-visible-normal", visibility: "visible", category: "normal", stdin: "4\n1 2 3 4\n", expectedStdout: "10\n" },
      { id: "allocate-hidden-single", visibility: "hidden", category: "boundary", stdin: "1\n-7\n", expectedStdout: "-7\n" },
      { id: "allocate-hidden-cancel", visibility: "hidden", category: "normal", stdin: "3\n5 -5 2\n", expectedStdout: "2\n" },
    ],
  },
  "cpp.fundamentals.expressions": {
    prompt: "Read one integer x, evaluate the grouped C++ expression x multiplied by two and increased by one, and print only the resulting integer.",
    starterCode: "#include <iostream>\n\nint main() {\n    long long x{};\n    if (!(std::cin >> x)) return 1;\n    // compute and print\n}\n",
    referenceSolution: "#include <iostream>\n\nint main() {\n    long long x{};\n    if (!(std::cin >> x)) return 1;\n    std::cout << x * 2 + 1 << '\\n';\n}\n",
    tests: [
      { id: "cpp-expressions-visible", visibility: "visible", category: "normal", stdin: "6\n", expectedStdout: "13\n" },
      { id: "cpp-expressions-hidden-zero", visibility: "hidden", category: "boundary", stdin: "0\n", expectedStdout: "1\n" },
      { id: "cpp-expressions-hidden-negative", visibility: "hidden", category: "boundary", stdin: "-2\n", expectedStdout: "-3\n" },
    ],
  },
  "cpp.fundamentals.selection": {
    prompt: "Read an integer score and print fail below 50, pass from 50 through 79, or distinction from 80 upward using one mutually exclusive C++ selection.",
    starterCode: "#include <iostream>\n\nint main() {\n    int score{};\n    if (!(std::cin >> score)) return 1;\n    // classify score\n}\n",
    referenceSolution: "#include <iostream>\n\nint main() {\n    int score{};\n    if (!(std::cin >> score)) return 1;\n    if (score < 50) std::cout << \"fail\\n\";\n    else if (score < 80) std::cout << \"pass\\n\";\n    else std::cout << \"distinction\\n\";\n}\n",
    tests: [
      { id: "cpp-selection-visible-pass", visibility: "visible", category: "normal", stdin: "65\n", expectedStdout: "pass\n" },
      { id: "cpp-selection-hidden-fifty", visibility: "hidden", category: "boundary", stdin: "50\n", expectedStdout: "pass\n" },
      { id: "cpp-selection-hidden-eighty", visibility: "hidden", category: "boundary", stdin: "80\n", expectedStdout: "distinction\n" },
      { id: "cpp-selection-hidden-fail", visibility: "hidden", category: "boundary", stdin: "49\n", expectedStdout: "fail\n" },
    ],
  },
  "cpp.fundamentals.iteration": {
    prompt: "Read an unsigned integer n no greater than 100000, use a terminating C++ loop to sum one through n, and print zero when n is zero.",
    starterCode: "#include <iostream>\n\nint main() {\n    unsigned n{};\n    if (!(std::cin >> n) || n > 100000u) return 1;\n    unsigned long long sum{};\n    // loop and print\n}\n",
    referenceSolution: "#include <iostream>\n\nint main() {\n    unsigned n{};\n    if (!(std::cin >> n) || n > 100000u) return 1;\n    unsigned long long sum{};\n    for (unsigned i = 1; i <= n; ++i) sum += i;\n    std::cout << sum << '\\n';\n}\n",
    tests: [
      { id: "cpp-iteration-visible", visibility: "visible", category: "normal", stdin: "5\n", expectedStdout: "15\n" },
      { id: "cpp-iteration-hidden-zero", visibility: "hidden", category: "boundary", stdin: "0\n", expectedStdout: "0\n" },
      { id: "cpp-iteration-hidden-one", visibility: "hidden", category: "boundary", stdin: "1\n", expectedStdout: "1\n" },
    ],
  },
  "cpp.containers.sequence": {
    prompt: "Read a count from zero to 100 followed by that many integers into a std::vector, then print the values in reverse order separated by single spaces and end with a newline.",
    starterCode: "#include <iostream>\n#include <vector>\n\nint main() {\n    std::size_t count{};\n    if (!(std::cin >> count) || count > 100) return 1;\n    std::vector<int> values(count);\n    // read and print in reverse\n}\n",
    referenceSolution: "#include <iostream>\n#include <vector>\n\nint main() {\n    std::size_t count{};\n    if (!(std::cin >> count) || count > 100) return 1;\n    std::vector<int> values(count);\n    for (int& value : values) if (!(std::cin >> value)) return 1;\n    for (std::size_t i = values.size(); i > 0; --i) {\n        if (i != values.size()) std::cout << ' ';\n        std::cout << values[i - 1];\n    }\n    std::cout << '\\n';\n}\n",
    tests: [
      { id: "cpp-sequence-visible", visibility: "visible", category: "normal", stdin: "4\n1 2 3 4\n", expectedStdout: "4 3 2 1\n" },
      { id: "cpp-sequence-hidden-empty", visibility: "hidden", category: "boundary", stdin: "0\n", expectedStdout: "\n" },
      { id: "cpp-sequence-hidden-single", visibility: "hidden", category: "boundary", stdin: "1\n-3\n", expectedStdout: "-3\n" },
    ],
  },
  "cpp.algorithms.standard": {
    prompt: "Read up to 100 integers into a vector, use standard algorithms to sort them and remove duplicates, then print the unique ascending values separated by one space.",
    starterCode: "#include <algorithm>\n#include <iostream>\n#include <vector>\n\nint main() {\n    std::size_t count{};\n    if (!(std::cin >> count) || count > 100) return 1;\n    std::vector<int> values(count);\n    for (int& value : values) if (!(std::cin >> value)) return 1;\n    // sort, unique, erase, print\n}\n",
    referenceSolution: "#include <algorithm>\n#include <iostream>\n#include <vector>\n\nint main() {\n    std::size_t count{};\n    if (!(std::cin >> count) || count > 100) return 1;\n    std::vector<int> values(count);\n    for (int& value : values) if (!(std::cin >> value)) return 1;\n    std::sort(values.begin(), values.end());\n    values.erase(std::unique(values.begin(), values.end()), values.end());\n    for (std::size_t i = 0; i < values.size(); ++i) { if (i) std::cout << ' '; std::cout << values[i]; }\n    std::cout << '\\n';\n}\n",
    tests: [
      { id: "cpp-algorithms-visible", visibility: "visible", category: "normal", stdin: "6\n3 1 3 2 1 5\n", expectedStdout: "1 2 3 5\n" },
      { id: "cpp-algorithms-hidden-empty", visibility: "hidden", category: "boundary", stdin: "0\n", expectedStdout: "\n" },
      { id: "cpp-algorithms-hidden-equal", visibility: "hidden", category: "boundary", stdin: "3\n7 7 7\n", expectedStdout: "7\n" },
    ],
  },
  "cpp.generics.function-template": {
    prompt: "Define and use a function template larger that returns the greater of two const references, read three integers, and print the greatest by composing that template.",
    starterCode: "#include <iostream>\n\n// define larger template\n\nint main() {\n    int a{}, b{}, c{};\n    if (!(std::cin >> a >> b >> c)) return 1;\n    // print greatest using larger\n}\n",
    referenceSolution: "#include <iostream>\n\ntemplate <typename T>\nconst T& larger(const T& left, const T& right) {\n    return right < left ? left : right;\n}\n\nint main() {\n    int a{}, b{}, c{};\n    if (!(std::cin >> a >> b >> c)) return 1;\n    std::cout << larger(larger(a, b), c) << '\\n';\n}\n",
    tests: [
      { id: "cpp-template-visible", visibility: "visible", category: "normal", stdin: "2 9 4\n", expectedStdout: "9\n" },
      { id: "cpp-template-hidden-equal", visibility: "hidden", category: "boundary", stdin: "5 5 5\n", expectedStdout: "5\n" },
      { id: "cpp-template-hidden-negative", visibility: "hidden", category: "boundary", stdin: "-8 -2 -4\n", expectedStdout: "-2\n" },
    ],
  },
};

const root = process.cwd();
const contentRoot = path.join(root, "content");
const lessonRoot = path.join(contentRoot, "authored", "lessons");
const bankRoot = path.join(contentRoot, "authored", "assessment-banks");

async function loadCourse(id: "c" | "cpp"): Promise<CourseManifest> {
  return JSON.parse(await readFile(path.join(contentRoot, "courses", `${id}.json`), "utf8")) as CourseManifest;
}

function publication(summary: string) {
  return {
    stage: "draft" as const,
    author: { id: "codex-assisted-draft", displayName: "Codex-assisted C and C++ tranche", kind: "ai-assisted" as const },
    authoredAt: "2026-07-12T08:00:00.000Z",
    aiAssisted: true,
    reviewer: null,
    changeSummary: summary,
  };
}

function analogy(courseId: "c" | "cpp", title: string) {
  return courseId === "c"
    ? {
        example: `A manually managed workshop can model ${title}: every tool, address, buffer, and acquired resource has an explicit valid range and owner.`,
        useful: "Making low-level state, bounds, representation, ownership, and cleanup responsibilities concrete",
        limit: "C abstract-machine rules, undefined behavior, pointer provenance, translation, and implementation variation are stricter than a physical workshop analogy.",
      }
    : {
        example: `A system of self-managing components can model ${title}: each component protects an invariant and owns resources through typed interfaces and lifetime.`,
        useful: "Connecting types, value semantics, invariants, generic interfaces, ownership, and deterministic cleanup",
        limit: "C++ overload resolution, templates, value categories, object lifetime, and undefined behavior have no exact physical equivalent.",
      };
}

function lessonFor(course: CourseManifest, courseModule: CourseModule, skill: AtomicSkill, seed: LanguageTeachingSeed): AuthoredLesson {
  const sourceById = new Map(course.authoritative_sources.map((source) => [source.id, source]));
  const misconceptionId = `${skill.id}.misconception`;
  const comparison = analogy(course.id as "c" | "cpp", skill.title);
  return {
    $schema: "../../schema/authored-lesson.schema.json",
    format: "authored-lesson",
    schemaVersion: "1.0.0",
    id: `lesson.${skill.id}.v1`,
    courseId: course.id,
    courseVersion: course.version,
    moduleId: courseModule.id,
    skillId: skill.id,
    title: skill.title,
    publication: publication(`Language-specific ${course.title} draft for ${skill.title}; human standards, technical, pedagogy, and accessibility review required.`),
    sources: skill.source_refs.map((sourceRef) => {
      const source = sourceById.get(sourceRef);
      if (!source) throw new Error(`Missing source ${sourceRef} for ${skill.id}.`);
      return { sourceRef, locator: `${source.title}; ${source.version_or_date}; provisions applicable to ${skill.title}`, claim: seed.model };
    }),
    canonicalExplanation: {
      summary: seed.model,
      sections: [
        { heading: "Language rule and operational model", body: `${seed.model} This rule is applied to concrete ${course.id === "c" ? "C" : "C++"} source and observable behavior, not treated as a vocabulary definition alone.` },
        { heading: "Boundary and common failure", body: `${seed.boundary} Therefore the draft explicitly rejects this beginner failure model: ${seed.misconception}` },
      ],
    },
    scope: { includes: [skill.description, ...skill.outcomes], excludes: [seed.boundary] },
    outcomes: skill.outcomes,
    examples: [
      { id: `${skill.id}.example-a`, title: `${skill.title}: defined case`, situation: seed.scenarioA, walkthrough: [`Inspect the concrete source or state: ${seed.scenarioA}`, `Apply the language rule: ${seed.model}`, `Verify the conclusion: ${seed.correction}`], result: `The defined result follows because ${seed.correction}` },
      { id: `${skill.id}.example-b`, title: `${skill.title}: boundary case`, situation: seed.scenarioB, walkthrough: [`Identify the changed source or state: ${seed.scenarioB}`, `Keep this standard boundary visible: ${seed.boundary}`, `Reject the tempting rule: ${seed.misconception}`], result: `The boundary remains consistent with the language model: ${seed.model}` },
    ],
    misconceptions: [{ id: misconceptionId, mistakenBelief: seed.misconception, correction: seed.correction, diagnosticPrompt: `Using concrete ${course.id.toUpperCase()} rules, explain why this belief fails: ${seed.misconception}` }],
    analogy: { optional: true, example: comparison.example, usefulFor: [comparison.useful], limitations: [comparison.limit, seed.boundary], canonicalExplanationStandsAlone: true },
    trace: {
      artifact: [seed.scenarioA, seed.model, seed.correction],
      steps: [
        { step: 1, focus: "Source and state", state: { evidence: seed.scenarioA }, explanation: "Record the exact source form, input, object state, and applicable runtime or translation context before predicting behavior." },
        { step: 2, focus: "Language rule", state: { rule: seed.model }, explanation: `Apply the declared ${course.id.toUpperCase()} rule without importing behavior from another language or one familiar compiler.` },
        { step: 3, focus: "Defined conclusion", state: { conclusion: seed.correction }, explanation: `Check the conclusion against the boundary and reject this misconception: ${seed.misconception}` },
      ],
      textAlternative: `First inspect this concrete case: ${seed.scenarioA} Next apply this language rule: ${seed.model} Finally verify the defined conclusion: ${seed.correction}`,
    },
    practice: {
      faded: { prompt: `Complete the source-rule-result trace for this case: ${seed.scenarioA}`, scaffold: ["Name the exact source form and starting state.", "Select the applicable language rule and checkpoint.", "State whether behavior is defined and what is observable."], expectedEvidence: [skill.outcomes[0]!, seed.correction] },
      nearTransfer: { prompt: `Apply the same ${course.id.toUpperCase()} rule to this related boundary case: ${seed.scenarioB}`, scaffold: ["Identify which assumption changed.", "Do not infer behavior beyond the declared boundary."], expectedEvidence: [seed.model, seed.boundary] },
      farTransfer: { prompt: `Create a new ${course.id.toUpperCase()} example for ${skill.title}, include a normal and boundary input, and explain why the misconception fails.`, scaffold: ["Use complete source or a complete traceable fragment.", "Declare standard version and implementation assumptions."], expectedEvidence: [...skill.outcomes, seed.correction] },
    },
    remediation: [{ misconceptionId, explanation: seed.correction, retryPrompt: `Re-evaluate this case using the exact checkpoint '${seed.checkpoint}' and state the decisive evidence: ${seed.scenarioB}` }],
    recap: { summary: `${seed.model} The decisive boundary is: ${seed.boundary}`, retrievalPrompts: [`Explain ${skill.title} using a concrete ${course.id.toUpperCase()} rule rather than the optional analogy.`, `Why is this claim incorrect: ${seed.misconception}`, `Apply the checkpoint '${seed.checkpoint}' to the boundary case from memory.`], nextReviewPrompt: `On the next review, reproduce the model, checkpoint, and boundary for ${skill.title} before reopening this draft.` },
  };
}

function commonItemFields<const Kind extends "mcq" | "fill-gap" | "code">(
  skill: AtomicSkill,
  kind: Kind,
  points: number,
) {
  return {
    skillId: skill.id,
    kind,
    points,
    examEligibility: { eligible: false, rationale: "AI-assisted deterministic draft awaiting independent human standards and assessment review." },
    privateAuthorNotes: ["A human reviewer must verify language-version accuracy, distractor validity, equivalence, and grading evidence before formal use."],
  } as const;
}

function bankFor(course: CourseManifest, courseModule: CourseModule, skill: AtomicSkill, seed: LanguageTeachingSeed): AssessmentBank {
  if (!seed.correction.includes(seed.checkpoint)) throw new Error(`${skill.id} correction does not contain checkpoint '${seed.checkpoint}'.`);
  const fillTemplate = seed.correction.replace(seed.checkpoint, "{{key-rule}}");
  const items: AssessmentBank["items"][number][] = [
    {
      ...commonItemFields(skill, "mcq", 4),
      id: `${skill.id}.mcq.misconception`,
      title: `${skill.title}: reject the invalid rule`,
      prompt: `Which statement correctly resolves this ${course.id.toUpperCase()} misconception? ${seed.misconception}`,
      evidenceLevel: "interpret",
      hints: ["Compare each option with the exact language rule, standard boundary, and observable evidence in the authored draft."],
      feedback: { correct: `Correct. ${seed.correction}`, incorrect: `That option preserves the documented misconception. ${seed.correction}` },
      rubric: { passPoints: 4, criteria: [{ id: "language-rule", description: `Selects the source-aligned ${course.id.toUpperCase()} correction instead of the documented misconception.`, points: 4, critical: true }] },
      options: [{ id: "correct-rule", text: seed.correction }, { id: "documented-misconception", text: seed.misconception }],
      answer: { correctOptionIds: ["correct-rule"], explanation: seed.correction },
    },
    {
      ...commonItemFields(skill, "fill-gap", 4),
      id: `${skill.id}.fill.checkpoint`,
      title: `${skill.title}: complete the language rule`,
      prompt: `Complete the missing ${course.id.toUpperCase()} checkpoint in the source-aligned correction. Use the exact token or phrase required by this draft.`,
      evidenceLevel: "recall",
      hints: [`Use the checkpoint that distinguishes the valid rule from this misconception: ${seed.misconception}`],
      feedback: { correct: `Correct. The required checkpoint is '${seed.checkpoint}'.`, incorrect: `Recheck the exact language rule and its boundary. ${seed.correction}` },
      rubric: { passPoints: 4, criteria: [{ id: "exact-checkpoint", description: `Supplies the exact ${course.id.toUpperCase()} token or phrase that completes the reviewed rule candidate.`, points: 4, critical: true }] },
      template: fillTemplate,
      gaps: [{ id: "key-rule", label: "Missing language checkpoint" }],
      answer: { acceptedByGap: { "key-rule": [seed.checkpoint] }, caseSensitive: true, explanation: seed.correction },
    },
  ];
  const code = CODE_SPECS[skill.id];
  if (code) {
    items.push({
      ...commonItemFields(skill, "code", 10),
      id: `${skill.id}.code.apply`,
      title: `${skill.title}: executable application`,
      prompt: code.prompt,
      evidenceLevel: "apply",
      hints: ["Start from input validation and the declared observable output, then apply only the target language rule before considering optimization."],
      feedback: { correct: "All visible and hidden deterministic behavior checks passed for the bounded source task.", incorrect: "At least one deterministic behavior check failed; inspect bounds, input state, and the target rule without exposing hidden cases." },
      rubric: { passPoints: 10, criteria: [{ id: "behavior", description: "Compiles in the pinned runtime and passes every normal and boundary behavior test.", points: 7, critical: true }, { id: "target-rule", description: `Applies ${skill.title} without undefined behavior or an out-of-scope workaround.`, points: 3, critical: true }] },
      starterCode: code.starterCode,
      runtime: { engine: "isolated-runner", language: course.id === "c" ? "c" : "cpp", version: course.runtime.standard, entrypoint: course.id === "c" ? "main.c" : "main.cpp", timeLimitMs: 2000, memoryLimitMb: 128 },
      tests: code.tests.map((test) => ({ ...test, comparison: "trimmed" as const, critical: true })),
      answer: { referenceSolution: code.referenceSolution, explanation: `The reference solution implements the bounded ${skill.title} behavior and checks required input before producing exact output.` },
    });
  }
  return { $schema: "../../schema/assessment-bank.schema.json", format: "assessment-bank", schemaVersion: "1.0.0", id: `bank.${skill.id}.v1`, courseId: course.id, courseVersion: course.version, moduleId: courseModule.id, skillId: skill.id, title: `${skill.title} deterministic evidence bank`, publication: publication(`Language-specific deterministic MCQ and fill-gap evidence for ${skill.title}${code ? ", plus bounded code evidence" : ""}; human review required.`), sourceRefs: skill.source_refs, items };
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const courses = await Promise.all([loadCourse("c"), loadCourse("cpp")]);
  const targets = courses.flatMap((course) => course.modules.flatMap((courseModule) => courseModule.skills.map((skill) => ({ course, courseModule, skill }))));
  const expected = targets.map(({ skill }) => skill.id).sort();
  const actual = Object.keys(C_CPP_TRANCHE_SEEDS).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const supplied = new Set(actual); const required = new Set(expected);
    throw new Error(`Seed mismatch. Missing: ${expected.filter((id) => !supplied.has(id)).join(", ") || "none"}. Extra: ${actual.filter((id) => !required.has(id)).join(", ") || "none"}.`);
  }
  for (const { skill } of targets) {
    const seed = C_CPP_TRANCHE_SEEDS[skill.id as keyof typeof C_CPP_TRANCHE_SEEDS];
    if (!seed.correction.includes(seed.checkpoint)) {
      throw new Error(`${skill.id} correction does not contain checkpoint '${seed.checkpoint}'.`);
    }
  }
  for (const id of Object.keys(CODE_SPECS)) if (!C_CPP_TRANCHE_SEEDS[id as keyof typeof C_CPP_TRANCHE_SEEDS]) throw new Error(`Code spec targets unknown skill ${id}.`);
  if (!process.argv.includes("--apply")) {
    console.log(`Validated ${targets.length} C/C++ teaching seeds and ${Object.keys(CODE_SPECS).length} code specifications.`);
    return;
  }
  await Promise.all([mkdir(lessonRoot, { recursive: true }), mkdir(bankRoot, { recursive: true })]);
  for (const { course, courseModule, skill } of targets) {
    const lessonPath = path.join(lessonRoot, `${skill.id}.json`); const bankPath = path.join(bankRoot, `${skill.id}.json`);
    if (await exists(lessonPath) || await exists(bankPath)) throw new Error(`Refusing to overwrite authored content for ${skill.id}.`);
    const seed = C_CPP_TRANCHE_SEEDS[skill.id as keyof typeof C_CPP_TRANCHE_SEEDS];
    const lesson = applyBeginnerQualityTemplate(
      lessonFor(course, courseModule, skill, seed),
      createBeginnerQualityContext(course, courseModule, skill),
    );
    await writeFile(lessonPath, `${JSON.stringify(lesson, null, 2)}\n`, "utf8");
    await writeFile(bankPath, `${JSON.stringify(bankFor(course, courseModule, skill, seed), null, 2)}\n`, "utf8");
  }
  console.log(`Created ${targets.length} C/C++ draft lessons and banks; ${Object.keys(CODE_SPECS).length} banks include runner-test code items.`);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
