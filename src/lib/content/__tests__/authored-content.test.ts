import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AuthoredContentIntegrityError,
  hasHumanReview,
  isExamEligibleItem,
  toLearnerAssessmentBank,
  toLearnerLessonPayload,
  validateAuthoredContentSet,
} from "../authored";
import { parseAssessmentBank, parseAuthoredLesson } from "../authored-schema";
import type { AssessmentBank, AuthoredLesson } from "../authored-types";
import { ContentRepository } from "../repository";

const contentRoot = path.resolve(process.cwd(), "content");

async function pilot() {
  const repository = new ContentRepository({ contentRoot });
  const authored = await repository.getAuthoredContentSet();
  return { repository, authored };
}

describe("versioned authored content", () => {
  it("loads the authored launch-course tranche against declared skills", async () => {
    const { repository, authored } = await pilot();

    const trancheCourses = new Set(["programming-foundations", "git-tooling"]);
    expect(authored.lessons.filter((lesson) => trancheCourses.has(lesson.courseId))).toHaveLength(68);
    expect(authored.assessmentBanks.filter((bank) => trancheCourses.has(bank.courseId))).toHaveLength(68);
    expect(authored.lessons.map((lesson) => lesson.skillId)).toEqual(
      expect.arrayContaining(["pf.computing.program", "pf.state.variables"]),
    );
    expect(authored.assessmentBanks.map((bank) => bank.skillId)).toEqual(
      expect.arrayContaining(["pf.computing.program", "pf.state.variables"]),
    );
    expect(authored.lessons.every((lesson) => lesson.examples.length >= 2)).toBe(true);
    expect(authored.lessons.every((lesson) => lesson.trace.textAlternative.length > 20)).toBe(true);
    expect(await repository.getAuthoredLesson("pf.state.variables")).toBeDefined();
    expect(await repository.listAssessmentBanks({ moduleId: "pf.state" })).toHaveLength(4);
  });

  it("keeps every pilot entry explicitly AI-assisted, draft, and unreviewed", async () => {
    const { authored } = await pilot();
    for (const entry of [...authored.lessons, ...authored.assessmentBanks]) {
      expect(entry.publication).toMatchObject({
        stage: "draft",
        aiAssisted: true,
        reviewer: null,
        author: { kind: "ai-assisted" },
      });
      expect(hasHumanReview(entry.publication)).toBe(false);
    }
    for (const bank of authored.assessmentBanks) {
      expect(bank.items.every((item) => !isExamEligibleItem(bank, item))).toBe(true);
    }
  });

  it("includes an MCQ checkpoint in every declared topic bank without bypassing review", async () => {
    const { authored } = await pilot();
    const missingMcq = authored.assessmentBanks
      .filter((bank) => !bank.items.some((item) => item.kind === "mcq"))
      .map((bank) => bank.skillId);

    expect(missingMcq).toEqual([]);
    expect(authored.assessmentBanks.every((bank) => (
      bank.items
        .filter((item) => item.kind === "mcq")
        .every((item) => !isExamEligibleItem(bank, item))
    ))).toBe(true);
  });

  it("fails closed for unpublished learner payloads unless preview is explicit", async () => {
    const { authored } = await pilot();
    const lesson = authored.lessons[0]!;
    const bank = authored.assessmentBanks[0]!;

    expect(() => toLearnerLessonPayload(lesson)).toThrow(/Unpublished/);
    expect(() => toLearnerAssessmentBank(bank)).toThrow(/Unpublished/);
    expect(toLearnerLessonPayload(lesson, { allowUnpublishedPreview: true })).toBe(lesson);
    expect(toLearnerAssessmentBank(bank, { allowUnpublishedPreview: true }).provenance)
      .toMatchObject({ stage: "draft", reviewRequired: true, aiAssisted: true });
  });

  it("removes answer keys, rubrics, feedback, author notes, and every hidden test", async () => {
    const { authored } = await pilot();
    const variables = authored.assessmentBanks.find((bank) => bank.skillId === "pf.state.variables")!;
    const learner = toLearnerAssessmentBank(variables, { allowUnpublishedPreview: true });
    const serialized = JSON.stringify(learner);
    const codeItem = learner.items.find((item) => item.kind === "code");

    expect(serialized).not.toContain("referenceSolution");
    expect(serialized).not.toContain("acceptedByGap");
    expect(serialized).not.toContain("privateAuthorNotes");
    expect(serialized).not.toContain("rubric");
    expect(serialized).not.toContain("feedback");
    expect(serialized).not.toContain("hidden");
    expect(codeItem?.kind).toBe("code");
    if (codeItem?.kind === "code") {
      expect(codeItem.tests).toHaveLength(1);
      expect(codeItem.tests.every((test) => test.visibility === "visible")).toBe(true);
      expect(codeItem.runtime).toMatchObject({ engine: "isolated-runner", language: "python" });
    }
  });

  it("never exposes reviewed misconception answer mappings to learner assessment payloads", async () => {
    const { authored } = await pilot();
    const bank = authored.assessmentBanks.find((entry) => entry.skillId === "pf.computing.program")!;
    const source = bank.items.find((item) => item.kind === "trace")!;
    const mappedBank = {
      ...bank,
      items: [{
        ...source,
        misconceptionMappings: [{
          tag: "program.layer-confusion",
          answers: ["private-wrong-answer-sentinel"],
        }],
      }],
    } as AssessmentBank;

    const serialized = JSON.stringify(
      toLearnerAssessmentBank(mappedBank, { allowUnpublishedPreview: true }),
    );
    expect(serialized).not.toContain("misconceptionMappings");
    expect(serialized).not.toContain("program.layer-confusion");
    expect(serialized).not.toContain("private-wrong-answer-sentinel");
  });

  it("rejects misconception mappings that overlap correct evidence or use an unsupported grader", async () => {
    const { authored } = await pilot();
    const programBank = authored.assessmentBanks.find((entry) => entry.skillId === "pf.computing.program")!;
    const trace = programBank.items.find((item) => item.kind === "trace")!;
    expect(() => parseAssessmentBank({
      ...programBank,
      items: [{
        ...trace,
        misconceptionMappings: [{
          tag: "program.correct-as-misconception",
          answers: [trace.answer.acceptedTraces[0]!],
        }],
      }],
    }, "overlapping-misconception.json")).toThrow(/cannot also be an accepted trace/);

    const variablesBank = authored.assessmentBanks.find((entry) => entry.skillId === "pf.state.variables")!;
    const fillGap = variablesBank.items.find((item) => item.kind === "fill-gap")!;
    expect(() => parseAssessmentBank({
      ...variablesBank,
      items: [{
        ...fillGap,
        misconceptionMappings: [{
          tag: "variables.unsupported-shape",
          answers: ["forged scalar response"],
        }],
      }],
    }, "unsupported-misconception.json")).toThrow(/only by deterministic choice and trace graders/);
  });

  it("rejects false review claims, incomplete code test metadata, and broken mappings", async () => {
    const { repository, authored } = await pilot();
    const lesson = structuredClone(authored.lessons[0]!) as AuthoredLesson;
    const bank = structuredClone(
      authored.assessmentBanks.find((entry) => entry.skillId === "pf.state.variables")!,
    ) as AssessmentBank;

    expect(() => parseAuthoredLesson({
      ...lesson,
      publication: { ...lesson.publication, stage: "approved", reviewer: null },
    }, "false-review.json")).toThrow(/human review/);

    const code = bank.items.find((item) => item.kind === "code")!;
    expect(() => parseAssessmentBank({
      ...bank,
      items: [{ ...code, tests: code.tests.filter((test) => test.visibility === "visible") }],
    }, "missing-hidden.json")).toThrow(/visible and one hidden/);

    const index = await repository.getIndex();
    expect(() => validateAuthoredContentSet({
      lessons: [{ ...lesson, skillId: "pf.missing.skill" }],
      assessmentBanks: [],
    }, index)).toThrow(AuthoredContentIntegrityError);
  });
});
