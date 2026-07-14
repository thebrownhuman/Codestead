import { createHash } from "node:crypto";

import type {
  ContentSnapshot,
  CourseManifest,
  CourseModule,
  CourseStatus,
} from "@/lib/content/types";

export const MODULE_PROJECT_TEMPLATE_VERSION = "module-project-2026-07-14.v1";

export type ModuleProjectPublicationStatus = Extract<
  CourseStatus,
  "beta" | "verified" | "retired"
>;

export interface ModuleProjectMilestone {
  readonly title: string;
  readonly purpose: string;
  readonly evidence: string;
}

export interface ModuleProjectAcceptanceCheck {
  readonly id: "normal" | "boundary" | "failure";
  readonly given: string;
  readonly when: string;
  readonly then: string;
}

export interface ModuleProjectBrief {
  readonly schemaVersion: 1;
  readonly templateVersion: typeof MODULE_PROJECT_TEMPLATE_VERSION;
  readonly templateKey: string;
  readonly contentHash: string;
  readonly courseId: string;
  readonly courseVersion: string;
  readonly courseTitle: string;
  readonly moduleId: string;
  readonly moduleTitle: string;
  readonly publicationStatus: ModuleProjectPublicationStatus;
  readonly title: string;
  readonly laymanScenario: string;
  readonly problem: string;
  readonly artifact: string;
  readonly learnerRole: string;
  readonly prerequisiteSkillIds: readonly string[];
  readonly demonstratedOutcomes: readonly string[];
  readonly milestones: readonly ModuleProjectMilestone[];
  readonly acceptanceChecks: readonly ModuleProjectAcceptanceCheck[];
  readonly reflectionPrompts: readonly string[];
  readonly stretchGoals: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly solution: null;
  readonly directAwardPolicy: "none";
  readonly awardNotice: string;
  readonly editorialNotice: string;
}

type Scenario = {
  readonly setting: string;
  readonly person: string;
  readonly need: string;
  readonly friction: string;
};

const SCENARIOS: readonly Scenario[] = [
  {
    setting: "a university coding club",
    person: "the student coordinator",
    need: "keep one recurring activity understandable for new volunteers",
    friction: "the current process lives in scattered messages and is easy to misread",
  },
  {
    setting: "a shared student kitchen",
    person: "the weekly meal planner",
    need: "turn a small repeated kitchen decision into a reliable routine",
    friction: "people currently rely on memory and disagree at the edge cases",
  },
  {
    setting: "a neighbourhood library",
    person: "the volunteer at the help desk",
    need: "organize a small set of requests without losing unusual cases",
    friction: "the paper list works for common cases but breaks when information is missing",
  },
  {
    setting: "a college sports group",
    person: "the practice captain",
    need: "make a simple training workflow predictable for every participant",
    friction: "the group cannot explain why two seemingly similar cases get different results",
  },
  {
    setting: "a small bicycle repair desk",
    person: "the repair coordinator",
    need: "track one repair decision from request to result",
    friction: "important conditions are checked informally and failures are discovered too late",
  },
  {
    setting: "a campus event team",
    person: "the event organiser",
    need: "give volunteers one clear way to handle a repeated task",
    friction: "normal cases are manageable, but empty, late, or invalid requests cause confusion",
  },
  {
    setting: "a study group",
    person: "the peer tutor",
    need: "show a difficult idea through a small observable workflow",
    friction: "learners can repeat the vocabulary but cannot yet predict what happens next",
  },
  {
    setting: "a community garden",
    person: "the plot coordinator",
    need: "make a small allocation or tracking decision transparent",
    friction: "the current notes hide assumptions and do not describe failure cases",
  },
];

const ARTIFACT_BY_COURSE: Readonly<Record<string, string>> = {
  "programming-foundations": "a language-neutral decision, trace, and test packet",
  c: "a small C command-line program with focused tests",
  cpp: "a small modern C++ command-line program with focused tests",
  java: "a small Java application with focused tests",
  python: "a small Python command-line tool with focused tests",
  html: "a semantic, keyboard-friendly web document",
  css: "a responsive, accessible interface specimen",
  javascript: "a small browser interaction with observable state",
  react: "a small component-driven interface",
  dsa: "a tested problem-solving tool in the learner's selected language",
  "git-tooling": "a versioned repository workflow with a reproducible evidence trail",
  ai: "a small auditable AI experiment or decision notebook",
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareText);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function verifyModuleProjectBriefHash(brief: ModuleProjectBrief): boolean {
  const { contentHash: actualHash, ...unsigned } = brief;
  return actualHash === contentHash(unsigned);
}

function scenarioIndex(identity: string): number {
  const prefix = createHash("sha256").update(identity).digest().readUInt32BE(0);
  return prefix % SCENARIOS.length;
}

function projectArtifact(course: CourseManifest) {
  return ARTIFACT_BY_COURSE[course.id]
    ?? `a small ${course.runtime.language || "learning"} artifact with repeatable checks`;
}

function courseSpecificCheck(course: CourseManifest) {
  if (["html", "css", "javascript", "react"].includes(course.id)) {
    return "The core path works with keyboard navigation, meaningful labels, and a narrow viewport.";
  }
  if (course.id === "git-tooling") {
    return "A second learner can reproduce the intended workflow from the repository evidence alone.";
  }
  if (course.id === "ai") {
    return "The result separates observed evidence from assumptions and states what the experiment cannot prove.";
  }
  if (course.id === "programming-foundations") {
    return "The trace shows each state change and another learner can reproduce the expected result by hand.";
  }
  return "The normal path produces the expected observable result and a repeatable check confirms it.";
}

function unsignedBrief(course: CourseManifest, module: CourseModule) {
  if (course.status === "coming-soon") {
    throw new RangeError(`Course '${course.id}' cannot expose a module project before learner content exists.`);
  }
  const scenario = SCENARIOS[scenarioIndex(`${course.id}:${course.version}:${module.id}`)]!;
  const requiredSkills = module.skills
    .filter((skill) => skill.status === "required")
    .map((skill) => skill.id);
  const demonstratedOutcomes = module.skills.flatMap((skill) => skill.outcomes).slice(0, 8);
  const sourceRefs = [...new Set(module.skills.flatMap((skill) => skill.source_refs))].sort(compareText);
  const artifact = projectArtifact(course);
  const capabilityNames = module.skills.slice(0, 3).map((skill) => skill.title);
  const capabilityText = capabilityNames.length > 1
    ? `${capabilityNames.slice(0, -1).join(", ")}, and ${capabilityNames.at(-1)}`
    : capabilityNames[0] ?? module.title;
  const publicationStatus = course.status as ModuleProjectPublicationStatus;

  return {
    schemaVersion: 1 as const,
    templateVersion: MODULE_PROJECT_TEMPLATE_VERSION as typeof MODULE_PROJECT_TEMPLATE_VERSION,
    templateKey: `${course.id}:${course.version}:${module.id}:${MODULE_PROJECT_TEMPLATE_VERSION}`,
    courseId: course.id,
    courseVersion: course.version,
    courseTitle: course.title,
    moduleId: module.id,
    moduleTitle: module.title,
    publicationStatus,
    title: `${module.title}: a mini-project for ${scenario.setting}`,
    laymanScenario: `Imagine ${scenario.setting}. ${scenario.person} needs to ${scenario.need}, but ${scenario.friction}.`,
    problem: `Design ${artifact} that solves one narrow part of that situation while demonstrating ${capabilityText}. Keep the first version small enough to explain line by line. You decide the representation and implementation; this brief deliberately provides no finished code.`,
    artifact,
    learnerRole: `You are the junior developer. Clarify the input, observable result, constraints, and failure behaviour before you build anything.`,
    prerequisiteSkillIds: requiredSkills,
    demonstratedOutcomes,
    milestones: [
      {
        title: "Explain the problem in plain language",
        purpose: "Make the user, input, result, and important constraints unambiguous before coding.",
        evidence: "A short problem statement plus one normal, one boundary, and one invalid example.",
      },
      {
        title: "Sketch the smallest complete path",
        purpose: "Choose the data and steps needed for one end-to-end result without extra features.",
        evidence: "A trace, pseudocode, component sketch, or repository plan appropriate to the course.",
      },
      {
        title: "Build one observable workflow",
        purpose: `Use the module's ${capabilityText} skills in a result you can demonstrate and explain.`,
        evidence: `A learner-authored ${artifact}; no generated finished solution is supplied by Codestead.`,
      },
      {
        title: "Test normal, boundary, and failure behaviour",
        purpose: "Look for incorrect assumptions instead of proving only the happy path.",
        evidence: "Repeatable checks with expected and actual results for all three acceptance cases.",
      },
      {
        title: "Refactor, document, and reflect",
        purpose: "Make the work understandable to your future self and identify the next improvement.",
        evidence: "A concise README or explanation, a clean immutable commit, and answers to the reflection prompts.",
      },
    ],
    acceptanceChecks: [
      {
        id: "normal" as const,
        given: "A small, representative input with every required value present",
        when: "the learner completes the primary workflow",
        then: courseSpecificCheck(course),
      },
      {
        id: "boundary" as const,
        given: "The smallest meaningful case, an empty case, or a value exactly on a stated limit",
        when: "the same workflow is attempted",
        then: "The behaviour matches a written expectation and does not depend on an accidental off-by-one or hidden default.",
      },
      {
        id: "failure" as const,
        given: "Missing, malformed, contradictory, or unavailable input",
        when: "the workflow cannot complete normally",
        then: "The artifact fails safely, gives a useful explanation, and does not pretend that the operation succeeded.",
      },
    ],
    reflectionPrompts: [
      "Which decision was hardest to make, and what evidence changed your mind?",
      "What assumption did a boundary or failure check expose?",
      `Where can you point to ${module.title} in the finished behaviour, not just in the vocabulary?`,
      "If another beginner inherited this project tomorrow, what would they need explained first?",
    ],
    stretchGoals: [
      "Add one useful variation only after the original acceptance checks still pass.",
      "Compare one alternative design and explain the trade-off without replacing the working version.",
    ],
    sourceRefs,
    solution: null,
    directAwardPolicy: "none" as const,
    awardNotice: publicationStatus === "verified"
      ? "Finishing this brief does not directly award XP, mastery, a certificate, or a trophy. Those require their own authoritative evidence gates."
      : "This is a draft/beta learning brief. It cannot award XP, mastery, a certificate, or a trophy.",
    editorialNotice: publicationStatus === "verified"
      ? "This template belongs to the exact verified course version named above."
      : `Draft preview: this ${publicationStatus} template still requires human editorial verification.`,
  };
}

export function buildModuleProjectBrief(
  course: CourseManifest,
  module: CourseModule,
): ModuleProjectBrief {
  const unsigned = unsignedBrief(course, module);
  return Object.freeze({ ...unsigned, contentHash: contentHash(unsigned) });
}

export function buildModuleProjectCatalog(snapshot: ContentSnapshot): readonly ModuleProjectBrief[] {
  return Object.freeze(snapshot.courses.flatMap((course) =>
    course.modules
      .filter((module) => module.required)
      .map((module) => buildModuleProjectBrief(course, module))),
  );
}

export function validateModuleProjectCatalog(
  snapshot: ContentSnapshot,
  catalog = buildModuleProjectCatalog(snapshot),
): { readonly courseCount: number; readonly moduleCount: number; readonly templateCount: number } {
  const expected = snapshot.courses.flatMap((course) =>
    course.modules.filter((module) => module.required).map((module) => `${course.id}:${course.version}:${module.id}`),
  );
  const expectedSet = new Set(expected);
  const identities = new Set<string>();
  const templateKeys = new Set<string>();
  const hashes = new Set<string>();

  for (const brief of catalog) {
    const identity = `${brief.courseId}:${brief.courseVersion}:${brief.moduleId}`;
    if (!expectedSet.has(identity)) throw new Error(`Unexpected module project '${identity}'.`);
    if (identities.has(identity)) throw new Error(`Duplicate module project '${identity}'.`);
    if (templateKeys.has(brief.templateKey)) throw new Error(`Duplicate module project key '${brief.templateKey}'.`);
    if (hashes.has(brief.contentHash)) throw new Error(`Duplicate module project content hash '${brief.contentHash}'.`);
    identities.add(identity);
    templateKeys.add(brief.templateKey);
    hashes.add(brief.contentHash);

    const course = snapshot.courses.find((item) => item.id === brief.courseId && item.version === brief.courseVersion);
    const courseModule = course?.modules.find((item) => item.id === brief.moduleId);
    if (!course || !courseModule) throw new Error(`Module project '${identity}' is not bound to canonical content.`);
    const expectedSkills = courseModule.skills.filter((skill) => skill.status === "required").map((skill) => skill.id);
    if (stableJson(brief.prerequisiteSkillIds) !== stableJson(expectedSkills)) {
      throw new Error(`Module project '${identity}' has stale prerequisite skills.`);
    }
    if (brief.solution !== null || brief.directAwardPolicy !== "none") {
      throw new Error(`Module project '${identity}' must not include a solution or direct reward.`);
    }
    if (brief.publicationStatus !== course.status) {
      throw new Error(`Module project '${identity}' has stale publication status.`);
    }
    if (brief.milestones.length < 4 || brief.acceptanceChecks.length !== 3
      || brief.reflectionPrompts.length < 3 || brief.stretchGoals.length < 1) {
      throw new Error(`Module project '${identity}' is not a complete learning brief.`);
    }
    if (brief.acceptanceChecks.map((check) => check.id).join(",") !== "normal,boundary,failure") {
      throw new Error(`Module project '${identity}' must cover normal, boundary, and failure behaviour.`);
    }
    if (!verifyModuleProjectBriefHash(brief)) {
      throw new Error(`Module project '${identity}' content hash is invalid.`);
    }
  }

  const missing = expected.filter((identity) => !identities.has(identity));
  if (missing.length) throw new Error(`Missing module projects: ${missing.join(", ")}`);
  return {
    courseCount: snapshot.courses.length,
    moduleCount: expected.length,
    templateCount: catalog.length,
  };
}
