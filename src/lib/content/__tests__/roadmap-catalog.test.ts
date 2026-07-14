import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { buildLearningPlan } from "@/lib/learning-service/planner";

import { buildRoadmapCatalogViewStates } from "../catalog-view";
import { ContentGraph } from "../graph";
import { validateContentSet } from "../integrity";
import { FileSystemContentLoader } from "../loader";
import type { ContentIndex, ContentSnapshot } from "../types";

let snapshot: ContentSnapshot;
let index: ContentIndex;
let graph: ContentGraph;

beforeAll(async () => {
  snapshot = await new FileSystemContentLoader({
    contentRoot: path.resolve(process.cwd(), "content"),
  }).loadSnapshot();
  index = validateContentSet(snapshot.catalog, snapshot.courses, {
    manifestPaths: snapshot.manifestPaths,
    roadmapManifests: snapshot.roadmapTracks,
    roadmapManifestPaths: snapshot.roadmapManifestPaths,
  });
  graph = new ContentGraph(snapshot.catalog, index);
});

describe("post-Launch curriculum catalog", () => {
  it("keeps roadmap manifests metadata-only and outside the 476-skill Launch 1 index", () => {
    expect(snapshot.courses).toHaveLength(12);
    expect(snapshot.roadmapTracks).toHaveLength(10);
    expect(index.courseById.size).toBe(12);
    expect(index.skillById.size).toBe(476);

    for (const roadmap of snapshot.roadmapTracks) {
      expect(roadmap.status).toBe("coming-soon");
      expect(roadmap.approval).toMatchObject({
        state: "approved-for-roadmap-only",
        required_role: "admin",
      });
      expect(roadmap.publication).toEqual({
        learner_content_available: false,
        authored_lessons: 0,
        assessment_banks: 0,
        exam_eligible_items: 0,
        requires_separate_verified_release: true,
      });
      expect(index.courseById.has(roadmap.id)).toBe(false);
    }
  });

  it("declares the requested advanced and ecosystem prerequisite graph", () => {
    const prerequisites = Object.fromEntries(
      snapshot.roadmapTracks.map((track) => [track.id, track.prerequisites]),
    );
    expect(prerequisites).toMatchObject({
      "advanced-c": ["c"],
      "advanced-cpp": ["cpp"],
      "advanced-java": ["java"],
      "advanced-python": ["python"],
      "advanced-react": ["react"],
      qt: ["cpp"],
      numpy: ["python"],
      pandas: ["python", "numpy"],
      spring: ["java"],
      "spring-boot": ["java", "spring"],
    });
  });

  it("shows Coming Soon scope while blocking navigation and every override", () => {
    expect(graph.getTrackAccessState("qt", [])).toMatchObject({
      visible: true,
      access: "coming-soon",
      canEnroll: false,
      adminOverrideApplied: false,
    });
    expect(
      graph.getTrackAccessState("qt", ["cpp"], { adminPrerequisiteOverride: true }),
    ).toMatchObject({
      visible: true,
      eligible: true,
      access: "coming-soon",
      canEnroll: false,
      adminOverrideApplied: false,
    });
    const eligible = graph.listEligibleTrackIds(["cpp", "python", "java", "react"]);
    for (const roadmapId of ["qt", "numpy", "spring", "advanced-react"]) {
      expect(eligible).not.toContain(roadmapId);
    }
    expect(() => buildLearningPlan(snapshot, index, graph, ["qt"])).toThrow(
      /not published for enrollment/i,
    );

    const viewStates = buildRoadmapCatalogViewStates(snapshot, graph, ["cpp"]);
    expect(viewStates).toHaveLength(10);
    expect(viewStates.find((track) => track.id === "qt")).toMatchObject({
      visible: true,
      access: "coming-soon",
      canEnroll: false,
      href: null,
      prerequisites: ["cpp"],
    });
    expect(viewStates.every((track) => track.scopeBrief.length > 20)).toBe(true);
  });

  it("allows an audited admin override only for prerequisites on a published track", () => {
    expect(graph.getTrackAccessState("java", [])).toMatchObject({
      access: "locked-prerequisites",
      canEnroll: false,
      adminOverrideApplied: false,
    });
    expect(
      graph.getTrackAccessState("java", [], { adminPrerequisiteOverride: true }),
    ).toMatchObject({
      access: "available",
      canEnroll: true,
      adminOverrideApplied: true,
      missingGroups: [{ expression: "programming-foundations" }],
    });
  });
});
