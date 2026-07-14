import path from "node:path";

import { describe, expect, it } from "vitest";

import { toLearnerAssessmentBank } from "../authored";
import { createContentRepository } from "../repository";

describe("Java and Python authored draft tranche", () => {
  it("covers every declared skill with a draft lesson and deterministic bank", async () => {
    const repository = createContentRepository({ contentRoot: path.join(process.cwd(), "content") });
    const courses = await repository.listCourses();
    const authored = await repository.getAuthoredContentSet();
    const targetSkills = courses
      .filter((course) => course.id === "java" || course.id === "python")
      .flatMap((course) => course.modules.flatMap((courseModule) => courseModule.skills));
    const targetIds = new Set(targetSkills.map((skill) => skill.id));
    const lessons = authored.lessons.filter((lesson) => targetIds.has(lesson.skillId));
    const banks = authored.assessmentBanks.filter((bank) => targetIds.has(bank.skillId));

    expect(targetSkills).toHaveLength(80);
    expect(lessons).toHaveLength(80);
    expect(banks).toHaveLength(80);
    expect(new Set(lessons.map((lesson) => lesson.skillId))).toEqual(targetIds);
    expect(new Set(banks.map((bank) => bank.skillId))).toEqual(targetIds);
    for (const entry of [...lessons, ...banks]) {
      expect(entry.publication).toMatchObject({ stage: "draft", aiAssisted: true, reviewer: null });
    }
  });

  it("keeps all items exam-ineligible and supplies misconception plus fill-gap evidence per skill", async () => {
    const repository = createContentRepository({ contentRoot: path.join(process.cwd(), "content") });
    const banks = (await repository.getAuthoredContentSet()).assessmentBanks
      .filter((bank) => bank.courseId === "java" || bank.courseId === "python");
    const kindCounts = { mcq: 0, "fill-gap": 0, code: 0, trace: 0 };

    for (const bank of banks) {
      expect(bank.items.some((item) => item.kind === "mcq")).toBe(true);
      expect(bank.items.some((item) => item.kind === "fill-gap")).toBe(true);
      for (const item of bank.items) {
        kindCounts[item.kind] += 1;
        expect(item.examEligibility.eligible).toBe(false);
        expect(item.examEligibility.rationale).toMatch(/human.*review/i);
      }
    }

    expect(kindCounts).toEqual({ mcq: 80, "fill-gap": 80, code: 44, trace: 0 });
  });

  it("provides visible and hidden runner cases without exposing hidden tests in learner projection", async () => {
    const repository = createContentRepository({ contentRoot: path.join(process.cwd(), "content") });
    const banks = (await repository.getAuthoredContentSet()).assessmentBanks
      .filter((bank) => bank.courseId === "java" || bank.courseId === "python");
    const codeItems = banks.flatMap((bank) => bank.items.filter((item) => item.kind === "code"));

    expect(codeItems).toHaveLength(44);
    for (const item of codeItems) {
      expect(item.tests.some((testCase) => testCase.visibility === "visible")).toBe(true);
      expect(item.tests.some((testCase) => testCase.visibility === "hidden")).toBe(true);
    }

    const bank = banks.find((item) => item.skillId === "java.fundamentals.primitives");
    expect(bank).toBeDefined();
    const preview = toLearnerAssessmentBank(bank!, { allowUnpublishedPreview: true });
    const previewCode = preview.items.find((item) => item.kind === "code");
    expect(previewCode?.tests).toHaveLength(1);
    expect(previewCode?.tests.every((testCase) => testCase.visibility === "visible")).toBe(true);
    expect(previewCode).not.toHaveProperty("answer");
    expect(previewCode).not.toHaveProperty("rubric");
    expect(previewCode).not.toHaveProperty("feedback");
  });
});
