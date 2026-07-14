import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEquivalentExamForm } from "@/app/api/exams/_lib/blueprint";
import {
  WEB_BROWSER_TASKS,
  WEB_NEW_NODE_TASKS,
  WEB_NON_CODE_FACETS,
  WEB_RETAINED_NODE_SKILLS,
} from "../../../../scripts/content-seeds/web-executable-tranche";
import type { AssessmentBank, CodeAssessmentItem } from "../authored-types";
import { ContentRepository } from "../repository";

const contentRoot = path.resolve(process.cwd(), "content");
const webCourseIds = ["html", "css", "javascript", "react"] as const;

describe("web executable tranche structure", () => {
  it("classifies every declared web skill exactly once", async () => {
    const repository = new ContentRepository({ contentRoot });
    const courses = await Promise.all(webCourseIds.map((courseId) => repository.getCourse(courseId)));
    const declared = courses.flatMap((course) => course!.modules.flatMap((courseModule) =>
      courseModule.skills.map((skill) => skill.id),
    )).sort();
    const classified = [
      ...Object.keys(WEB_BROWSER_TASKS),
      ...Object.keys(WEB_NEW_NODE_TASKS),
      ...WEB_RETAINED_NODE_SKILLS,
      ...Object.keys(WEB_NON_CODE_FACETS),
    ];

    expect(declared).toHaveLength(144);
    expect(classified).toHaveLength(144);
    expect(new Set(classified).size).toBe(144);
    expect([...classified].sort()).toEqual(declared);
    expect(Object.keys(WEB_BROWSER_TASKS)).toHaveLength(104);
    expect(Object.keys(WEB_NEW_NODE_TASKS)).toHaveLength(15);
    expect(WEB_RETAINED_NODE_SKILLS).toHaveLength(6);
    expect(Object.keys(WEB_NON_CODE_FACETS)).toHaveLength(19);
  });

  it("keeps all executable items draft, critical, visible/hidden, and runtime-pinned", async () => {
    const repository = new ContentRepository({ contentRoot });
    const authored = await repository.getAuthoredContentSet();
    const webBanks = authored.assessmentBanks.filter((bank) =>
      webCourseIds.includes(bank.courseId as typeof webCourseIds[number]),
    );
    const items = webBanks.flatMap((bank) => bank.items)
      .filter((item): item is CodeAssessmentItem => item.kind === "code");
    const javascriptDigests = new Set(items
      .filter((item) => item.runtime.engine === "isolated-runner")
      .map((item) => item.runtime.imageDigest));
    expect(javascriptDigests.size).toBe(1);
    const javascriptDigest = [...javascriptDigests][0];
    expect(javascriptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    expect(items).toHaveLength(125);
    for (const bank of webBanks) {
      expect(bank.publication).toMatchObject({ stage: "draft", aiAssisted: true, reviewer: null });
      expect(bank.items.every((item) => item.examEligibility.eligible === false)).toBe(true);
    }
    for (const item of items) {
      expect(item.tests.some((test) => test.visibility === "visible")).toBe(true);
      expect(item.tests.some((test) => test.visibility === "hidden")).toBe(true);
      expect(item.tests.every((test) => test.critical)).toBe(true);
      if (item.runtime.engine === "isolated-runner") {
        expect(item.runtime).toMatchObject({
          language: "javascript",
          version: "Node.js 22.23.1 (ECMAScript 2025)",
          imageDigest: javascriptDigest,
        });
      } else {
        expect(item.runtime.browser).toEqual({
          name: "chromium",
          revision: "1228",
          version: "149.0.7827.55",
          playwrightVersion: "1.61.1",
        });
        for (const test of item.tests) {
          const contract = JSON.parse(test.stdin) as { assertions?: unknown[] };
          expect(contract.assertions?.length).toBeGreaterThan(0);
          expect(test.expectedStdout).toBe("pass\n");
          expect(test.comparison).toBe("exact");
        }
      }
    }

    const portfolioItem = items.find((item) => item.skillId === "react.project.spa")!;
    const project = JSON.parse(portfolioItem.answer.referenceSolution) as {
      format: string;
      entrypoints: { app: string; test: string };
      files: Record<string, string>;
    };
    expect(project.format).toBe("browser-project-v1");
    expect(project.entrypoints).toEqual({ app: "src/main.tsx", test: "src/portfolio.test.tsx" });
    expect(Object.keys(project.files).sort()).toEqual([
      "index.html", "package.json", "src/App.tsx", "src/data.ts", "src/main.tsx",
      "src/portfolio.test.tsx", "src/styles.css", "tsconfig.json",
    ]);
    expect(project.files["src/App.tsx"]).toContain('from "react-router"');
    expect(project.files["src/portfolio.test.tsx"]).toContain('from "@testing-library/react"');
    expect(project.files["src/portfolio.test.tsx"]).toContain('from "@testing-library/user-event"');
  });

  it("fails closed if an authoring-only browser item is forced into an official exam", async () => {
    const repository = new ContentRepository({ contentRoot });
    const course = (await repository.getCourse("html"))!;
    const courseModule = course.modules[0]!;
    const bank = (await repository.listAssessmentBanks({ moduleId: courseModule.id }))
      .find((candidate) => candidate.items.some((item) => item.kind === "code"))!;
    const browserItem = bank.items.find((item): item is CodeAssessmentItem => item.kind === "code")!;
    const forced = {
      ...bank,
      publication: {
        ...bank.publication,
        stage: "approved" as const,
        reviewer: {
          id: "negative-test-reviewer",
          displayName: "Negative test reviewer",
          kind: "human" as const,
          reviewedAt: "2026-07-12T00:00:00.000Z",
          reviewVersion: "0.1.0",
        },
      },
      items: bank.items.map((item) => item.id === browserItem.id
        ? { ...item, examEligibility: { eligible: true, rationale: "Deliberate negative test: this item must be rejected by official exam construction." } }
        : item),
    } as AssessmentBank;

    expect(() => buildEquivalentExamForm({
      course,
      module: courseModule,
      catalogVersion: "negative-test",
      seed: "browser-item-must-fail-closed",
      assessmentBanks: [forced],
    })).toThrow(/authoring-only browser item/i);
  });
});
