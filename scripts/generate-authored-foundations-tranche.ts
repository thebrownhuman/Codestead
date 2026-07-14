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
  FOUNDATIONS_GIT_TRANCHE_SEEDS,
  type TrancheTeachingSeed,
} from "./content-seeds/foundations-git-tranche";

const root = process.cwd();
const contentRoot = path.join(root, "content");
const lessonRoot = path.join(contentRoot, "authored", "lessons");
const bankRoot = path.join(contentRoot, "authored", "assessment-banks");
const existingPilotSkills = new Set(["pf.computing.program", "pf.state.variables"]);

interface AnalogyProfile {
  readonly example: (title: string) => string;
  readonly usefulFor: string;
  readonly limitation: string;
}

const FOUNDATION_ANALOGIES: Readonly<Record<string, AnalogyProfile>> = {
  "pf.computing": {
    example: (title) => `A workshop can model ${title}: instructions direct workers, the workbench holds active materials, and shelves preserve supplies between jobs.`,
    usefulFor: "Separating active execution, temporary state, persistent material, and coordinating roles",
    limitation: "Computer components follow formal interfaces and timing rules that a human workshop does not reproduce.",
  },
  "pf.problem-solving": {
    example: (title) => `Planning a trip can model ${title}: name the destination, inputs and constraints, divide the journey, and check routes before traveling.`,
    usefulFor: "Making requirements, ordered decisions, decomposition, and edge conditions concrete",
    limitation: "Programs require unambiguous executable rules, while a traveler can improvise from incomplete directions.",
  },
  "pf.state": {
    example: (title) => `A labeled scoreboard can model ${title}: each label exposes a current value and each recorded event produces the next visible state.`,
    usefulFor: "Reasoning about values, expressions, named state, and changes across time",
    limitation: "The scoreboard does not accurately model binary representation, scope, aliases, object identity, or language coercion.",
  },
  "pf.control": {
    example: (title) => `A route with ordered checkpoints, forks, and repeated laps can model ${title} while each decision uses the current conditions.`,
    usefulFor: "Visualizing order, branching, repetition, progress, and nested routes",
    limitation: "Real control flow can include calls, exceptions, concurrency, and evaluation rules absent from a physical route.",
  },
  "pf.abstraction": {
    example: (title) => `A service counter can model ${title}: it advertises accepted requests and results while its internal work remains behind a named interface.`,
    usefulFor: "Separating contracts, local work, calls, returned results, and repeated service use",
    limitation: "A service counter does not capture language-specific frames, reference semantics, closures, or recursion limits.",
  },
  "pf.data": {
    example: (title) => `An organized storeroom can model ${title}: shelves preserve order, labeled bins group fields, membership lists avoid duplicates, and indexes locate values.`,
    usefulFor: "Comparing organization by order, name, membership, lookup, and update needs",
    limitation: "Physical storage hides concrete complexity, equality, hashing, mutation, allocation, and concurrency guarantees.",
  },
  "pf.tools-quality": {
    example: (title) => `A repair bench can model ${title}: identify the correct part, use a named tool, read the first reliable symptom, test one cause, and verify the repair.`,
    usefulFor: "Building a careful inspect, edit, run, diagnose, and verify workflow",
    limitation: "Software tools have shell parsing, filesystem, runtime, and diagnostic rules that physical tools do not share.",
  },
  "pf.learning-practice": {
    example: (title) => `Sports coaching can model ${title}: study a play, attempt it, use specific feedback, retry independently, and credit the people or material that helped.`,
    usefulFor: "Connecting explanation, feedback, independent transfer, assistance, and integrity",
    limitation: "Learning evidence and reuse permissions are governed by explicit course and software rules, not only informal coaching norms.",
  },
};

const GIT_ANALOGIES: Readonly<Record<string, AnalogyProfile>> = {
  "git.shell-files": {
    example: (title) => `A labeled filing room can model ${title}: current location changes how relative directions resolve, and moving differs from copying a folder.`,
    usefulFor: "Reasoning about exact locations, inspection, file operations, and destructive scope",
    limitation: "Shell expansion, permissions, links, filesystem rules, and command execution can behave unlike physical folders.",
  },
  "git.model": {
    example: (title) => `A photo studio can model ${title}: the set is the working tree, a selected proof is the index, and an archived photograph is a commit snapshot.`,
    usefulFor: "Separating working changes, staged content, committed snapshots, and repository metadata",
    limitation: "Git stores content-addressed objects and references rather than physical photographs or one linear album.",
  },
  "git.history": {
    example: (title) => `A signed lab notebook can model ${title}: stable entries record why a change happened, named markers identify milestones, and comparisons expose differences.`,
    usefulFor: "Inspecting immutable records, messages, selected versions, differences, and milestone names",
    limitation: "Git history is a directed graph with movable references, merges, and content-addressed objects, not a single bound notebook.",
  },
  "git.branches": {
    example: (title) => `A route map can model ${title}: movable signposts identify current destinations, routes diverge, and integration reconnects selected paths.`,
    usefulFor: "Visualizing references, divergence, ancestry, merge bases, and reconciled paths",
    limitation: "Branches are lightweight references to commits, not copied roads or independent containers of files.",
  },
  "git.remotes": {
    example: (title) => `Two libraries exchanging catalog updates can model ${title}: each keeps an independent collection and synchronizes selected records deliberately.`,
    usefulFor: "Separating local history, remote observations, download, integration, and publication",
    limitation: "Git refspecs, authentication, ancestry checks, force updates, and object transfer have no exact library equivalent.",
  },
  "git.collaboration": {
    example: (title) => `An editorial desk can model ${title}: a request defines the change, a draft presents evidence, reviewers comment, and approved work enters the edition.`,
    usefulFor: "Connecting issues, bounded changes, actionable review, checks, and controlled integration",
    limitation: "Repository permissions, automated checks, security disclosure, and commit identity require explicit technical controls.",
  },
  "git.tools-build": {
    example: (title) => `A recipe and packing line can model ${title}: declared ingredients resolve to exact supplies, controlled steps produce an artifact, and labels preserve provenance.`,
    usefulFor: "Understanding dependency resolution, configuration, repeatable builds, and generated artifacts",
    limitation: "Software supply chains include executable dependencies, caches, signatures, platform variance, and secret handling beyond a kitchen process.",
  },
  "git.quality-debug": {
    example: (title) => `A controlled investigation can model ${title}: preserve evidence, state a hypothesis, inspect one clue, automate repeatable checks, and narrow the change point.`,
    usefulFor: "Linking debugging, static checks, history search, and automated local gates",
    limitation: "Debuggers and hooks can alter timing or execute code, and tool findings remain bounded evidence rather than proof.",
  },
  "git.ci-security-recovery": {
    example: (title) => `A secured checkpoint system can model ${title}: each revision is inspected, credentials are restricted, incidents revoke access, and recovery preserves known-good state.`,
    usefulFor: "Connecting pipeline evidence, secret response, reversible change, and collaborative policy",
    limitation: "CI isolation, credential propagation, Git reachability, and distributed copies require technical controls beyond checkpoint paperwork.",
  },
};

function analogyFor(courseId: string, moduleId: string): AnalogyProfile {
  const profiles = courseId === "programming-foundations" ? FOUNDATION_ANALOGIES : GIT_ANALOGIES;
  const profile = profiles[moduleId];
  if (!profile) throw new Error(`No analogy profile for ${moduleId}.`);
  return profile;
}

async function loadCourse(fileName: string): Promise<CourseManifest> {
  return JSON.parse(await readFile(path.join(contentRoot, "courses", fileName), "utf8")) as CourseManifest;
}

function publication(changeSummary: string) {
  return {
    stage: "draft" as const,
    author: {
      id: "codex-assisted-draft",
      displayName: "Codex-assisted curriculum tranche",
      kind: "ai-assisted" as const,
    },
    authoredAt: "2026-07-12T06:30:00.000Z",
    aiAssisted: true,
    reviewer: null,
    changeSummary,
  };
}

function buildLesson(
  course: CourseManifest,
  courseModule: CourseModule,
  skill: AtomicSkill,
  seed: TrancheTeachingSeed,
): AuthoredLesson {
  const analogy = analogyFor(course.id, courseModule.id);
  const sources = new Map(course.authoritative_sources.map((source) => [source.id, source]));
  const misconceptionId = `${skill.id}.misconception`;
  const sourceCitations = skill.source_refs.map((sourceRef) => {
    const source = sources.get(sourceRef);
    if (!source) throw new Error(`${skill.id} references missing source ${sourceRef}.`);
    return {
      sourceRef,
      locator: `${source.title}; ${source.version_or_date}; section applicable to ${skill.title}`,
      claim: seed.model,
    };
  });
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
    publication: publication(`Topic-specific draft for ${skill.title}; requires human source, technical, pedagogy, and accessibility review.`),
    sources: sourceCitations,
    canonicalExplanation: {
      summary: seed.model,
      sections: [
        {
          heading: "Operational model",
          body: `${seed.model} The learner should use this model to predict an observable result rather than merely repeat terminology.`,
        },
        {
          heading: "Boundary and failure point",
          body: `${seed.boundary} A correct explanation therefore includes the applicable assumptions and avoids this common mistake: ${seed.misconception}`,
        },
      ],
    },
    scope: {
      includes: [skill.description, ...skill.outcomes],
      excludes: [seed.boundary],
    },
    outcomes: skill.outcomes,
    examples: [
      {
        id: `${skill.id}.example-a`,
        title: `${skill.title}: direct case`,
        situation: seed.scenarioA,
        walkthrough: [
          `Observe the starting evidence: ${seed.scenarioA}`,
          `Apply the skill-specific model: ${seed.model}`,
          `Check the result against this correction: ${seed.correction}`,
        ],
        result: `The case supports the declared outcome because ${seed.correction}`,
      },
      {
        id: `${skill.id}.example-b`,
        title: `${skill.title}: boundary case`,
        situation: seed.scenarioB,
        walkthrough: [
          `Identify the changed context: ${seed.scenarioB}`,
          `Keep this boundary explicit: ${seed.boundary}`,
          `Reject the documented misconception: ${seed.misconception}`,
        ],
        result: `The boundary case remains consistent with the canonical model: ${seed.model}`,
      },
    ],
    misconceptions: [
      {
        id: misconceptionId,
        mistakenBelief: seed.misconception,
        correction: seed.correction,
        diagnosticPrompt: `Using the direct and boundary scenarios, explain why this belief fails: ${seed.misconception}`,
      },
    ],
    analogy: {
      optional: true,
      example: analogy.example(skill.title),
      usefulFor: [analogy.usefulFor],
      limitations: [analogy.limitation, seed.boundary],
      canonicalExplanationStandsAlone: true,
    },
    trace: {
      artifact: [seed.scenarioA, seed.model, seed.correction],
      steps: [
        {
          step: 1,
          focus: "Observe",
          state: { evidence: seed.scenarioA },
          explanation: "Record the concrete starting evidence without yet assuming which rule or operation explains it.",
        },
        {
          step: 2,
          focus: "Apply model",
          state: { model: seed.model },
          explanation: `Apply the declared ${skill.title} model and preserve its inputs, state, ordering, and environment assumptions.`,
        },
        {
          step: 3,
          focus: "Verify",
          state: { correction: seed.correction },
          explanation: `Compare the observation with the correction and reject the misconception: ${seed.misconception}`,
        },
      ],
      textAlternative: `First observe this case: ${seed.scenarioA} Then apply this model: ${seed.model} Finally verify the conclusion using this correction: ${seed.correction}`,
    },
    practice: {
      faded: {
        prompt: `Complete a claim-evidence-reasoning trace for this direct case: ${seed.scenarioA}`,
        scaffold: ["Name the observable starting evidence.", `Select the part of the ${skill.title} model that applies.`, "State the verified result and one rejected alternative."],
        expectedEvidence: [skill.outcomes[0]!, seed.correction],
      },
      nearTransfer: {
        prompt: `Apply the same skill to this changed but related case: ${seed.scenarioB}`,
        scaffold: ["Identify what changed from the first case.", "Keep the declared boundary visible before deciding."],
        expectedEvidence: [seed.model, seed.boundary],
      },
      farTransfer: {
        prompt: `Create a new neutral-context example of ${skill.title}, predict its result, and explain why the documented misconception would fail there.`,
        scaffold: ["Do not reuse the optional analogy.", "Declare inputs, state, tool or environment assumptions before the prediction."],
        expectedEvidence: [...skill.outcomes, seed.correction],
      },
    },
    remediation: [
      {
        misconceptionId,
        explanation: seed.correction,
        retryPrompt: `Re-evaluate this case after applying the correction, then state the decisive evidence: ${seed.scenarioB}`,
      },
    ],
    recap: {
      summary: `${seed.model} The critical boundary is: ${seed.boundary}`,
      retrievalPrompts: [
        `Explain ${skill.title} without using the optional analogy and include one observable consequence.`,
        `Why is this statement incorrect: ${seed.misconception}`,
        `Apply the model to this case from memory: ${seed.scenarioB}`,
      ],
      nextReviewPrompt: `On the next review, reproduce the model, boundary, and correction for ${skill.title} before reopening the lesson.`,
    },
  };
}

function buildBank(
  course: CourseManifest,
  courseModule: CourseModule,
  skill: AtomicSkill,
  seed: TrancheTeachingSeed,
): AssessmentBank {
  return {
    $schema: "../../schema/assessment-bank.schema.json",
    format: "assessment-bank",
    schemaVersion: "1.0.0",
    id: `bank.${skill.id}.v1`,
    courseId: course.id,
    courseVersion: course.version,
    moduleId: courseModule.id,
    skillId: skill.id,
    title: `${skill.title} deterministic misconception check`,
    publication: publication(`Deterministic misconception item for ${skill.title}; blocked from formal exams until independent human review.`),
    sourceRefs: skill.source_refs,
    items: [
      {
        id: `${skill.id}.mcq.misconception`,
        skillId: skill.id,
        title: `${skill.title}: correct the failure model`,
        kind: "mcq",
        prompt: `Which statement correctly resolves this documented beginner mistake? ${seed.misconception}`,
        points: 4,
        evidenceLevel: "interpret",
        examEligibility: {
          eligible: false,
          rationale: "The deterministic answer and rubric are AI-assisted draft content awaiting independent human approval.",
        },
        hints: ["Compare both options with the canonical model, declared boundary, and observable evidence in the lesson."],
        feedback: {
          correct: `Correct. ${seed.correction}`,
          incorrect: `The selected statement preserves the documented misconception. ${seed.correction}`,
        },
        rubric: {
          passPoints: 4,
          criteria: [
            {
              id: "correct-model",
              description: `Selects the source-aligned correction for ${skill.title} instead of the documented misconception.`,
              points: 4,
              critical: true,
            },
          ],
        },
        privateAuthorNotes: [
          "Human reviewer must verify the correction against the cited source and ensure the misconception option is plausible without reinforcing it.",
        ],
        options: [
          { id: "correct-model", text: seed.correction },
          { id: "documented-misconception", text: seed.misconception },
        ],
        answer: {
          correctOptionIds: ["correct-model"],
          explanation: seed.correction,
        },
      },
    ],
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const courses = await Promise.all([
    loadCourse("programming-foundations.json"),
    loadCourse("git-tooling.json"),
  ]);
  const targets = courses.flatMap((course) => course.modules.flatMap((courseModule) =>
    courseModule.skills
      .filter((skill) => !existingPilotSkills.has(skill.id))
      .map((skill) => ({ course, courseModule, skill })),
  ));
  const expectedIds = targets.map(({ skill }) => skill.id).sort();
  const seedIds = Object.keys(FOUNDATIONS_GIT_TRANCHE_SEEDS).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(seedIds)) {
    const expected = new Set(expectedIds);
    const supplied = new Set(seedIds);
    const missing = expectedIds.filter((id) => !supplied.has(id));
    const extra = seedIds.filter((id) => !expected.has(id));
    throw new Error(`Teaching seed mismatch. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`);
  }
  if (!process.argv.includes("--apply")) {
    console.log(`Validated ${targets.length} topic-specific teaching seeds. Re-run with --apply to create draft content.`);
    return;
  }
  await Promise.all([mkdir(lessonRoot, { recursive: true }), mkdir(bankRoot, { recursive: true })]);
  let createdLessons = 0;
  let createdBanks = 0;
  for (const { course, courseModule, skill } of targets) {
    const seed = FOUNDATIONS_GIT_TRANCHE_SEEDS[skill.id as keyof typeof FOUNDATIONS_GIT_TRANCHE_SEEDS];
    const lessonPath = path.join(lessonRoot, `${skill.id}.json`);
    const bankPath = path.join(bankRoot, `${skill.id}.json`);
    if (await fileExists(lessonPath) || await fileExists(bankPath)) {
      throw new Error(`Refusing to overwrite existing authored content for ${skill.id}.`);
    }
    const lesson = applyBeginnerQualityTemplate(
      buildLesson(course, courseModule, skill, seed),
      createBeginnerQualityContext(course, courseModule, skill),
    );
    await writeFile(lessonPath, `${JSON.stringify(lesson, null, 2)}\n`, "utf8");
    createdLessons += 1;
    await writeFile(bankPath, `${JSON.stringify(buildBank(course, courseModule, skill, seed), null, 2)}\n`, "utf8");
    createdBanks += 1;
  }
  console.log(`Created ${createdLessons} draft lessons and ${createdBanks} deterministic draft assessment banks.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
