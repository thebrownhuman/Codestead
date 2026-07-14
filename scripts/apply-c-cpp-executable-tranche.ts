import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AssessmentBank,
  CodeAssessmentItem,
  CourseManifest,
} from "../src/lib/content";
import {
  C_CPP_NEW_EXECUTABLE_SPECS,
  C_CPP_NON_CODE_FACETS,
  type CCppExecutableSpec,
  type CCppLanguage,
} from "./content-seeds/c-cpp-executable-tranche";

interface RuntimeRecord {
  readonly language: string;
  readonly reference: string;
  readonly digest: string;
}

interface RuntimeImages {
  readonly records: readonly RuntimeRecord[];
}

const root = process.cwd();
const contentRoot = path.join(root, "content");
const bankRoot = path.join(contentRoot, "authored", "assessment-banks");
const runtimeImagesPath = path.join(root, "services", "runner", "dist", "runtime-images.json");

async function loadJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function stable(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function languageFor(courseId: string): CCppLanguage {
  if (courseId === "c" || courseId === "cpp") return courseId;
  throw new Error("Unexpected C/C++ course id: " + courseId);
}

function runtimeVersion(language: CCppLanguage): string {
  return language === "c" ? "C23 / GCC 14.2.0" : "C++20 / G++ 14.2.0";
}

function existingSpec(item: CodeAssessmentItem): CCppExecutableSpec {
  return {
    facet: "existing bounded executable application retained from the authored language tranche",
    prompt: item.prompt,
    starterCode: item.starterCode,
    referenceSolution: item.answer.referenceSolution,
    tests: item.tests.map((test) => ({
      id: test.id,
      visibility: test.visibility,
      category: test.category === "performance" ? "normal" : test.category,
      stdin: test.stdin,
      expectedStdout: test.expectedStdout,
    })),
  };
}

function buildCodeItem(args: {
  readonly skillId: string;
  readonly skillTitle: string;
  readonly language: CCppLanguage;
  readonly digest: string;
  readonly spec: CCppExecutableSpec;
  readonly existing?: CodeAssessmentItem;
}): CodeAssessmentItem {
  const { skillId, skillTitle, language, digest, spec, existing } = args;
  const tests = spec.tests.map((test) => ({
    ...test,
    comparison: "exact" as const,
    critical: true,
  }));
  if (!tests.some((test) => test.visibility === "visible")) {
    throw new Error(skillId + " lacks a visible executable case.");
  }
  if (!tests.some((test) => test.visibility === "hidden" && test.category === "boundary")) {
    throw new Error(skillId + " lacks a hidden boundary executable case.");
  }
  return {
    id: existing?.id ?? skillId + ".code.apply",
    skillId,
    title: existing?.title ?? skillTitle + ": executable application",
    kind: "code",
    prompt: spec.prompt,
    points: existing?.points ?? 10,
    evidenceLevel: "apply",
    examEligibility: {
      eligible: false,
      rationale: "AI-assisted deterministic draft awaiting independent human standards, security, and assessment review.",
    },
    hints: existing?.hints ?? [
      "Begin with the declared input and exact output contract, then implement the named language facet without relying on undefined behavior.",
    ],
    feedback: existing?.feedback ?? {
      correct: "The reference-aligned visible and hidden deterministic checks passed in the pinned isolated runtime.",
      incorrect: "At least one deterministic check failed; inspect input validation, boundary behavior, and the named language rule without exposing hidden cases.",
    },
    rubric: existing?.rubric ?? {
      passPoints: 10,
      criteria: [
        {
          id: "deterministic-behavior",
          description: "Compiles in the pinned runtime and passes every visible and hidden exact-output case.",
          points: 7,
          critical: true,
        },
        {
          id: "language-facet",
          description: "Uses the target C or C++ language facet with declared bounds and without an out-of-scope workaround.",
          points: 3,
          critical: true,
        },
      ],
    },
    privateAuthorNotes: [
      "AI-assisted and human-unreviewed: formal exam eligibility is prohibited until independent technical and assessment approval.",
      "Reference verification uses the digest-pinned local container with network=none, no package installation, a read-only source mount, and deterministic stdin/stdout.",
      "Executable facet: " + spec.facet,
    ],
    starterCode: spec.starterCode,
    runtime: {
      engine: "isolated-runner",
      language,
      version: runtimeVersion(language),
      imageDigest: digest,
      entrypoint: language === "c" ? "main.c" : "main.cpp",
      timeLimitMs: 2_000,
      memoryLimitMb: 128,
    },
    tests,
    answer: {
      referenceSolution: spec.referenceSolution,
      explanation: "The reference solution exercises " + spec.facet + " under the bounded deterministic contract; it remains an AI-assisted draft pending human review.",
    },
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const [cCourse, cppCourse, runtimeImages] = await Promise.all([
    loadJson<CourseManifest>(path.join(contentRoot, "courses", "c.json")),
    loadJson<CourseManifest>(path.join(contentRoot, "courses", "cpp.json")),
    loadJson<RuntimeImages>(runtimeImagesPath),
  ]);
  const courses = [cCourse, cppCourse];
  const targets = courses.flatMap((course) =>
    course.modules.flatMap((courseModule) =>
      courseModule.skills.map((skill) => ({ course, courseModule, skill })),
    ),
  );
  const declared = new Set(targets.map(({ skill }) => skill.id));
  const configured = new Set([
    ...Object.keys(C_CPP_NEW_EXECUTABLE_SPECS),
    ...Object.keys(C_CPP_NON_CODE_FACETS),
  ]);
  const unknown = [...configured].filter((skillId) => !declared.has(skillId));
  if (unknown.length) throw new Error("Executable classification targets unknown skills: " + unknown.join(", "));

  const digestByLanguage = new Map(
    runtimeImages.records.map((record) => [record.language, record.digest]),
  );
  let executableSkills = 0;
  let nonCodeSkills = 0;
  let newItems = 0;
  let retainedItems = 0;
  let caseCount = 0;
  const stale: string[] = [];

  for (const { course, skill } of targets) {
    const bankPath = path.join(bankRoot, skill.id + ".json");
    const bank = await loadJson<AssessmentBank>(bankPath);
    const codeItems = bank.items.filter((item): item is CodeAssessmentItem => item.kind === "code");
    if (codeItems.length > 1) throw new Error(skill.id + " has more than one existing code item.");
    const existing = codeItems[0];
    const newSpec = C_CPP_NEW_EXECUTABLE_SPECS[skill.id];
    const nonCodeReason = C_CPP_NON_CODE_FACETS[skill.id];
    if (nonCodeReason) {
      if (existing || newSpec) throw new Error(skill.id + " is classified as both executable and non-code.");
      if (nonCodeReason.length < 80) throw new Error(skill.id + " has an insufficient non-code rationale.");
      nonCodeSkills += 1;
      continue;
    }
    if (!existing && !newSpec) throw new Error(skill.id + " has no executable task or justified non-code facet.");
    const language = languageFor(course.id);
    const imageDigest = digestByLanguage.get(language);
    if (!imageDigest) throw new Error("Missing pinned runtime digest for " + language);
    const spec = newSpec ?? existingSpec(existing!);
    const codeItem = buildCodeItem({
      skillId: skill.id,
      skillTitle: skill.title,
      language,
      digest: imageDigest,
      spec,
      existing,
    });
    const originalNonCodeItems = bank.items.filter((item) => item.kind !== "code");
    const updated: AssessmentBank = {
      ...bank,
      publication: {
        ...bank.publication,
        stage: "draft",
        aiAssisted: true,
        reviewer: null,
        changeSummary: "Added digest-pinned deterministic executable evidence for " + skill.title + "; AI-assisted draft remains human-unreviewed and exam-ineligible.",
      },
      items: [...originalNonCodeItems, codeItem],
    };
    if (JSON.stringify(originalNonCodeItems) !== JSON.stringify(bank.items.filter((item) => item.kind !== "code"))) {
      throw new Error("Non-code assessment items changed unexpectedly for " + skill.id);
    }
    executableSkills += 1;
    caseCount += codeItem.tests.length;
    if (existing) retainedItems += 1;
    else newItems += 1;
    const expected = stable(updated);
    const current = stable(bank);
    if (expected !== current) {
      if (apply) await writeFile(bankPath, expected, "utf8");
      else stale.push(skill.id);
    }
  }

  if (executableSkills + nonCodeSkills !== targets.length) {
    throw new Error("Classification count does not cover all declared C/C++ skills.");
  }
  if (stale.length) {
    throw new Error("C/C++ executable banks are stale; run with --apply. Skills: " + stale.join(", "));
  }
  console.log(
    "C/C++ executable tranche " + (apply ? "applied" : "verified") + ": " +
      targets.length + " skills, " + executableSkills + " executable, " + nonCodeSkills +
      " justified non-code, " + newItems + " new code items, " + retainedItems +
      " retained code items, " + caseCount + " deterministic cases.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
