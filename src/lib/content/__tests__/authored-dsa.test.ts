import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEquivalentExamForm } from "@/app/api/exams/_lib/blueprint";
import { DSA_TRANCHE_SEEDS } from "../../../../scripts/content-seeds/dsa-tranche";
import { toLearnerAssessmentBank } from "../authored";
import { DsaParityError, validateDsaLanguageParity } from "../dsa-parity";
import { ContentRepository } from "../repository";

const contentRoot = path.resolve(process.cwd(), "content");

describe("DSA authored tranche", () => {
  it("maps one lesson and bank to all 60 DSA skills", async () => {
    const repository = new ContentRepository({ contentRoot });
    const course = (await repository.getCourse("dsa"))!;
    const declared = course.modules.flatMap((module) => module.skills.map((skill) => skill.id)).sort();
    const authored = await repository.getAuthoredContentSet();
    const lessons = authored.lessons.filter((lesson) => lesson.courseId === "dsa");
    const banks = authored.assessmentBanks.filter((bank) => bank.courseId === "dsa");

    expect(declared).toHaveLength(60);
    expect(lessons.map((lesson) => lesson.skillId).sort()).toEqual(declared);
    expect(banks.map((bank) => bank.skillId).sort()).toEqual(declared);
  });

  it("uses unique concept seeds and explicit C, C++, Java, and Python implementation context", async () => {
    const seeds = Object.entries(DSA_TRANCHE_SEEDS);
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    const lessons = authored.lessons.filter((lesson) => lesson.courseId === "dsa");

    expect(seeds).toHaveLength(60);
    expect(new Set(seeds.map(([, seed]) => seed[0])).size).toBe(60);
    expect(new Set(seeds.map(([, seed]) => seed[2])).size).toBe(60);
    expect(new Set(seeds.map(([, seed]) => seed[3])).size).toBe(60);
    for (const [skillId, seed] of seeds) {
      expect(seed[4]).toContain(seed[5]);
      const lesson = lessons.find((candidate) => candidate.skillId === skillId)!;
      const explanation = JSON.stringify(lesson.canonicalExplanation);
      expect(explanation).toContain("C, C++, Java, and Python");
      expect(explanation).toContain("C++");
      expect(explanation).toContain("Java");
      expect(explanation).toContain("Python");
      expect(lesson.publication).toMatchObject({ stage: "draft", aiAssisted: true, reviewer: null });
    }
  });

  it("provides concept checks plus four pinned draft code variants for every skill", async () => {
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    const banks = authored.assessmentBanks.filter((bank) => bank.courseId === "dsa");
    const items = banks.flatMap((bank) => bank.items);

    expect(items.filter((item) => item.kind === "mcq")).toHaveLength(60);
    expect(items.filter((item) => item.kind === "fill-gap")).toHaveLength(60);
    expect(items.filter((item) => item.kind === "code")).toHaveLength(240);
    expect(items.filter((item) => item.kind === "trace")).toHaveLength(0);
    expect(items.every((item) => !item.examEligibility.eligible)).toBe(true);
    const course = (await new ContentRepository({ contentRoot }).getCourse("dsa"))!;
    const declared = course.modules.flatMap((module) => module.skills.map((skill) => skill.id));
    expect(validateDsaLanguageParity(banks, declared)).toMatchObject({
      skillCount: 60,
      itemCount: 240,
      visibleTestCount: 240,
      hiddenTestCount: 240,
      examEligibleItemCount: 0,
    });
    for (const bank of banks) {
      const value = JSON.stringify(toLearnerAssessmentBank(bank, { allowUnpublishedPreview: true }));
      expect(value).not.toContain('"answer"');
      expect(value).not.toContain('"rubric"');
      expect(value).not.toContain("privateAuthorNotes");
      expect(value).not.toContain('"visibility":"hidden"');
    }
  });

  it("fails closed when a language or hidden parity test is missing", async () => {
    const repository = new ContentRepository({ contentRoot });
    const course = (await repository.getCourse("dsa"))!;
    const declared = course.modules.flatMap((module) => module.skills.map((skill) => skill.id));
    const banks = (await repository.getAuthoredContentSet()).assessmentBanks.filter((bank) => bank.courseId === "dsa");
    const first = banks[0]!;
    const withoutPython = { ...first, items: first.items.filter((item) => !(item.kind === "code" && item.runtime.language === "python")) };
    expect(() => validateDsaLanguageParity([withoutPython, ...banks.slice(1)], declared)).toThrow(DsaParityError);
    const hiddenRemoved = {
      ...first,
      items: first.items.map((item) => item.kind === "code" && item.runtime.language === "java" ? { ...item, tests: item.tests.filter((test) => test.visibility !== "hidden") } : item),
    };
    expect(() => validateDsaLanguageParity([hiddenRemoved, ...banks.slice(1)], declared)).toThrow(/visible and hidden|differ from the C parity baseline/);
  });

  it("keeps every DSA exam form pending human and selected-language review", async () => {
    const repository = new ContentRepository({ contentRoot });
    const course = (await repository.getCourse("dsa"))!;
    const snapshot = await repository.getSnapshot();
    for (const courseModule of course.modules) {
      const banks = await repository.listAssessmentBanks({ moduleId: courseModule.id });
      const form = buildEquivalentExamForm({ course, module: courseModule, catalogVersion: snapshot.catalog.version, seed: `dsa-pending:${courseModule.id}`, assessmentBanks: banks });
      expect(banks).toHaveLength(courseModule.skills.length);
      expect(form.items.every((item) => item.gradingEvidence.kind === "pending-review")).toBe(true);
    }
  });
});
