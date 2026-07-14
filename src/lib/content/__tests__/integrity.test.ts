import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ContentIntegrityError,
  type ContentIntegrityIssueCode,
  validateContentSet,
} from "../integrity";
import { FileSystemContentLoader } from "../loader";
import { parseTrackPrerequisiteExpression } from "../track-prerequisites";
import type {
  AtomicSkill,
  ContentCatalog,
  ContentSnapshot,
  CourseManifest,
} from "../types";

let snapshot: ContentSnapshot;

beforeAll(async () => {
  snapshot = await new FileSystemContentLoader({
    contentRoot: path.resolve(process.cwd(), "content"),
  }).loadSnapshot();
});

function issuesFrom(action: () => unknown): readonly ContentIntegrityIssueCode[] {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContentIntegrityError);
    return (error as ContentIntegrityError).issues.map((issue) => issue.code);
  }
  throw new Error("Expected curriculum integrity validation to fail.");
}

function replaceCourse(
  courses: readonly CourseManifest[],
  replacement: CourseManifest,
): readonly CourseManifest[] {
  return courses.map((course) => (course.id === replacement.id ? replacement : course));
}

function replaceSkill(
  course: CourseManifest,
  skillId: string,
  update: (skill: AtomicSkill) => AtomicSkill,
): CourseManifest {
  return {
    ...course,
    modules: course.modules.map((module) => ({
      ...module,
      skills: module.skills.map((skill) => (skill.id === skillId ? update(skill) : skill)),
    })),
  };
}

function replaceTrack(
  catalog: ContentCatalog,
  trackId: string,
  update: (track: ContentCatalog["tracks"][number]) => ContentCatalog["tracks"][number],
): ContentCatalog {
  return {
    ...catalog,
    tracks: catalog.tracks.map((track) => (track.id === trackId ? update(track) : track)),
  };
}

describe("curriculum integrity", () => {
  it("builds collision-free indexes for the complete authored set", () => {
    const index = validateContentSet(snapshot.catalog, snapshot.courses, {
      manifestPaths: snapshot.manifestPaths,
      discoveredManifestPaths: Object.values(snapshot.manifestPaths),
    });

    expect(index.courseById.size).toBe(12);
    expect(index.moduleById.size).toBe(119);
    expect(index.skillById.size).toBe(476);
    expect(index.skillLocationById.size).toBe(476);
  });

  it("detects duplicate tracks, courses, nodes and local sources", () => {
    expect(
      issuesFrom(() =>
        validateContentSet(
          { ...snapshot.catalog, tracks: [...snapshot.catalog.tracks, snapshot.catalog.tracks[0]!] },
          snapshot.courses,
        ),
      ),
    ).toContain("duplicate-track");
    expect(
      issuesFrom(() =>
        validateContentSet(snapshot.catalog, [...snapshot.courses, snapshot.courses[0]!]),
      ),
    ).toContain("duplicate-course");

    const base = snapshot.courses[0]!;
    const firstModule = base.modules[0]!;
    const duplicateNodeCourse: CourseManifest = {
      ...base,
      modules: [
        {
          ...firstModule,
          skills: [...firstModule.skills, { ...firstModule.skills[0]! }],
        },
        ...base.modules.slice(1),
      ],
    };
    expect(
      issuesFrom(() =>
        validateContentSet(
          snapshot.catalog,
          replaceCourse(snapshot.courses, duplicateNodeCourse),
        ),
      ),
    ).toContain("duplicate-node");

    const duplicateSourceCourse: CourseManifest = {
      ...base,
      authoritative_sources: [
        ...base.authoritative_sources,
        { ...base.authoritative_sources[0]! },
      ],
    };
    expect(
      issuesFrom(() =>
        validateContentSet(
          snapshot.catalog,
          replaceCourse(snapshot.courses, duplicateSourceCourse),
        ),
      ),
    ).toContain("duplicate-source");
  });

  it("detects unknown node and source references", () => {
    const base = snapshot.courses[0]!;
    const skillId = base.modules[0]!.skills[0]!.id;
    const unknownNodeCourse = replaceSkill(base, skillId, (skill) => ({
      ...skill,
      prerequisites: [...skill.prerequisites, "unknown.node"],
    }));
    expect(
      issuesFrom(() =>
        validateContentSet(snapshot.catalog, replaceCourse(snapshot.courses, unknownNodeCourse)),
      ),
    ).toContain("unknown-node-prerequisite");

    const unknownSourceCourse = replaceSkill(base, skillId, (skill) => ({
      ...skill,
      source_refs: [...skill.source_refs, "unknown-source"],
    }));
    expect(
      issuesFrom(() =>
        validateContentSet(snapshot.catalog, replaceCourse(snapshot.courses, unknownSourceCourse)),
      ),
    ).toContain("unknown-source-reference");
  });

  it("detects prerequisite cycles", () => {
    const base = snapshot.courses[0]!;
    const firstId = base.modules[0]!.skills[0]!.id;
    const secondId = base.modules[0]!.skills[1]!.id;
    const firstUpdated = replaceSkill(base, firstId, (skill) => ({
      ...skill,
      prerequisites: [secondId],
    }));
    const cycleCourse = replaceSkill(firstUpdated, secondId, (skill) => ({
      ...skill,
      prerequisites: [firstId],
    }));

    expect(
      issuesFrom(() =>
        validateContentSet(snapshot.catalog, replaceCourse(snapshot.courses, cycleCourse)),
      ),
    ).toContain("prerequisite-cycle");
  });

  it("validates OR alternatives in track prerequisites and recommended paths", () => {
    expect(parseTrackPrerequisiteExpression("c|cpp|java|python")).toEqual([
      "c",
      "cpp",
      "java",
      "python",
    ]);
    expect(() => parseTrackPrerequisiteExpression("python|python")).toThrow();
    expect(() => parseTrackPrerequisiteExpression("python|")).toThrow();

    const unknownAlternativeCatalog = replaceTrack(snapshot.catalog, "dsa", (track) => ({
      ...track,
      prerequisites: ["python|unknown-language"],
    }));
    expect(
      issuesFrom(() => validateContentSet(unknownAlternativeCatalog, snapshot.courses)),
    ).toContain("unknown-track-prerequisite");

    const invalidPathCatalog: ContentCatalog = {
      ...snapshot.catalog,
      recommended_paths: [
        ...snapshot.catalog.recommended_paths,
        { id: "invalid-path", tracks: ["python|"] },
      ],
    };
    expect(issuesFrom(() => validateContentSet(invalidPathCatalog, snapshot.courses))).toContain(
      "invalid-track-prerequisite",
    );
  });

  it("detects stale summaries, unsafe governance and unlisted manifests", () => {
    const base = snapshot.courses[0]!;
    const staleCourse: CourseManifest = {
      ...base,
      coverage_summary: {
        ...base.coverage_summary,
        total_skills: base.coverage_summary.total_skills + 1,
      },
    };
    expect(
      issuesFrom(() =>
        validateContentSet(snapshot.catalog, replaceCourse(snapshot.courses, staleCourse)),
      ),
    ).toContain("coverage-summary-mismatch");

    const unsafeCatalog: ContentCatalog = {
      ...snapshot.catalog,
      governance: { ...snapshot.catalog.governance, live_ai_course_generation: true },
    };
    expect(issuesFrom(() => validateContentSet(unsafeCatalog, snapshot.courses))).toContain(
      "live-ai-generation-enabled",
    );
    expect(
      issuesFrom(() =>
        validateContentSet(snapshot.catalog, snapshot.courses, {
          discoveredManifestPaths: [...Object.values(snapshot.manifestPaths), "courses/extra.json"],
        }),
      ),
    ).toContain("unlisted-manifest");
  });
});
