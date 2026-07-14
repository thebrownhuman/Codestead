import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEquivalentExamForm } from "@/app/api/exams/_lib/blueprint";
import { FOUNDATIONS_GIT_TRANCHE_SEEDS } from "../../../../scripts/content-seeds/foundations-git-tranche";
import { toLearnerAssessmentBank } from "../authored";
import { ContentRepository } from "../repository";

const contentRoot = path.resolve(process.cwd(), "content");
const targetCourseIds = ["programming-foundations", "git-tooling"] as const;

describe("Programming Foundations and Git authored tranche", () => {
  it("covers every one of the 68 declared target skills exactly once", async () => {
    const repository = new ContentRepository({ contentRoot });
    const courses = await Promise.all(targetCourseIds.map((id) => repository.getCourse(id)));
    const targetSkills = courses.flatMap((course) =>
      course!.modules.flatMap((courseModule) => courseModule.skills.map((skill) => skill.id)),
    ).sort();
    const authored = await repository.getAuthoredContentSet();
    const lessonSkills = authored.lessons
      .filter((lesson) => targetCourseIds.includes(lesson.courseId as typeof targetCourseIds[number]))
      .map((lesson) => lesson.skillId)
      .sort();
    const bankSkills = authored.assessmentBanks
      .filter((bank) => targetCourseIds.includes(bank.courseId as typeof targetCourseIds[number]))
      .map((bank) => bank.skillId)
      .sort();

    expect(targetSkills).toHaveLength(68);
    expect(new Set(targetSkills).size).toBe(68);
    expect(lessonSkills).toEqual(targetSkills);
    expect(bankSkills).toEqual(targetSkills);
    expect(targetSkills.filter((id) => id.startsWith("pf."))).toHaveLength(32);
    expect(targetSkills.filter((id) => id.startsWith("git."))).toHaveLength(36);
  });

  it("uses unique topic models, scenarios, and misconception corrections rather than generic placeholders", async () => {
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    const lessons = authored.lessons.filter((lesson) =>
      targetCourseIds.includes(lesson.courseId as typeof targetCourseIds[number]),
    );
    const summaries = lessons.map((lesson) => lesson.canonicalExplanation.summary);
    const directScenarios = lessons.map((lesson) => lesson.examples[0]!.situation);
    const misconceptions = lessons.map((lesson) => lesson.misconceptions[0]!.mistakenBelief);
    const serialized = JSON.stringify(lessons);

    expect(new Set(summaries).size).toBe(68);
    expect(new Set(directScenarios).size).toBe(68);
    expect(new Set(misconceptions).size).toBe(68);
    expect(serialized).not.toMatch(/replace this seed|todo|lorem ipsum|authored example required/i);
    for (const lesson of lessons) {
      expect(lesson.examples.length).toBeGreaterThanOrEqual(2);
      expect(lesson.sources.length).toBeGreaterThan(0);
      expect(lesson.trace.steps.length).toBeGreaterThanOrEqual(2);
      expect(lesson.trace.textAlternative.length).toBeGreaterThan(80);
      expect(lesson.practice.farTransfer.expectedEvidence.length).toBeGreaterThan(0);
      expect(lesson.remediation[0]?.misconceptionId).toBe(lesson.misconceptions[0]?.id);
    }
  });

  it("keeps all 66 generated entries draft, AI-assisted, unreviewed, and exam-ineligible", () => {
    const seeds = Object.entries(FOUNDATIONS_GIT_TRANCHE_SEEDS);

    expect(seeds).toHaveLength(66);
    expect(new Set(seeds.map(([, seed]) => seed.model)).size).toBe(66);
    expect(new Set(seeds.map(([, seed]) => seed.scenarioA)).size).toBe(66);
    for (const [, seed] of seeds) {
      expect(seed.model.length).toBeGreaterThan(30);
      expect(seed.boundary.length).toBeGreaterThan(30);
      expect(seed.misconception).not.toBe(seed.correction);
    }
  });

  it("projects every assessment bank without answers, rubrics, notes, feedback, or hidden tests", async () => {
    const authored = await new ContentRepository({ contentRoot }).getAuthoredContentSet();
    for (const bank of authored.assessmentBanks) {
      const learner = toLearnerAssessmentBank(bank, { allowUnpublishedPreview: true });
      const serialized = JSON.stringify(learner);
      expect(bank.publication).toMatchObject({
        stage: "draft",
        aiAssisted: true,
        reviewer: null,
        author: { kind: "ai-assisted" },
      });
      expect(bank.items.every((item) => item.examEligibility.eligible === false)).toBe(true);
      expect(serialized).not.toContain('"answer"');
      expect(serialized).not.toContain('"rubric"');
      expect(serialized).not.toContain('"feedback"');
      expect(serialized).not.toContain("privateAuthorNotes");
      expect(serialized).not.toContain('"visibility":"hidden"');
    }
  });

  it("keeps every target formal exam item pending until a human approves its bank", async () => {
    const repository = new ContentRepository({ contentRoot });
    const snapshot = await repository.getSnapshot();
    for (const courseId of targetCourseIds) {
      const course = (await repository.getCourse(courseId))!;
      for (const courseModule of course.modules) {
        const banks = await repository.listAssessmentBanks({ moduleId: courseModule.id });
        const form = buildEquivalentExamForm({
          course,
          module: courseModule,
          catalogVersion: snapshot.catalog.version,
          seed: `pending:${courseModule.id}`,
          assessmentBanks: banks,
        });
        expect(banks).toHaveLength(courseModule.skills.length);
        expect(form.items).toHaveLength(courseModule.skills.length);
        expect(form.items.every((item) => item.gradingEvidence.kind === "pending-review")).toBe(true);
      }
    }
  });
});
