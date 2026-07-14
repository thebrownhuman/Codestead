import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContentFileError, FileSystemContentLoader } from "../loader";
import { ContentRepository, createContentRepository } from "../repository";

const contentRoot = path.resolve(process.cwd(), "content");

describe("filesystem curriculum runtime", () => {
  it("loads and indexes every authored manifest and atomic skill", async () => {
    const loader = new FileSystemContentLoader({ contentRoot, now: () => 123_456 });
    const snapshot = await loader.loadSnapshot();

    expect(snapshot.catalog.tracks).toHaveLength(22);
    expect(snapshot.courses).toHaveLength(12);
    expect(snapshot.roadmapTracks).toHaveLength(10);
    expect(snapshot.courses.map((course) => course.id)).toEqual(
      snapshot.catalog.tracks
        .filter((track) => track.manifest_kind === "course")
        .map((track) => track.id),
    );
    expect(snapshot.roadmapTracks.map((track) => track.id)).toEqual(
      snapshot.catalog.tracks
        .filter((track) => track.manifest_kind === "roadmap")
        .map((track) => track.id),
    );
    expect(snapshot.courses.flatMap((course) => course.modules)).toHaveLength(119);
    expect(
      snapshot.courses.flatMap((course) =>
        course.modules.flatMap((module) => module.skills),
      ),
    ).toHaveLength(476);
    expect(snapshot.loadedAtMs).toBe(123_456);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.courses)).toBe(true);
    expect(Object.isFrozen(snapshot.roadmapTracks)).toBe(true);

    for (const course of snapshot.courses) {
      const sourceIds = new Set(course.authoritative_sources.map((source) => source.id));
      const skills = course.modules.flatMap((module) => module.skills);
      expect(skills).toHaveLength(course.coverage_summary.total_skills);
      for (const skill of skills) {
        expect(skill.source_refs.length).toBeGreaterThan(0);
        expect(skill.source_refs.every((sourceId) => sourceIds.has(sourceId))).toBe(true);
      }
    }
  });

  it("caches successful reads and invalidates all cached runtime state", async () => {
    const loader = new FileSystemContentLoader({ contentRoot });
    const firstCatalog = await loader.loadCatalog();
    const secondCatalog = await loader.loadCatalog();
    const firstSnapshot = await loader.loadSnapshot();
    const secondSnapshot = await loader.loadSnapshot();

    expect(secondCatalog).toBe(firstCatalog);
    expect(secondSnapshot).toBe(firstSnapshot);

    loader.clearCache();
    expect(await loader.loadCatalog()).not.toBe(firstCatalog);
    expect(await loader.loadSnapshot()).not.toBe(firstSnapshot);
  });

  it("rejects absolute paths and attempts to escape the configured content root", async () => {
    const loader = new FileSystemContentLoader({ contentRoot });

    await expect(loader.loadCourseManifest("../package.json")).rejects.toBeInstanceOf(
      ContentFileError,
    );
    await expect(loader.loadCourseManifest(path.resolve(contentRoot, "catalog.json"))).rejects
      .toBeInstanceOf(ContentFileError);
    await expect(loader.loadRoadmapTrackManifest("../package.json")).rejects.toBeInstanceOf(
      ContentFileError,
    );
  });
});

describe("content repository", () => {
  it("shares the immutable deployed repository but isolates explicitly configured roots", () => {
    expect(createContentRepository()).toBe(createContentRepository());
    expect(createContentRepository({ contentRoot })).not.toBe(
      createContentRepository({ contentRoot }),
    );
  });

  it("provides catalog-ordered list and lookup APIs", async () => {
    const repository = new ContentRepository({ contentRoot });
    const snapshot = await repository.getSnapshot();
    const index = await repository.getIndex();

    expect((await repository.listTracks()).map((track) => track.id)).toEqual(
      snapshot.catalog.tracks.map((track) => track.id),
    );
    expect((await repository.listCourses()).map((course) => course.id)).toEqual(
      snapshot.courses.map((course) => course.id),
    );
    expect(await repository.getTrack("python")).toMatchObject({
      id: "python",
      category: "language",
    });
    expect(await repository.getRoadmapTrack("qt")).toMatchObject({
      id: "qt",
      status: "coming-soon",
      publication: { learner_content_available: false, authored_lessons: 0 },
    });
    expect(await repository.getCourse("python")).toBe(index.courseById.get("python"));
    expect(await repository.getModule("python.toolchain")).toBe(
      index.moduleById.get("python.toolchain"),
    );
    expect(await repository.getSkill("python.toolchain.repl")).toBe(
      index.skillById.get("python.toolchain.repl"),
    );
    expect(await repository.getSkillLocation("python.toolchain.repl")).toMatchObject({
      course: { id: "python" },
      module: { id: "python.toolchain" },
      skill: { id: "python.toolchain.repl" },
    });
    expect(await repository.getCourse("not-a-course")).toBeUndefined();
    expect(await repository.getModule("not-a-module")).toBeUndefined();
    expect(await repository.getSkill("not-a-skill")).toBeUndefined();
  });

  it("filters lists by authored catalog metadata", async () => {
    const repository = new ContentRepository({ contentRoot });

    expect((await repository.listCourses({ category: "language" })).map(({ id }) => id)).toEqual([
      "c",
      "cpp",
      "java",
      "python",
    ]);
    expect(await repository.listTracks({ status: "verified" })).toEqual([]);
    expect(await repository.listTracks({ status: ["beta", "verified"] })).toHaveLength(12);
    expect(await repository.listTracks({ status: "coming-soon" })).toHaveLength(10);
    expect(await repository.listCourses({ release: "does-not-exist" })).toEqual([]);
  });

  it("searches courses, modules, skills and outcomes with deterministic filters", async () => {
    const repository = new ContentRepository({ contentRoot });

    const exact = await repository.search("dsa.lists.singly");
    expect(exact[0]).toMatchObject({
      kind: "skill",
      id: "dsa.lists.singly",
      courseId: "dsa",
      moduleId: "dsa.linked-lists",
    });
    expect(exact[0]?.matchedFields).toContain("id");

    const filtered = await repository.search("linked list", {
      kinds: ["skill"],
      courseIds: ["dsa"],
      status: "beta",
      limit: 5,
    });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThanOrEqual(5);
    expect(filtered.every((result) => result.kind === "skill" && result.courseId === "dsa"))
      .toBe(true);
    expect(await repository.search("linked list", { status: "verified" })).toEqual([]);
    expect(await repository.search("   ")).toEqual([]);
    expect(await repository.search("python", { limit: 0 })).toEqual([]);
    expect(await repository.search("linked list", { kinds: ["skill"], courseIds: ["dsa"] }))
      .toEqual(await repository.search("linked list", { kinds: ["skill"], courseIds: ["dsa"] }));
  });

  it("shares a cached graph and creates fresh runtime objects after clearCache", async () => {
    const repository = new ContentRepository({ contentRoot });
    const firstSnapshot = await repository.getSnapshot();
    const firstIndex = await repository.getIndex();
    const firstGraph = await repository.getGraph();

    expect(await repository.getSnapshot()).toBe(firstSnapshot);
    expect(await repository.getIndex()).toBe(firstIndex);
    expect(await repository.getGraph()).toBe(firstGraph);

    repository.clearCache();
    expect(await repository.getSnapshot()).not.toBe(firstSnapshot);
    expect(await repository.getIndex()).not.toBe(firstIndex);
    expect(await repository.getGraph()).not.toBe(firstGraph);
  });
});
