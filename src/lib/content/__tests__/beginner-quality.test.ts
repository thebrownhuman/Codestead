import { describe, expect, it } from "vitest";

import type { AuthoredLesson } from "../authored-types";
import {
  applyBeginnerQualityTemplate,
  auditBeginnerLessonQuality,
  createBeginnerQualityContext,
  type BeginnerQualityContext,
} from "../beginner-quality";
import type { AtomicSkill, CourseManifest, CourseModule } from "../types";

const context: BeginnerQualityContext = {
  prerequisiteLabels: ["Variables and values", "Variables and values"],
  assumedKnowledge: ["Read a short Python expression"],
  nextSkillTitle: "Boolean expressions",
  runtimeKind: "programming-language",
};

function lesson(): AuthoredLesson {
  return {
    $schema: "../../schema/authored-lesson.schema.json",
    format: "authored-lesson",
    schemaVersion: "1.0.0",
    id: "lesson.python.example.v1",
    courseId: "python",
    courseVersion: "0.1.0",
    moduleId: "python.values",
    skillId: "python.values.example",
    title: "Choose a scalar value",
    publication: {
      stage: "draft",
      author: { id: "assistant", displayName: "Assistant", kind: "ai-assisted" },
      authoredAt: "2026-07-12T00:00:00.000Z",
      aiAssisted: true,
      reviewer: null,
      changeSummary: "Source-linked draft; human review required.",
    },
    sources: [{ sourceRef: "python-docs", locator: "Values", claim: "Names bind to objects with distinct value semantics." }],
    canonicalExplanation: {
      summary: "Python names bind to objects, and each scalar type has value, equality, and truth rules that code must apply deliberately.",
      sections: [{ heading: "Operational model", body: "Python names bind to objects, and each scalar type has value, equality, and truth rules that code must apply deliberately." }],
    },
    scope: { includes: ["Choose a scalar"], excludes: ["Floating-point values do not represent every decimal exactly."] },
    outcomes: ["Choose a scalar whose behavior matches the input contract."],
    examples: [{
      id: "example",
      title: "Missing value",
      situation: "The code checks optional_name is None before formatting a greeting.",
      walkthrough: [
        "Observe optional_name is None.",
        "Python names bind to objects, and each scalar type has value, equality, and truth rules that code must apply deliberately.",
        "Use is None for an absence marker.",
      ],
      result: "The code chooses the fallback greeting because the optional name is absent.",
    }],
    misconceptions: [{ id: "mistake", mistakenBelief: "Every false value means the same thing as None.", correction: "Use is None only when the contract uses None as its absence marker.", diagnosticPrompt: "Explain the empty-string case." }],
    analogy: { optional: true, example: "A labeled shelf", usefulFor: ["values"], limitations: ["Objects are not shelves"], canonicalExplanationStandsAlone: true },
    trace: {
      artifact: ["optional_name = None", "optional_name is None"],
      steps: [
        { step: 1, focus: "Input", state: { value: "None" }, explanation: "Record the optional input before evaluating it." },
        { step: 2, focus: "Check", state: { expression: "is None" }, explanation: "Apply the explicit absence check to the input." },
        { step: 3, focus: "Result", state: { branch: "fallback" }, explanation: "Select the fallback branch and state why it ran." },
      ],
      textAlternative: "Read the input, evaluate is None, and select the fallback branch when the comparison is true.",
    },
    practice: {
      faded: { prompt: "Explain what this optional-value check does and why it uses is None rather than a general truth test.", scaffold: ["Name the value.", "Apply the comparison."], expectedEvidence: ["None is the absence marker."] },
      nearTransfer: { prompt: "Check an empty string.", scaffold: ["Name the contract."], expectedEvidence: ["Empty is not automatically absent."] },
      farTransfer: { prompt: "Design another optional input.", scaffold: ["Declare the marker."], expectedEvidence: ["Explicit contract."] },
    },
    remediation: [{ misconceptionId: "mistake", explanation: "None is a specific marker.", retryPrompt: "Retry with an empty string." }],
    recap: { summary: "Use scalar semantics deliberately and distinguish None from other false values.", retrievalPrompts: ["When should you use is None?", "Why is an empty string different?"], nextReviewPrompt: "Review the rule tomorrow." },
  };
}

function skill(id: string, title: string, prerequisites: readonly string[] = []): AtomicSkill {
  return {
    id, title, description: title, outcomes: [], prerequisites,
    evidence_types: [], status: "required", coverage_status: "planned", source_refs: [],
  };
}

function courseModule(id: string, title: string, skills: readonly AtomicSkill[], prerequisites: readonly string[] = []): CourseModule {
  return { id, title, description: title, required: true, prerequisites, skills };
}

function manifest(modules: readonly CourseModule[]): CourseManifest {
  return {
    $schema: "../../schema/course.schema.json",
    id: "python",
    title: "Python",
    version: "0.1.0",
    status: "beta",
    release: "beta",
    summary: "Python course",
    audience: { level: "beginner", assumed_knowledge: ["Read a short Python expression"], target_capability: "write scripts" },
    scope: { includes: ["Python basics"], non_goals: ["Advanced metaprogramming"] },
    authoritative_sources: [],
    runtime: {
      kind: "programming-language", language: "python", standard: "3.14", toolchain: [],
      execution_environment: "sandbox", file_extensions: [".py"], notes: [],
    },
    modules,
    exit_outcomes: [],
    coverage_summary: {
      required_skills: 0, elective_skills: 0, total_skills: 0, covered: 0, partial: 0, planned: 0,
    },
  };
}

describe("createBeginnerQualityContext", () => {
  it("resolves in-course prerequisite ids to their learner-facing titles and finds the next skill", () => {
    const values = skill("python.values", "Values", []);
    const booleans = skill("python.booleans", "Boolean expressions", ["python.values"]);
    const valuesModule = courseModule("python.values-module", "Values module", [values]);
    const booleansModule = courseModule("python.booleans-module", "Booleans module", [booleans], ["python.values-module"]);
    const course = manifest([valuesModule, booleansModule]);

    const context = createBeginnerQualityContext(course, booleansModule, booleans);

    expect(context.prerequisiteLabels).toEqual(["Values module", "Values"]);
    expect(context.assumedKnowledge).toEqual(["Read a short Python expression"]);
    expect(context.nextSkillTitle).toBeNull();
    expect(context.runtimeKind).toBe("programming-language");
  });

  it("falls back to a humanized id and resolves cross-course prerequisites by title", () => {
    const foundationSkill = skill("foundations.loops", "Loops");
    const foundationModule = courseModule("foundations.control-flow", "Control flow", [foundationSkill]);
    const foundationsCourse = manifest([foundationModule]);

    const cppSkill = skill("cpp.loops", "C++ loops", ["foundations.loops", "unknown_prereq.missing"]);
    const cppModule = courseModule("cpp.control-flow", "Control flow", [cppSkill]);
    const cppCourse = manifest([cppModule]);

    const context = createBeginnerQualityContext(cppCourse, cppModule, cppSkill, [foundationsCourse]);

    expect(context.prerequisiteLabels).toEqual(["Loops", "unknown prereq missing"]);
    expect(context.nextSkillTitle).toBeNull();
  });

  it("finds the next skill's title when one follows in course order", () => {
    const first = skill("python.a", "First skill");
    const second = skill("python.b", "Second skill");
    const singleModule = courseModule("python.module", "Module", [first, second]);
    const course = manifest([singleModule]);

    const context = createBeginnerQualityContext(course, singleModule, first);

    expect(context.nextSkillTitle).toBe("Second skill");
  });
});

describe("beginner lesson quality contract", () => {
  it("reports missing beginner orientation, prerequisite recap, next step, and repeated rules", () => {
    const issues = auditBeginnerLessonQuality(lesson(), context);
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "opening-missing",
      "prerequisite-recap-missing",
      "practice-example-mismatch",
      "trace-text-alternative-mismatch",
      "next-step-missing",
    ]));
  });

  it("rejects a generic explanation that does not provide a lesson-specific mental model", () => {
    const original = lesson();
    const candidate: AuthoredLesson = {
      ...original,
      canonicalExplanation: {
        ...original.canonicalExplanation,
        sections: [{
          heading: "Extra details",
          body: "Read the material carefully and remember the important details for later.",
        }],
      },
    };

    expect(auditBeginnerLessonQuality(candidate, context).map((issue) => issue.code)).toContain(
      "mental-model-missing",
    );
  });

  it("applies an idempotent beginner structure without changing provenance or source boundaries", () => {
    const original = lesson();
    const refreshed = applyBeginnerQualityTemplate(original, context);
    const repeated = applyBeginnerQualityTemplate(refreshed, context);

    expect(auditBeginnerLessonQuality(refreshed, context)).toEqual([]);
    expect(repeated).toEqual(refreshed);
    expect(refreshed.publication).toMatchObject({ stage: "draft", aiAssisted: true, reviewer: null });
    expect(refreshed.sources).toEqual(original.sources);
    expect(refreshed.scope.excludes).toEqual(original.scope.excludes);
    expect(refreshed.canonicalExplanation.sections.map((section) => section.heading).slice(0, 2)).toEqual([
      "Start here",
      "Before you begin",
    ]);
    expect(refreshed.recap.nextReviewPrompt).toContain("Boolean expressions");
    expect(refreshed.canonicalExplanation.sections[1]?.body.match(/Variables and values/g)).toHaveLength(1);
  });

  it("rejects a practice answer and text alternative that describe different scenarios", () => {
    const refreshed = applyBeginnerQualityTemplate(lesson(), context);
    const mismatched: AuthoredLesson = {
      ...refreshed,
      trace: {
        ...refreshed.trace,
        textAlternative: "Read the diagram and follow the general process from beginning to end.",
      },
      practice: {
        ...refreshed.practice,
        faded: {
          ...refreshed.practice.faded,
          expectedEvidence: ["Unrelated prices are forty, forty-five, and thirty-five."],
        },
      },
    };

    expect(auditBeginnerLessonQuality(mismatched, context).map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "practice-example-mismatch",
        "trace-text-alternative-mismatch",
      ]),
    );
  });
});
