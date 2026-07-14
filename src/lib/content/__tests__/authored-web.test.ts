import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEquivalentExamForm } from "@/app/api/exams/_lib/blueprint";
import { WEB_TRANCHE_SEEDS } from "../../../../scripts/content-seeds/web-tranche";
import { toLearnerAssessmentBank } from "../authored";
import { ContentRepository } from "../repository";

const contentRoot = path.resolve(process.cwd(), "content");
const webCourseIds = ["html", "css", "javascript", "react"] as const;

describe("HTML, CSS, JavaScript, and React authored tranche", () => {
  it("maps one lesson and bank to all 144 declared web skills", async () => {
    const repository = new ContentRepository({ contentRoot });
    const courses = await Promise.all(webCourseIds.map((id) => repository.getCourse(id)));
    const declared = courses.flatMap((course) => course!.modules.flatMap((courseModule) =>
      courseModule.skills.map((skill) => skill.id),
    )).sort();
    const authored = await repository.getAuthoredContentSet();
    const lessons = authored.lessons.filter((lesson) =>
      webCourseIds.includes(lesson.courseId as typeof webCourseIds[number]),
    );
    const banks = authored.assessmentBanks.filter((bank) =>
      webCourseIds.includes(bank.courseId as typeof webCourseIds[number]),
    );

    expect(declared).toHaveLength(144);
    expect(lessons.map((lesson) => lesson.skillId).sort()).toEqual(declared);
    expect(banks.map((bank) => bank.skillId).sort()).toEqual(declared);
    expect(declared.filter((id) => id.startsWith("html."))).toHaveLength(32);
    expect(declared.filter((id) => id.startsWith("css."))).toHaveLength(32);
    expect(declared.filter((id) => id.startsWith("javascript."))).toHaveLength(40);
    expect(declared.filter((id) => id.startsWith("react."))).toHaveLength(40);
  });

  it("uses one unique technology rule, scenario, and misconception seed per skill", async () => {
    const seeds = Object.entries(WEB_TRANCHE_SEEDS);
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    const lessons = authored.lessons.filter((lesson) =>
      webCourseIds.includes(lesson.courseId as typeof webCourseIds[number]),
    );

    expect(seeds).toHaveLength(144);
    expect(new Set(seeds.map(([, seed]) => seed[0])).size).toBe(144);
    expect(new Set(seeds.map(([, seed]) => seed[2])).size).toBe(144);
    expect(new Set(seeds.map(([, seed]) => seed[3])).size).toBe(144);
    for (const [skillId, seed] of seeds) {
      expect(seed[4]).toContain(seed[5]);
      const lesson = lessons.find((candidate) => candidate.skillId === skillId)!;
      expect(lesson.canonicalExplanation.summary).toBe(seed[0]);
      expect(lesson.examples[0]?.situation).toBe(seed[2]);
      expect(lesson.misconceptions[0]).toMatchObject({ mistakenBelief: seed[3], correction: seed[4] });
      expect(lesson.sources.length).toBeGreaterThan(0);
      expect(lesson.publication).toMatchObject({ stage: "draft", aiAssisted: true, reviewer: null });
    }
  });

  it("provides 144 MCQs, 144 fill gaps, 104 browser facets, and 21 honest Node facets", async () => {
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    const banks = authored.assessmentBanks.filter((bank) =>
      webCourseIds.includes(bank.courseId as typeof webCourseIds[number]),
    );
    const items = banks.flatMap((bank) => bank.items);
    const codeItems = items.filter((item) => item.kind === "code");

    expect(items.filter((item) => item.kind === "mcq")).toHaveLength(144);
    expect(items.filter((item) => item.kind === "fill-gap")).toHaveLength(144);
    expect(codeItems).toHaveLength(125);
    expect(items.every((item) => !item.examEligibility.eligible)).toBe(true);
    expect(codeItems.filter((item) => item.runtime.engine === "browser-verifier")).toHaveLength(104);
    expect(codeItems.filter((item) => item.runtime.engine === "isolated-runner")).toHaveLength(21);
    expect(codeItems.filter((item) => item.runtime.engine === "isolated-runner").every((item) =>
      item.runtime.language === "javascript" && item.skillId.startsWith("javascript."),
    )).toBe(true);
    for (const item of codeItems) {
      expect(item.tests.some((test) => test.visibility === "visible")).toBe(true);
      expect(item.tests.some((test) => test.visibility === "hidden")).toBe(true);
    }
  });

  it("strips every private oracle and hidden test from learner projections", async () => {
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    for (const bank of authored.assessmentBanks.filter((candidate) =>
      webCourseIds.includes(candidate.courseId as typeof webCourseIds[number]),
    )) {
      const value = JSON.stringify(toLearnerAssessmentBank(bank, { allowUnpublishedPreview: true }));
      expect(value).not.toContain('"answer"');
      expect(value).not.toContain('"rubric"');
      expect(value).not.toContain('"feedback"');
      expect(value).not.toContain("privateAuthorNotes");
      expect(value).not.toContain("referenceSolution");
      expect(value).not.toContain('"visibility":"hidden"');
    }
  });

  it("keeps all web formal exam forms pending human review", async () => {
    const repository = new ContentRepository({ contentRoot });
    const snapshot = await repository.getSnapshot();
    for (const courseId of webCourseIds) {
      const course = (await repository.getCourse(courseId))!;
      for (const courseModule of course.modules) {
        const banks = await repository.listAssessmentBanks({ moduleId: courseModule.id });
        const form = buildEquivalentExamForm({ course, module: courseModule, catalogVersion: snapshot.catalog.version, seed: `web-pending:${courseModule.id}`, assessmentBanks: banks });
        expect(banks).toHaveLength(courseModule.skills.length);
        expect(form.items.every((item) => item.gradingEvidence.kind === "pending-review")).toBe(true);
      }
    }
  });
});
