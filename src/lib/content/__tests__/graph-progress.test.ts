import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { ContentGraph } from "../graph";
import { validateContentSet } from "../integrity";
import { FileSystemContentLoader } from "../loader";
import {
  achievedSkillIdsFromProgress,
  aggregateCatalogProgress,
  aggregateCourseProgress,
  aggregateModuleProgress,
  deriveCompletedTrackIds,
  toProgressMap,
} from "../progress";
import type { ContentIndex, ContentSnapshot, SkillProgressInput } from "../types";

let snapshot: ContentSnapshot;
let index: ContentIndex;
let graph: ContentGraph;

beforeAll(async () => {
  snapshot = await new FileSystemContentLoader({
    contentRoot: path.resolve(process.cwd(), "content"),
  }).loadSnapshot();
  index = validateContentSet(snapshot.catalog, snapshot.courses);
  graph = new ContentGraph(snapshot.catalog, index);
});

describe("catalog and node prerequisite graph", () => {
  it("evaluates independent AND groups and OR alternatives", () => {
    expect(graph.evaluateTrackEligibility("dsa", []).eligible).toBe(false);
    expect(graph.evaluateTrackEligibility("dsa", ["python"])).toMatchObject({
      eligible: true,
      groups: [{ expression: "c|cpp|java|python", satisfiedBy: "python" }],
    });
    expect(graph.evaluateTrackEligibility("dsa", ["java"])).toMatchObject({
      eligible: true,
      groups: [{ satisfiedBy: "java" }],
    });

    expect(graph.evaluateTrackEligibility("react", ["html", "css"]).missingGroups).toEqual([
      { expression: "javascript", alternatives: ["javascript"] },
    ]);
    expect(graph.evaluateTrackEligibility("react", ["html", "css", "javascript"]).eligible)
      .toBe(true);
    expect(graph.evaluateTrackEligibility("ai", ["programming-foundations"]).eligible).toBe(false);
    expect(graph.evaluateTrackEligibility("ai", ["programming-foundations", "python"]).eligible)
      .toBe(true);
  });

  it("lists currently eligible tracks without including completed tracks by default", () => {
    expect(graph.listEligibleTrackIds([])).toEqual([
      "programming-foundations",
      "html",
      "git-tooling",
    ]);
    expect(graph.listEligibleTrackIds(["programming-foundations"])).not.toContain(
      "programming-foundations",
    );
    expect(graph.listEligibleTrackIds(["programming-foundations"], true)).toContain(
      "programming-foundations",
    );
    expect(() => graph.evaluateTrackEligibility("unknown", [])).toThrow(RangeError);
  });

  it("treats module prerequisites as completion of every required skill", () => {
    const targetId = "dsa.arrays.operations";
    const requiredEntrySkills = index.requiredSkillIdsByModule.get("dsa.entry-analysis")!;
    const blocked = graph.evaluateNodeEligibility(targetId, []);

    expect(blocked.eligible).toBe(false);
    expect(blocked.missingPrerequisites).toContain("dsa.entry-analysis");
    expect(blocked.expandedMissingSkillIds).toEqual(
      expect.arrayContaining([...requiredEntrySkills]),
    );

    const eligible = graph.evaluateNodeEligibility(targetId, requiredEntrySkills);
    expect(eligible.eligible).toBe(true);
    expect(eligible.satisfiedPrerequisites).toContain("dsa.entry-analysis");
    expect(graph.getTransitivePrerequisiteSkillIds(targetId)).toEqual(
      expect.arrayContaining([...requiredEntrySkills]),
    );
  });

  it("queries direct/transitive dependents and eligible skills deterministically", () => {
    expect(graph.getDirectDependents("dsa.arrays.operations").length).toBeGreaterThan(0);
    expect(graph.getTransitiveDependents("dsa.arrays.operations").length).toBeGreaterThan(
      graph.getDirectDependents("dsa.arrays.operations").length,
    );
    const initialFoundationSkills = graph.listEligibleSkills([], {
      courseId: "programming-foundations",
      status: "required",
    });
    expect(initialFoundationSkills.length).toBeGreaterThan(0);
    expect(initialFoundationSkills.map(({ id }) => id)).toEqual(
      [...initialFoundationSkills.map(({ id }) => id)].sort(),
    );
    expect(() => graph.getDirectPrerequisites("unknown.node")).toThrow(RangeError);
  });
});

describe("progress aggregation", () => {
  it("aggregates the complete 476-skill catalog from no progress", () => {
    const summary = aggregateCatalogProgress(snapshot, index, []);

    expect(summary.total).toBe(476);
    expect(summary.required).toBe(476);
    expect(summary.elective).toBe(0);
    expect(summary.started).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.completionPercent).toBe(0);
    expect(summary.masteryPercent).toBe(0);
    expect(summary.stageCounts.UNSEEN).toBe(476);
    expect(summary.courses).toHaveLength(12);
    expect(summary.completedTrackIds).toEqual([]);
  });

  it("counts completion, mastery, review and unknown skill ids", () => {
    const progress: readonly SkillProgressInput[] = [
      { skillId: "pf.computing.program", stage: "PASSED" },
      { skillId: "c.toolchain.program", stage: "MASTERED", masteryProbability: 0.95 },
      { skillId: "python.toolchain.repl", stage: "REVIEW_DUE" },
      { skillId: "not.authored", stage: "PASSED" },
    ];
    const summary = aggregateCatalogProgress(snapshot, index, progress);

    expect(summary.started).toBe(3);
    expect(summary.completed).toBe(3);
    expect(summary.mastered).toBe(2);
    expect(summary.reviewDue).toBe(1);
    expect(summary.completionPercent).toBe(0.63);
    expect(summary.masteryPercent).toBe(0.42);
    expect(summary.unknownSkillIds).toEqual(["not.authored"]);
    expect([...achievedSkillIdsFromProgress(progress)]).toEqual([
      "pf.computing.program",
      "c.toolchain.program",
      "python.toolchain.repl",
      "not.authored",
    ]);
  });

  it("marks a track complete only after all of its required skills pass", () => {
    const course = index.courseById.get("programming-foundations")!;
    const completedProgress = course.modules.flatMap((module) =>
      module.skills.map((skill) => ({ skillId: skill.id, stage: "PASSED" as const })),
    );
    const courseSummary = aggregateCourseProgress(course, completedProgress);

    expect(courseSummary.complete).toBe(true);
    expect(courseSummary.completionPercent).toBe(100);
    expect(courseSummary.modules.every((module) => module.completionPercent === 100)).toBe(true);
    expect(deriveCompletedTrackIds(snapshot, completedProgress)).toEqual([
      "programming-foundations",
    ]);

    const incomplete = completedProgress.slice(1);
    expect(aggregateCourseProgress(course, incomplete).complete).toBe(false);
  });

  it("supports array, map and keyed-record inputs consistently", () => {
    const entry: SkillProgressInput = { skillId: "html.document.syntax", stage: "LEARNING" };
    const asArray = toProgressMap([entry]);
    const asMap = toProgressMap(new Map([[entry.skillId, entry]]));
    const asRecord = toProgressMap({ [entry.skillId]: entry });
    const courseModule = index.moduleById.get("html.document")!;

    expect([...asArray]).toEqual([...asMap]);
    expect([...asRecord]).toEqual([...asMap]);
    expect(aggregateModuleProgress(courseModule, asRecord).started).toBe(1);
  });
});
