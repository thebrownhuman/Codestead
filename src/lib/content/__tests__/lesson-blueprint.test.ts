import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { validateContentSet } from "../integrity";
import {
  compileAuthoredFallbackLessonBlueprint,
  DSA_IMPLEMENTATION_LANGUAGES,
} from "../lesson-blueprint";
import { FileSystemContentLoader } from "../loader";
import {
  REQUIRED_LESSON_BLUEPRINT_BLOCK_KINDS,
  type ContentIndex,
  type ContentSnapshot,
} from "../types";

let snapshot: ContentSnapshot;
let index: ContentIndex;

beforeAll(async () => {
  snapshot = await new FileSystemContentLoader({
    contentRoot: path.resolve(process.cwd(), "content"),
  }).loadSnapshot();
  index = validateContentSet(snapshot.catalog, snapshot.courses);
});

describe("deterministic authored-fallback lesson blueprint compiler", () => {
  it("emits a complete, source-linked, explicitly unverified blueprint for all 476 skills", () => {
    const skillIds = [...index.skillById.keys()];
    expect(skillIds).toHaveLength(476);

    for (const skillId of skillIds) {
      const location = index.skillLocationById.get(skillId)!;
      const blueprint = compileAuthoredFallbackLessonBlueprint(index, skillId);
      const kinds = blueprint.blocks.map((block) => block.kind);

      expect(blueprint.skillId).toBe(skillId);
      expect(blueprint.courseId).toBe(location.course.id);
      expect(blueprint.moduleId).toBe(location.module.id);
      expect(kinds).toEqual(REQUIRED_LESSON_BLUEPRINT_BLOCK_KINDS);
      expect(new Set(kinds).size).toBe(REQUIRED_LESSON_BLUEPRINT_BLOCK_KINDS.length);
      expect(new Set(blueprint.blocks.map((block) => block.id)).size).toBe(
        blueprint.blocks.length,
      );
      expect(blueprint.blocks.every((block) => block.authoringStatus === "blueprint-draft"))
        .toBe(true);

      expect(blueprint.provenance).toMatchObject({
        compiler: "deterministic-authored-fallback-v1",
        contentStatus: "blueprint-draft",
        canonicalContent: false,
        editorialReviewRequired: true,
      });
      expect(blueprint.provenance.notice).toMatch(/not editorially verified/i);

      const objective = blueprint.blocks.find((block) => block.kind === "objective");
      expect(objective?.outcomes).toEqual(location.skill.outcomes);

      const mentalModel = blueprint.blocks.find((block) => block.kind === "mental-model");
      expect(mentalModel?.plainLanguageSeed).toContain(location.skill.description);
      expect(mentalModel?.authorPrompt).toMatch(/replace this seed/i);

      const explanation = blueprint.blocks.find(
        (block) => block.kind === "source-linked-explanation-seed",
      );
      expect(explanation?.sources.map((source) => source.id)).toEqual(
        location.skill.source_refs,
      );
      expect(explanation?.quotationAllowed).toBe(false);

      const workedExample = blueprint.blocks.find(
        (block) => block.kind === "worked-example-specification",
      );
      expect(workedExample?.specification.executableContent).toBeNull();
      expect(workedExample?.specification.authoredExampleRequired).toBe(true);
      expect(workedExample?.specification.validationRequirements.length).toBeGreaterThan(0);

      const misconceptions = blueprint.blocks.find(
        (block) => block.kind === "misconception-prompts",
      );
      expect(misconceptions?.prompts.length).toBeGreaterThanOrEqual(3);
      expect(misconceptions?.confirmedMisconceptions).toEqual([]);
      expect(misconceptions?.authorConfirmationRequired).toBe(true);

      const activities = blueprint.blocks.filter((block) => block.kind.startsWith("activity-"));
      expect(activities.map((block) => ("mode" in block ? block.mode : undefined))).toEqual([
        "trace",
        "check",
        "code",
        "transfer",
      ]);
      expect(
        activities.every(
          (block) => "acceptanceSignals" in block && block.acceptanceSignals.length > 0,
        ),
      ).toBe(true);

      const analogy = blueprint.blocks.find((block) => block.kind === "analogy-slot");
      expect(analogy).toMatchObject({
        enabledByDefault: false,
        approvedAnalogyIds: [],
        userConfirmationRequired: true,
        canonicalLessonMustStandAlone: true,
        limitationsRequired: true,
      });

      const recap = blueprint.blocks.find((block) => block.kind === "recap");
      expect(recap?.delayedReviewRequired).toBe(true);
      const accessibility = blueprint.blocks.find(
        (block) => block.kind === "accessibility-text",
      );
      expect(accessibility?.requirements.length).toBeGreaterThan(0);
      expect(accessibility?.textAlternativeSeed).toContain(location.skill.title);
    }
  });

  it("is deterministic for the same authored skill and options", () => {
    const first = compileAuthoredFallbackLessonBlueprint(index, "python.toolchain.repl");
    const second = compileAuthoredFallbackLessonBlueprint(index, "python.toolchain.repl");

    expect(second).toEqual(first);
  });

  it("uses an explicit language-aware DSA worked-example specification", () => {
    for (const selectedLanguage of DSA_IMPLEMENTATION_LANGUAGES) {
      const blueprint = compileAuthoredFallbackLessonBlueprint(
        index,
        "dsa.lists.singly",
        { selectedLanguage },
      );
      const workedExample = blueprint.blocks.find(
        (block) => block.kind === "worked-example-specification",
      );
      expect(workedExample?.specification.runtimeLabel).toContain(selectedLanguage);
      expect(workedExample?.specification.artifactType).toContain(selectedLanguage);
    }

    const cBlueprint = compileAuthoredFallbackLessonBlueprint(index, "dsa.lists.singly", {
      selectedLanguage: "C",
    });
    const pythonBlueprint = compileAuthoredFallbackLessonBlueprint(index, "dsa.lists.singly", {
      selectedLanguage: "Python",
    });
    const cExample = cBlueprint.blocks.find(
      (block) => block.kind === "worked-example-specification",
    );
    const pythonExample = pythonBlueprint.blocks.find(
      (block) => block.kind === "worked-example-specification",
    );
    expect(cExample?.specification.validationRequirements.join(" ")).toMatch(
      /memory\/lifetime diagnostics/i,
    );
    expect(pythonExample?.specification.validationRequirements.join(" ")).not.toMatch(
      /memory\/lifetime diagnostics/i,
    );
  });

  it("provides a specialized authoring profile for every course", () => {
    const artifactTypes = snapshot.courses.map((course) => {
      const skillId = course.modules[0]!.skills[0]!.id;
      const blueprint = compileAuthoredFallbackLessonBlueprint(index, skillId);
      const workedExample = blueprint.blocks.find(
        (block) => block.kind === "worked-example-specification",
      );
      return workedExample?.specification.artifactType;
    });

    expect(artifactTypes).toHaveLength(12);
    expect(new Set(artifactTypes).size).toBe(12);
    expect(artifactTypes.every(Boolean)).toBe(true);
  });

  it("rejects unknown skills and unsupported DSA languages", () => {
    expect(() => compileAuthoredFallbackLessonBlueprint(index, "unknown.skill")).toThrow(
      RangeError,
    );
    expect(() =>
      compileAuthoredFallbackLessonBlueprint(index, "dsa.lists.singly", {
        selectedLanguage: "Ruby" as never,
      }),
    ).toThrow(/unsupported dsa implementation language/i);
  });
});
