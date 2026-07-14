import path from "node:path";

import { describe, expect, it } from "vitest";

import { toLearnerAssessmentBank } from "../authored";
import { createContentRepository } from "../repository";

const contentRoot = path.join(process.cwd(), "content");

describe("AI Foundations authored draft tranche", () => {
  it("maps source-linked draft lessons and deterministic banks to all 48 declared skills", async () => {
    const repository = createContentRepository({ contentRoot });
    const course = (await repository.listCourses()).find((candidate) => candidate.id === "ai");
    const authored = await repository.getAuthoredContentSet();
    const declared = course!.modules.flatMap((courseModule) => courseModule.skills);
    const declaredIds = new Set(declared.map((skill) => skill.id));
    const lessons = authored.lessons.filter((lesson) => lesson.courseId === "ai");
    const banks = authored.assessmentBanks.filter((bank) => bank.courseId === "ai");

    expect(declared).toHaveLength(48);
    expect(lessons).toHaveLength(48);
    expect(banks).toHaveLength(48);
    expect(new Set(lessons.map((lesson) => lesson.skillId))).toEqual(declaredIds);
    expect(new Set(banks.map((bank) => bank.skillId))).toEqual(declaredIds);
    for (const lesson of lessons) {
      expect(lesson.sources.length).toBeGreaterThan(0);
      expect(lesson.sources.every((source) => source.sourceRef.length > 0 && source.locator.length > 0)).toBe(true);
    }
    for (const entry of [...lessons, ...banks]) {
      expect(entry.publication).toMatchObject({ stage: "draft", aiAssisted: true, reviewer: null });
    }
  });

  it("provides one misconception MCQ and one fill gap per skill plus 24 offline code labs", async () => {
    const repository = createContentRepository({ contentRoot });
    const banks = (await repository.getAuthoredContentSet()).assessmentBanks.filter((bank) => bank.courseId === "ai");
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

    expect(kindCounts).toEqual({ mcq: 48, "fill-gap": 48, code: 24, trace: 0 });
  });

  it("keeps hidden runner cases and author evidence out of learner previews", async () => {
    const repository = createContentRepository({ contentRoot });
    const banks = (await repository.getAuthoredContentSet()).assessmentBanks.filter((bank) => bank.courseId === "ai");
    const codeItems = banks.flatMap((bank) => bank.items.filter((item) => item.kind === "code"));

    expect(codeItems).toHaveLength(24);
    for (const item of codeItems) {
      expect(item.runtime.language).toBe("python");
      expect(item.tests.some((testCase) => testCase.visibility === "visible")).toBe(true);
      expect(item.tests.some((testCase) => testCase.visibility === "hidden")).toBe(true);
    }

    for (const bank of banks) {
      const preview = JSON.stringify(toLearnerAssessmentBank(bank, { allowUnpublishedPreview: true }));
      expect(preview).not.toContain('"answer"');
      expect(preview).not.toContain('"rubric"');
      expect(preview).not.toContain('"feedback"');
      expect(preview).not.toContain('"visibility":"hidden"');
    }
  });
});
