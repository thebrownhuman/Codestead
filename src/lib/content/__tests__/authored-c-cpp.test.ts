import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEquivalentExamForm } from "@/app/api/exams/_lib/blueprint";
import { C_CPP_TRANCHE_SEEDS } from "../../../../scripts/content-seeds/c-cpp-tranche";
import { toLearnerAssessmentBank } from "../authored";
import { ContentRepository } from "../repository";

const contentRoot = path.resolve(process.cwd(), "content");
const courseIds = ["c", "cpp"] as const;

describe("C and C++ authored tranche", () => {
  it("maps one lesson and bank to every declared C and C++ skill", async () => {
    const repository = new ContentRepository({ contentRoot });
    const courses = await Promise.all(courseIds.map((id) => repository.getCourse(id)));
    const declared = courses.flatMap((course) =>
      course!.modules.flatMap((courseModule) => courseModule.skills.map((skill) => skill.id)),
    ).sort();
    const authored = await repository.getAuthoredContentSet();
    const lessons = authored.lessons.filter((lesson) =>
      courseIds.includes(lesson.courseId as typeof courseIds[number]),
    );
    const banks = authored.assessmentBanks.filter((bank) =>
      courseIds.includes(bank.courseId as typeof courseIds[number]),
    );

    expect(declared.filter((id) => id.startsWith("c."))).toHaveLength(36);
    expect(declared.filter((id) => id.startsWith("cpp."))).toHaveLength(40);
    expect(lessons).toHaveLength(76);
    expect(banks).toHaveLength(76);
    expect(lessons.map((lesson) => lesson.skillId).sort()).toEqual(declared);
    expect(banks.map((bank) => bank.skillId).sort()).toEqual(declared);
  });

  it("uses individually seeded language models, boundaries, examples, and misconceptions", async () => {
    const entries = Object.entries(C_CPP_TRANCHE_SEEDS);
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    const lessons = authored.lessons.filter((lesson) =>
      courseIds.includes(lesson.courseId as typeof courseIds[number]),
    );

    expect(entries).toHaveLength(76);
    expect(new Set(entries.map(([, seed]) => seed.model)).size).toBe(76);
    expect(new Set(entries.map(([, seed]) => seed.scenarioA)).size).toBe(76);
    expect(new Set(entries.map(([, seed]) => seed.misconception)).size).toBe(76);
    for (const [skillId, seed] of entries) {
      expect(seed.correction).toContain(seed.checkpoint);
      expect(seed.model.length).toBeGreaterThan(50);
      expect(seed.boundary.length).toBeGreaterThan(50);
      const lesson = lessons.find((candidate) => candidate.skillId === skillId)!;
      expect(lesson.canonicalExplanation.summary).toBe(seed.model);
      expect(lesson.examples.map((example) => example.situation)).toEqual([
        seed.scenarioA,
        seed.scenarioB,
      ]);
      expect(lesson.misconceptions[0]).toMatchObject({
        mistakenBelief: seed.misconception,
        correction: seed.correction,
      });
      expect(lesson.sources.length).toBeGreaterThan(0);
      expect(lesson.publication).toMatchObject({
        stage: "draft",
        aiAssisted: true,
        reviewer: null,
        author: { kind: "ai-assisted" },
      });
    }
  });

  it("provides 76 MCQs, 76 fill gaps, and 66 bounded code items with deterministic metadata", async () => {
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    const banks = authored.assessmentBanks.filter((bank) =>
      courseIds.includes(bank.courseId as typeof courseIds[number]),
    );
    const items = banks.flatMap((bank) => bank.items);
    const codeItems = items.filter((item) => item.kind === "code");

    expect(items.filter((item) => item.kind === "mcq")).toHaveLength(76);
    expect(items.filter((item) => item.kind === "fill-gap")).toHaveLength(76);
    expect(codeItems).toHaveLength(66);
    expect(items.every((item) => item.examEligibility.eligible === false)).toBe(true);
    for (const item of codeItems) {
      expect(item.tests.some((test) => test.visibility === "visible")).toBe(true);
      expect(item.tests.some((test) => test.visibility === "hidden")).toBe(true);
      expect(item.runtime.engine).toBe("isolated-runner");
      expect(["c", "cpp"]).toContain(item.runtime.language);
      expect(item.answer.referenceSolution).not.toMatch(/\n\+/);
      expect(item.answer.referenceSolution).toContain("main");
    }
  });

  it("never exposes answers, rubrics, notes, feedback, reference code, or hidden tests", async () => {
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    const banks = authored.assessmentBanks.filter((bank) =>
      courseIds.includes(bank.courseId as typeof courseIds[number]),
    );
    for (const bank of banks) {
      const serialized = JSON.stringify(
        toLearnerAssessmentBank(bank, { allowUnpublishedPreview: true }),
      );
      expect(serialized).not.toContain('"answer"');
      expect(serialized).not.toContain('"rubric"');
      expect(serialized).not.toContain('"feedback"');
      expect(serialized).not.toContain("privateAuthorNotes");
      expect(serialized).not.toContain("referenceSolution");
      expect(serialized).not.toContain('"visibility":"hidden"');
    }
  });

  it("keeps every C and C++ formal exam item pending human review", async () => {
    const repository = new ContentRepository({ contentRoot });
    const snapshot = await repository.getSnapshot();
    for (const courseId of courseIds) {
      const course = (await repository.getCourse(courseId))!;
      for (const courseModule of course.modules) {
        const banks = await repository.listAssessmentBanks({ moduleId: courseModule.id });
        const form = buildEquivalentExamForm({
          course,
          module: courseModule,
          catalogVersion: snapshot.catalog.version,
          seed: `c-cpp-pending:${courseModule.id}`,
          assessmentBanks: banks,
        });
        expect(banks).toHaveLength(courseModule.skills.length);
        expect(form.items.every((item) => item.gradingEvidence.kind === "pending-review")).toBe(true);
      }
    }
  });
});
