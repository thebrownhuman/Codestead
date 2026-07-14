import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { buildModuleProjectCatalog } from "../module-project-catalog";
import { moduleProjectAccessState, moduleProjectPlanSatisfied } from "../module-project-service";
import { FileSystemContentLoader } from "@/lib/content/loader";

const loader = new FileSystemContentLoader({ contentRoot: path.join(process.cwd(), "content") });
let brief: ReturnType<typeof buildModuleProjectCatalog>[number];

beforeAll(async () => {
  brief = buildModuleProjectCatalog(await loader.loadSnapshot())[0]!;
});

describe("module project access gates", () => {
  it("never exposes draft, stale, or retired publications as ready", () => {
    const base = {
      courseStage: "beta",
      currentPublication: true,
      enrollmentStatus: "active",
      planSatisfied: true,
      masterySatisfied: true,
      projectId: null,
    };
    expect(moduleProjectAccessState({ ...base, templateStage: "draft" })).toBe("draft");
    expect(moduleProjectAccessState({ ...base, templateStage: "beta", currentPublication: false })).toBe("retired");
    expect(moduleProjectAccessState({ ...base, templateStage: "retired" })).toBe("retired");
  });

  it("requires plan evidence before independent mastery and returns ready only after both", () => {
    const base = {
      templateStage: "beta",
      courseStage: "beta",
      currentPublication: true,
      enrollmentStatus: "active",
      projectId: null,
    };
    expect(moduleProjectAccessState({ ...base, planSatisfied: false, masterySatisfied: false })).toBe("plan_locked");
    expect(moduleProjectAccessState({ ...base, planSatisfied: true, masterySatisfied: false })).toBe("mastery_locked");
    expect(moduleProjectAccessState({ ...base, planSatisfied: true, masterySatisfied: true })).toBe("ready");
    expect(moduleProjectAccessState({ ...base, planSatisfied: false, masterySatisfied: false, projectId: "owned" })).toBe("started");
  });

  it("binds plan skills to the exact course, version, and module", () => {
    const exactPlan = brief.prerequisiteSkillIds.map((skillId) => ({
      trackId: brief.courseId,
      courseVersion: brief.courseVersion,
      moduleId: brief.moduleId,
      skillId,
    }));
    expect(moduleProjectPlanSatisfied(exactPlan, brief)).toBe(true);
    expect(moduleProjectPlanSatisfied(exactPlan.map((item) => ({ ...item, courseVersion: "other" })), brief)).toBe(false);
    expect(moduleProjectPlanSatisfied(exactPlan.slice(1), brief)).toBe(false);
    expect(moduleProjectPlanSatisfied(null, brief)).toBe(false);
  });
});
