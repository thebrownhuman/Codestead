import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileSystemContentLoader } from "@/lib/content/loader";
import {
  buildModuleProjectBrief,
  buildModuleProjectCatalog,
  MODULE_PROJECT_TEMPLATE_VERSION,
  validateModuleProjectCatalog,
} from "@/lib/projects/module-project-catalog";

const loader = new FileSystemContentLoader({ contentRoot: path.join(process.cwd(), "content") });

describe("module project catalog", () => {
  it("creates one complete, solution-free brief for every required Launch 1 module", async () => {
    const snapshot = await loader.loadSnapshot();
    const catalog = buildModuleProjectCatalog(snapshot);
    const report = validateModuleProjectCatalog(snapshot, catalog);

    expect(report).toEqual({ courseCount: 12, moduleCount: 119, templateCount: 119 });
    expect(catalog.every((brief) => brief.solution === null)).toBe(true);
    expect(catalog.every((brief) => brief.directAwardPolicy === "none")).toBe(true);
    expect(catalog.every((brief) => brief.publicationStatus === "beta")).toBe(true);
    expect(catalog.every((brief) => brief.editorialNotice.startsWith("Draft preview:"))).toBe(true);
  });

  it("is deterministic, version-bound, and changes its hash when canonical content changes", async () => {
    const snapshot = await loader.loadSnapshot();
    const course = snapshot.courses.find((item) => item.id === "python")!;
    const courseModule = course.modules.find((item) => item.id === "python.values-control")!;
    const first = buildModuleProjectBrief(course, courseModule);
    const second = buildModuleProjectBrief(course, courseModule);
    const changed = buildModuleProjectBrief(course, {
      ...courseModule,
      title: `${courseModule.title} revised`,
    });

    expect(first).toEqual(second);
    expect(first.templateVersion).toBe(MODULE_PROJECT_TEMPLATE_VERSION);
    expect(first.templateKey).toContain(`${course.id}:${course.version}:${courseModule.id}`);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });

  it("uses beginner-facing structure with explicit acceptance and reflection work", async () => {
    const catalog = buildModuleProjectCatalog(await loader.loadSnapshot());
    for (const brief of catalog) {
      expect(brief.laymanScenario.length).toBeGreaterThan(80);
      expect(brief.problem).toMatch(/no finished code/i);
      expect(brief.milestones.map((item) => item.title)).toEqual([
        "Explain the problem in plain language",
        "Sketch the smallest complete path",
        "Build one observable workflow",
        "Test normal, boundary, and failure behaviour",
        "Refactor, document, and reflect",
      ]);
      expect(brief.acceptanceChecks.map((item) => item.id)).toEqual(["normal", "boundary", "failure"]);
      expect(brief.reflectionPrompts).toHaveLength(4);
      expect(brief.stretchGoals).toHaveLength(2);
      expect(brief.sourceRefs.length).toBeGreaterThan(0);
    }
  });

  it("rejects stale, duplicated, or reward-bearing catalog entries", async () => {
    const snapshot = await loader.loadSnapshot();
    const catalog = buildModuleProjectCatalog(snapshot);
    expect(() => validateModuleProjectCatalog(snapshot, [catalog[0]!, catalog[0]!]))
      .toThrow(/duplicate module project/i);
    expect(() => validateModuleProjectCatalog(snapshot, [{
      ...catalog[0]!,
      directAwardPolicy: "project_completion" as never,
    }])).toThrow(/must not include a solution or direct reward/i);
  });
});
