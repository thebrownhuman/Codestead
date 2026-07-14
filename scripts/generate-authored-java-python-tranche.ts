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
  JAVA_PYTHON_CODE_TASKS,
  type JavaPythonCodeTask,
} from "./content-seeds/java-python-code-tasks";
import {
  JAVA_PYTHON_TRANCHE_SEEDS,
  type JavaPythonTeachingSeed,
} from "./content-seeds/java-python-tranche";
import { PINNED_CURRICULUM_RUNTIMES } from "./pinned-curriculum-runtime";

const root = process.cwd();
const contentRoot = path.join(root, "content");
const lessonRoot = path.join(contentRoot, "authored", "lessons");
const bankRoot = path.join(contentRoot, "authored", "assessment-banks");
const JAVA_RUNNER_IMAGE_DIGEST = PINNED_CURRICULUM_RUNTIMES.java.imageDigest;
const PYTHON_RUNNER_IMAGE_DIGEST = PINNED_CURRICULUM_RUNTIMES.python.imageDigest;

interface AnalogyProfile {
  readonly frame: string;
  readonly usefulFor: string;
  readonly limitation: string;
}

const ANALOGIES: Readonly<Record<string, AnalogyProfile>> = {
  "java.toolchain": { frame: "a workshop that turns a checked design into a labeled machine part and then runs it on a compatible line", usefulFor: "separating source rules, build tools, class files, and runtime execution", limitation: "Java compatibility, verification, class loading, and diagnostics follow formal specifications rather than physical manufacturing" },
  "java.fundamentals": { frame: "a control panel whose typed gauges, expressions, switches, and repeating cycles produce observable state", usefulFor: "tracing primitive values, operators, decisions, and loop progress", limitation: "the panel does not model promotion, overflow, short-circuit evaluation, scope, or JVM representation exactly" },
  "java.methods-data": { frame: "a set of labeled workstations that accept copies of request values and process fixed trays or immutable text tickets", usefulFor: "reasoning about method contracts, scope, arrays, and strings", limitation: "reference values can still alias mutable objects and Unicode or overload rules have no exact workstation equivalent" },
  "java.objects": { frame: "a secured service object whose constructor admits only valid state and whose public desk exposes approved behavior", usefulFor: "understanding encapsulation, construction, identity, equality, and records", limitation: "object references, hashing, shallow immutability, and garbage collection are not physical ownership rules" },
  "java.abstraction": { frame: "a plug-and-socket system in which contracts describe compatible behavior while components hide their implementation", usefulFor: "interfaces, substitution, dispatch, and composition", limitation: "overload resolution, method hiding, constructor order, and multiple interface defaults require Java-specific rules" },
  "java.generics-collections": { frame: "a typed storage service whose labels constrain accepted contents and whose containers promise order, uniqueness, lookup, or removal policy", usefulFor: "generic relationships, wildcard direction, and collection choice", limitation: "type erasure, variance, hashing, iterator validity, and complexity guarantees are not visible in physical bins" },
  "java.errors-io": { frame: "a document desk that records a failure chain, handles only recoverable cases, and always closes borrowed equipment", usefulFor: "exception boundaries, paths, text encodings, and resource cleanup", limitation: "suppressed exceptions, stack unwinding, filesystem semantics, and serialization attacks need exact technical treatment" },
  "java.functional": { frame: "a one-pass processing line that transforms, filters, combines, or explicitly reports a missing result", usefulFor: "lambdas, stream stages, reduction, and Optional", limitation: "laziness, target typing, associativity, parallel regrouping, and single-use traversal have no complete conveyor analogy" },
  "java.packaging-quality": { frame: "a versioned delivery line whose public labels, recipe, inspections, and investigation record make one artifact reproducible", usefulFor: "packages, Maven, JUnit, debugging, and project evidence", limitation: "access control is not a security boundary and caches, plugins, bytecode, secrets, and platform differences need technical controls" },
  "java.runtime-concurrency": { frame: "a dispatch center that tracks reachable work orders and assigns bounded tasks while protecting shared ledgers", usefulFor: "reachability, executors, races, and virtual-thread workload choice", limitation: "memory visibility, scheduling, atomicity, cancellation, and garbage-collection timing cannot be inferred from human dispatch" },
  "python.toolchain": { frame: "an experiment notebook that becomes a saved procedure executed by one identified interpreter in a known workspace", usefulFor: "REPL experiments, scripts, environments, and tracebacks", limitation: "import caching, module paths, display hooks, indentation grammar, and traceback chaining are Python-specific" },
  "python.values-control": { frame: "a labeled decision board whose current objects feed expressions, branches, patterns, and repeatable progress rules", usefulFor: "scalar semantics, comparisons, selection, and iteration", limitation: "identity, truthiness, protocol dispatch, chained comparisons, and iterator behavior do not follow ordinary board-game rules" },
  "python.collections": { frame: "a flexible storeroom with ordered shelves, fixed labels, unique membership, lookup indexes, and shared nested containers", usefulFor: "lists, tuples, dictionaries, sets, aliasing, and text processing", limitation: "hashability, shallow copying, Unicode normalization, and object identity require Python's exact data model" },
  "python.functions": { frame: "a callable service counter with a published request form, binding rules, retained enclosing notes, and a recursive delegation limit", usefulFor: "contracts, parameters, closures, and recursion", limitation: "definition-time defaults, LEGB lookup, late binding, exceptions, and stack limits have no exact service-counter counterpart" },
  "python.modules-packaging": { frame: "a library whose catalogs, shelves, isolated rooms, and shipping manifest separate import names from installable distributions", usefulFor: "imports, packages, virtual environments, and pyproject builds", limitation: "sys.path, partial module initialization, build backends, editable installs, and wheel contents need direct inspection" },
  "python.errors-io": { frame: "a records office that escalates named failures, validates decoded forms, and returns borrowed resources on every exit", usefulFor: "exceptions, custom failure categories, files, JSON, and contexts", limitation: "exception chaining, suppression, path resolution, encoding, partial writes, and protocol methods are software rules" },
  "python.objects": { frame: "a family of service records whose instance state, generated value methods, inheritance order, and protocols define observable behavior", usefulFor: "classes, data classes, composition, inheritance, and special methods", limitation: "descriptor lookup, MRO, hashing, NotImplemented, and shallow frozen state do not map cleanly to physical records" },
  "python.iteration-functional": { frame: "a one-pass production route that can build a bounded result, expose an iterator, pause lazily, or wrap a callable", usefulFor: "comprehensions, iterators, generators, and decorators", limitation: "StopIteration, suspension, close behavior, metadata, wrapper order, and memory allocation require exact Python semantics" },
  "python.quality": { frame: "an inspected delivery package whose interface notes, repeatable checks, safe incident log, and clean installation prove bounded quality claims", usefulFor: "typing, tests, logging, debugging, and project completion", limitation: "annotations do not enforce runtime types, mocks can mislead, logs can leak, and local editable installs can hide packaging defects" },
  "python.concurrency": { frame: "a coordination desk that overlaps waiting jobs, assigns CPU work to separate rooms, and protects complete shared transitions", usefulFor: "concurrency models, asyncio, threads, processes, cancellation, and safety", limitation: "the event loop, GIL, serialization, atomicity, scheduling, and cancellation points must be reasoned about technically" },
};

const SOURCE_SECTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "dev-java": {
    "java.toolchain": "Getting Started, Tools, JShell, and Launching Single-File Source-Code Programs",
    "java.fundamentals": "Java Language Basics: variables, operators, control flow, and numbers",
    "java.methods-data": "Classes and Objects, Arrays, and String processing learning paths",
    "java.objects": "Classes and Objects, Inheritance, Records, and Object methods learning paths",
    "java.abstraction": "Interfaces, Inheritance, Polymorphism, and composition guidance",
    "java.generics-collections": "Generics and Collections Framework learning paths",
    "java.errors-io": "Exceptions and Java I/O learning paths",
    "java.functional": "Lambda Expressions and Stream API learning paths",
    "java.packaging-quality": "Packages, debugging, tools, and application project guidance",
    "java.runtime-concurrency": "JVM/runtime concepts, Concurrency, and Virtual Threads learning paths",
  },
  jls21: {
    "java.toolchain": "JLS §§7.6, 12, and 13: compilation units, execution, and binary compatibility",
    "java.fundamentals": "JLS chapters 4, 5, 14, and 15: types, conversions, statements, and expressions",
    "java.methods-data": "JLS §§6.3, 8.4, chapter 10, and §§15.12, 15.18.1: scope, methods, arrays, invocation, and strings",
    "java.objects": "JLS §§8.1-8.10 and 15.21.3: classes, constructors, records, and reference equality",
    "java.abstraction": "JLS chapters 8-9 and §§15.12.2, 15.12.4: inheritance, interfaces, overload selection, and dispatch",
    "java.generics-collections": "JLS §§4.5, 4.10, 5.1, and 8.4.4: parameterized types, subtyping, conversion, and generic methods",
    "java.errors-io": "JLS chapter 11: exception kinds, checking, causes, and abrupt completion",
    "java.functional": "JLS §§9.8, 15.13, and 15.27: functional interfaces, method references, and lambdas",
    "java.packaging-quality": "JLS chapters 6-7: names, access control, packages, and modules",
    "java.runtime-concurrency": "JLS §§12.6 and 17.4: object finalization/reachability context and memory-model happens-before rules",
  },
  junit5: { "java.packaging-quality": "Writing Tests, Assertions, Exception Testing, and Parameterized Tests" },
  maven: { "java.packaging-quality": "Creating a Project, Standard Directory Layout, POM, Dependencies, and Build Lifecycle" },
  "py-tutorial": {
    "python.toolchain": "Tutorial chapters 2-4 and 8: interpreter, first steps, control flow, and errors",
    "python.values-control": "Tutorial chapters 3-5: values, control flow, and data structures",
    "python.collections": "Tutorial chapter 5: lists, tuples, sets, dictionaries, looping, and sequence comparison",
    "python.functions": "Tutorial §4.9 and chapter 8: function definitions, parameter rules, and errors",
    "python.modules-packaging": "Tutorial chapter 6: modules, packages, import execution, and search path",
    "python.errors-io": "Tutorial chapters 7-8: input/output, files, JSON, exceptions, and cleanup",
    "python.objects": "Tutorial chapter 9: scopes, classes, instances, inheritance, private conventions, and iterators",
    "python.iteration-functional": "Tutorial §§4.7 and 5.1-5.6: iteration, range, comprehensions, and sequence techniques",
  },
  "py-reference": {
    "python.toolchain": "Language Reference chapters 2, 4, and 7: lexical analysis, execution model, and simple statements",
    "python.values-control": "Language Reference chapters 6 and 8: expressions and compound statements including match",
    "python.collections": "Data Model plus expression sections for containers, subscriptions, slicing, membership, and comparisons",
    "python.functions": "Execution Model and Function Definitions: name binding, scopes, closures, calls, and defaults",
    "python.modules-packaging": "Import System and Execution Model: module loading, package context, and name binding",
    "python.errors-io": "Simple and Compound Statements: raise, try, with, exception chaining, and cleanup",
    "python.objects": "Data Model and Class Definitions: attribute access, special methods, MRO, equality, and hashing",
    "python.iteration-functional": "Data Model iterator protocol plus yield expressions, generator functions, and decorators",
    "python.quality": "Type annotation grammar and runtime annotation behavior",
    "python.concurrency": "Data Model coroutine and asynchronous iterator protocols",
  },
  "py-stdlib": {
    "python.toolchain": "sys, pathlib, traceback, importlib, and runtime-services documentation",
    "python.collections": "collections, copy, string, unicodedata, and text-processing documentation",
    "python.modules-packaging": "venv, sysconfig, importlib, and module-discovery documentation",
    "python.errors-io": "pathlib, io, json, contextlib, and built-in exception documentation",
    "python.objects": "dataclasses, collections.abc, and data-model-supporting library documentation",
    "python.iteration-functional": "itertools, functools.wraps, and collections.abc iterator documentation",
    "python.quality": "typing, unittest, logging, pdb, and development-tools documentation",
    "python.concurrency": "asyncio, concurrent.futures, threading, multiprocessing, queue, and synchronization documentation",
  },
  "py-packaging": { "python.modules-packaging": "Virtual Environments, Writing pyproject.toml, Packaging Projects, and Command-Line Tools guides" },
  "cs2023-sdf": {
    "*": "CS2023 Software Development Fundamentals: programming practices, testing, debugging, abstraction, data, and concurrency outcomes as applicable",
  },
};

function publication(changeSummary: string) {
  return {
    stage: "draft" as const,
    author: {
      id: "codex-assisted-java-python",
      displayName: "Codex-assisted Java and Python tranche",
      kind: "ai-assisted" as const,
    },
    authoredAt: "2026-07-12T08:30:00.000Z",
    aiAssisted: true,
    reviewer: null,
    changeSummary,
  };
}

async function loadCourse(fileName: string): Promise<CourseManifest> {
  return JSON.parse(await readFile(path.join(contentRoot, "courses", fileName), "utf8")) as CourseManifest;
}

function sourceLocator(sourceRef: string, courseModule: CourseModule, sourceTitle: string, version: string, skillTitle: string): string {
  const sections = SOURCE_SECTIONS[sourceRef];
  const section = sections?.[courseModule.id] ?? sections?.["*"];
  if (!section) throw new Error(`Missing source section profile for ${sourceRef}:${courseModule.id}.`);
  return `${sourceTitle}; ${version}; ${section}; atomic topic: ${skillTitle}`;
}

function buildLesson(course: CourseManifest, courseModule: CourseModule, skill: AtomicSkill, seed: JavaPythonTeachingSeed): AuthoredLesson {
  const profile = ANALOGIES[courseModule.id];
  if (!profile) throw new Error(`Missing analogy profile for ${courseModule.id}.`);
  const sources = new Map(course.authoritative_sources.map((source) => [source.id, source]));
  const misconceptionId = `${skill.id}.misconception`;
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
    publication: publication(`Language-specific source-linked draft lesson for ${skill.title}; independent technical, source, pedagogy, accessibility, and runnable-example review remains required.`),
    sources: skill.source_refs.map((sourceRef) => {
      const source = sources.get(sourceRef);
      if (!source) throw new Error(`${skill.id} references missing source ${sourceRef}.`);
      return {
        sourceRef,
        locator: sourceLocator(sourceRef, courseModule, source.title, source.version_or_date, skill.title),
        claim: seed.model,
      };
    }),
    canonicalExplanation: {
      summary: seed.model,
      sections: [
        { heading: "Language-specific operational model", body: `${seed.model} This model is applied through the declared ${course.title} behavior rather than a language-neutral slogan.` },
        { heading: "Boundary and failure model", body: `${seed.boundary} The learner must reject this documented misconception: ${seed.misconception}` },
      ],
    },
    scope: { includes: [skill.description, ...skill.outcomes], excludes: [seed.boundary] },
    outcomes: skill.outcomes,
    examples: [
      {
        id: `${skill.id}.example.direct`,
        title: `${skill.title}: direct language case`,
        situation: seed.scenarioA,
        walkthrough: [
          `Observe the concrete ${course.title} state or tool result: ${seed.scenarioA}`,
          `Apply the source-linked operational model: ${seed.model}`,
          `Verify the result with this correction: ${seed.correction}`,
        ],
        result: `The example meets the atomic outcome because ${seed.correction}`,
      },
      {
        id: `${skill.id}.example.boundary`,
        title: `${skill.title}: boundary and transfer case`,
        situation: seed.scenarioB,
        walkthrough: [
          `Name what changed from the direct case: ${seed.scenarioB}`,
          `Keep the language boundary explicit: ${seed.boundary}`,
          `Reject the tempting but incorrect rule: ${seed.misconception}`,
        ],
        result: `The boundary remains consistent with the source-linked model: ${seed.model}`,
      },
    ],
    misconceptions: [{
      id: misconceptionId,
      mistakenBelief: seed.misconception,
      correction: seed.correction,
      diagnosticPrompt: `Predict both examples and identify the first observable contradiction in this belief: ${seed.misconception}`,
    }],
    analogy: {
      optional: true,
      example: `${profile.frame} can introduce ${skill.title}, after the canonical ${course.title} rule is stated first.`,
      usefulFor: [profile.usefulFor],
      limitations: [profile.limitation, seed.boundary],
      canonicalExplanationStandsAlone: true,
    },
    trace: {
      artifact: [seed.scenarioA, seed.model, seed.correction],
      steps: [
        { step: 1, focus: "Observe", state: { evidence: seed.scenarioA }, explanation: "Record the exact input, binding, state, tool phase, or runtime result before applying a rule." },
        { step: 2, focus: "Apply", state: { rule: seed.model }, explanation: `Apply the declared ${course.title} model and keep its evaluation, type, state, ownership, environment, or lifecycle assumptions visible.` },
        { step: 3, focus: "Verify", state: { correction: seed.correction }, explanation: `Compare the observation with the correction and explain why the misconception fails: ${seed.misconception}` },
      ],
      textAlternative: `First observe: ${seed.scenarioA} Then apply: ${seed.model} Finally verify using: ${seed.correction}`,
    },
    practice: {
      faded: { prompt: `Complete a claim-evidence-reasoning trace for this ${course.title} case: ${seed.scenarioA}`, scaffold: ["Name the observable starting evidence.", `Select the exact part of the ${skill.title} model that applies.`, "State the result and reject one alternative."], expectedEvidence: [skill.outcomes[0]!, seed.correction] },
      nearTransfer: { prompt: `Apply the same atomic skill to this changed case: ${seed.scenarioB}`, scaffold: ["Identify the changed input, state, type, environment, or lifecycle condition.", "Preserve the declared boundary before predicting."], expectedEvidence: [seed.model, seed.boundary] },
      farTransfer: { prompt: `Create a neutral-context ${course.title} example of ${skill.title}, predict its output or failure, and explain why the documented misconception would fail.`, scaffold: ["Do not reuse the optional analogy.", "Declare every relevant input and language/runtime assumption."], expectedEvidence: [...skill.outcomes, seed.correction] },
    },
    remediation: [{ misconceptionId, explanation: seed.correction, retryPrompt: `Re-evaluate the boundary case after applying the correction, then name the decisive source-aligned evidence: ${seed.scenarioB}` }],
    recap: {
      summary: `${seed.model} The critical boundary is: ${seed.boundary}`,
      retrievalPrompts: [`Explain ${skill.title} using canonical ${course.title} terms and one observable consequence.`, `Why is this belief incorrect: ${seed.misconception}`, `Predict this case from memory: ${seed.scenarioB}`],
      nextReviewPrompt: `On the next review, reproduce the model, boundary, checkpoint '${seed.checkpoint}', and correction before reopening the lesson.`,
    },
  };
}

const blockedRationale = "AI-assisted draft item; independent human source, technical, pedagogy, accessibility, and answer-oracle review is required before formal-exam eligibility.";

function codeItem(course: CourseManifest, skill: AtomicSkill, task: JavaPythonCodeTask) {
  const language = course.id === "java" ? "java" as const : "python" as const;
  return {
    id: `${skill.id}.code.core`,
    skillId: skill.id,
    title: `${skill.title}: runnable core task`,
    kind: "code" as const,
    prompt: task.prompt,
    points: 8,
    evidenceLevel: "apply" as const,
    examEligibility: { eligible: false, rationale: blockedRationale },
    hints: ["Start from the stated input/output contract, implement the smallest language-specific operation, and run the visible boundary before changing structure."],
    feedback: { correct: `The visible and hidden ${course.title} runner checks match the declared contract.`, incorrect: "At least one deterministic runner check differs; inspect input parsing, boundary behavior, and exact output before retrying." },
    rubric: { passPoints: 8, criteria: [{ id: "runner-contract", description: "Compiles or parses and passes every visible and hidden deterministic runner check for the declared contract.", points: 8, critical: true }] },
    privateAuthorNotes: ["Reference solution and both tests are AI-assisted draft material. Execute in the pinned runner and obtain independent human review before any exam use."],
    starterCode: task.starterCode,
    runtime: {
      engine: "isolated-runner" as const,
      language,
      version: course.id === "java" ? "Java SE 21" : "Python 3.14",
      imageDigest: course.id === "java" ? JAVA_RUNNER_IMAGE_DIGEST : PYTHON_RUNNER_IMAGE_DIGEST,
      entrypoint: course.id === "java" ? "Main.java" : "main.py",
      timeLimitMs: 2_000,
      memoryLimitMb: course.id === "java" ? 256 : 128,
    },
    tests: task.tests.map((runnerTest, index) => ({ id: `${skill.id}.case.${index + 1}`, visibility: index === 0 ? "visible" as const : "hidden" as const, category: runnerTest.category, stdin: runnerTest.stdin, expectedStdout: runnerTest.expectedStdout, comparison: "trimmed" as const, critical: true })),
    answer: { referenceSolution: task.referenceSolution, explanation: task.explanation },
  };
}

function buildBank(course: CourseManifest, courseModule: CourseModule, skill: AtomicSkill, seed: JavaPythonTeachingSeed): AssessmentBank {
  if (!seed.correction.includes(seed.checkpoint)) throw new Error(`${skill.id}: checkpoint is not present in correction.`);
  const checkpointTemplate = seed.correction.replace(seed.checkpoint, "[[checkpoint]]");
  const task = JAVA_PYTHON_CODE_TASKS[skill.id as keyof typeof JAVA_PYTHON_CODE_TASKS] as JavaPythonCodeTask | undefined;
  const items: AssessmentBank["items"][number][] = [
    {
      id: `${skill.id}.mcq.misconception`, skillId: skill.id, title: `${skill.title}: reject the misconception`, kind: "mcq", prompt: `Which statement is source-aligned for ${course.title} and corrects this misconception? ${seed.misconception}`, points: 4, evidenceLevel: "interpret", examEligibility: { eligible: false, rationale: blockedRationale }, hints: ["Compare each option with both the language-specific boundary case and the cited operational model."], feedback: { correct: `Correct. ${seed.correction}`, incorrect: `That choice preserves the misconception. ${seed.correction}` }, rubric: { passPoints: 4, criteria: [{ id: "source-aligned-choice", description: "Selects the source-aligned correction and rejects the documented misconception.", points: 4, critical: true }] }, privateAuthorNotes: ["A human reviewer must verify source fidelity and ensure the distractor remains plausible without teaching it as fact."], options: [{ id: "source-aligned", text: seed.correction }, { id: "misconception", text: seed.misconception }], answer: { correctOptionIds: ["source-aligned"], explanation: seed.correction },
    },
    {
      id: `${skill.id}.fill.checkpoint`, skillId: skill.id, title: `${skill.title}: canonical checkpoint`, kind: "fill-gap", prompt: `Complete the source-aligned ${course.title} correction with the exact canonical phrase used by this lesson.`, points: 4, evidenceLevel: "recall", examEligibility: { eligible: false, rationale: blockedRationale }, hints: ["Retrieve the short checkpoint phrase from the operational correction, then read the complete sentence for semantic fit."], feedback: { correct: `Correct. The checkpoint is '${seed.checkpoint}'. ${seed.correction}`, incorrect: `The phrase must preserve the exact language rule. ${seed.correction}` }, rubric: { passPoints: 4, criteria: [{ id: "canonical-phrase", description: "Supplies the exact canonical checkpoint phrase that completes the source-aligned correction.", points: 4, critical: true }] }, privateAuthorNotes: ["Human reviewer must verify the accepted phrase and whether additional spelling variants are technically equivalent."], template: checkpointTemplate, gaps: [{ id: "checkpoint", label: "Canonical phrase" }], answer: { acceptedByGap: { checkpoint: [seed.checkpoint] }, caseSensitive: false, explanation: seed.correction },
    },
  ];
  if (task) items.push(codeItem(course, skill, task));
  return {
    $schema: "../../schema/assessment-bank.schema.json",
    format: "assessment-bank",
    schemaVersion: "1.0.0",
    id: `bank.${skill.id}.v1`,
    courseId: course.id,
    courseVersion: course.version,
    moduleId: courseModule.id,
    skillId: skill.id,
    title: `${skill.title} deterministic draft bank`,
    publication: publication(`Misconception MCQ, canonical fill-gap, and${task ? " runnable core task" : " no code task"} for ${skill.title}; every item remains blocked from formal exams pending independent human review.`),
    sourceRefs: skill.source_refs,
    items,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

async function writeGenerated(filePath: string, value: unknown, overwrite: boolean): Promise<void> {
  if (!overwrite && await exists(filePath)) throw new Error(`Refusing to overwrite existing authored content: ${filePath}`);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const courses = await Promise.all([loadCourse("java.json"), loadCourse("python.json")]);
  const targets = courses.flatMap((course) => course.modules.flatMap((courseModule) => courseModule.skills.map((skill) => ({ course, courseModule, skill }))));
  const expectedIds = targets.map(({ skill }) => skill.id).sort();
  const seedIds = Object.keys(JAVA_PYTHON_TRANCHE_SEEDS).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(seedIds)) {
    const expected = new Set(expectedIds); const supplied = new Set(seedIds);
    throw new Error(`Teaching seed mismatch. Missing: ${expectedIds.filter((id) => !supplied.has(id)).join(", ") || "none"}. Extra: ${seedIds.filter((id) => !expected.has(id)).join(", ") || "none"}.`);
  }
  const codeIds = Object.keys(JAVA_PYTHON_CODE_TASKS).sort();
  const invalidCodeIds = codeIds.filter((id) => !expectedIds.includes(id));
  if (invalidCodeIds.length) throw new Error(`Code tasks reference non-target skills: ${invalidCodeIds.join(", ")}.`);
  if (!process.argv.includes("--apply")) {
    console.log(`Validated ${targets.length} Java/Python teaching seeds and ${codeIds.length} runnable core tasks. Re-run with --apply to generate draft artifacts.`);
    return;
  }
  const overwrite = process.argv.includes("--overwrite");
  await Promise.all([mkdir(lessonRoot, { recursive: true }), mkdir(bankRoot, { recursive: true })]);
  for (const { course, courseModule, skill } of targets) {
    const seed = JAVA_PYTHON_TRANCHE_SEEDS[skill.id as keyof typeof JAVA_PYTHON_TRANCHE_SEEDS];
    const lesson = applyBeginnerQualityTemplate(
      buildLesson(course, courseModule, skill, seed),
      createBeginnerQualityContext(course, courseModule, skill),
    );
    await writeGenerated(path.join(lessonRoot, `${skill.id}.json`), lesson, overwrite);
    await writeGenerated(path.join(bankRoot, `${skill.id}.json`), buildBank(course, courseModule, skill, seed), overwrite);
  }
  console.log(`Generated ${targets.length} draft lessons and ${targets.length} draft banks with ${codeIds.length} runnable core tasks.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
