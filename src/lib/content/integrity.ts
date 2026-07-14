import {
  type AtomicSkill,
  type ContentCatalog,
  type ContentIndex,
  type CourseManifest,
  type CourseModule,
  type RoadmapTrackManifest,
  type SkillLocation,
} from "./types";
import {
  parseTrackPrerequisiteExpression,
  TrackPrerequisiteExpressionError,
} from "./track-prerequisites";

export type ContentIntegrityIssueCode =
  | "duplicate-course"
  | "duplicate-track"
  | "duplicate-node"
  | "duplicate-source"
  | "catalog-course-missing"
  | "catalog-roadmap-missing"
  | "course-not-cataloged"
  | "roadmap-not-cataloged"
  | "catalog-course-mismatch"
  | "catalog-roadmap-mismatch"
  | "catalog-gating-mismatch"
  | "catalog-path-mismatch"
  | "unlisted-manifest"
  | "invalid-track-prerequisite"
  | "unknown-track-prerequisite"
  | "unknown-node-prerequisite"
  | "unknown-source-reference"
  | "coverage-summary-mismatch"
  | "incomplete-published-course"
  | "track-prerequisite-cycle"
  | "prerequisite-cycle"
  | "live-ai-generation-enabled";

export interface ContentIntegrityIssue {
  readonly code: ContentIntegrityIssueCode;
  readonly message: string;
  readonly subjectId?: string;
}

export interface ContentIntegrityOptions {
  readonly manifestPaths?: Readonly<Record<string, string>>;
  readonly discoveredManifestPaths?: readonly string[];
  readonly roadmapManifests?: readonly RoadmapTrackManifest[];
  readonly roadmapManifestPaths?: Readonly<Record<string, string>>;
  readonly discoveredRoadmapManifestPaths?: readonly string[];
}

export class ContentIntegrityError extends Error {
  readonly issues: readonly ContentIntegrityIssue[];

  constructor(issues: readonly ContentIntegrityIssue[]) {
    super(
      `Curriculum integrity failed with ${issues.length} issue(s): ${issues
        .map((issue) => `[${issue.code}] ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "ContentIntegrityError";
    this.issues = issues;
  }
}

function addIssue(
  issues: ContentIntegrityIssue[],
  code: ContentIntegrityIssueCode,
  message: string,
  subjectId?: string,
): void {
  issues.push({ code, message, subjectId });
}

function findCycles(
  prerequisiteGraph: ReadonlyMap<string, readonly string[]>,
): readonly string[][] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const emitted = new Set<string>();

  const visit = (nodeId: string): void => {
    if (state.get(nodeId) === "visited") return;
    if (state.get(nodeId) === "visiting") {
      const start = stack.indexOf(nodeId);
      const cycle = [...stack.slice(Math.max(0, start)), nodeId];
      const signature = cycle.join(" -> ");
      if (!emitted.has(signature)) {
        emitted.add(signature);
        cycles.push(cycle);
      }
      return;
    }

    state.set(nodeId, "visiting");
    stack.push(nodeId);
    for (const prerequisite of prerequisiteGraph.get(nodeId) ?? []) {
      if (prerequisiteGraph.has(prerequisite)) visit(prerequisite);
    }
    stack.pop();
    state.set(nodeId, "visited");
  };

  for (const nodeId of prerequisiteGraph.keys()) visit(nodeId);
  return cycles;
}

function calculatedCoverage(course: CourseManifest) {
  const skills = course.modules.flatMap((module) => module.skills);
  return {
    required_skills: skills.filter((skill) => skill.status === "required").length,
    elective_skills: skills.filter((skill) => skill.status === "elective").length,
    total_skills: skills.length,
    covered: skills.filter((skill) => skill.coverage_status === "covered").length,
    partial: skills.filter((skill) => skill.coverage_status === "partial").length,
    planned: skills.filter((skill) => skill.coverage_status === "planned").length,
  };
}

export function validateContentSet(
  catalog: ContentCatalog,
  courses: readonly CourseManifest[],
  options: ContentIntegrityOptions = {},
): ContentIndex {
  const issues: ContentIntegrityIssue[] = [];
  const trackById = new Map<string, (typeof catalog.tracks)[number]>();
  const courseById = new Map<string, CourseManifest>();
  const roadmapById = new Map<string, RoadmapTrackManifest>();

  for (const track of catalog.tracks) {
    if (trackById.has(track.id)) {
      addIssue(issues, "duplicate-track", `Duplicate catalog track id '${track.id}'.`, track.id);
    } else {
      trackById.set(track.id, track);
    }
  }

  for (const course of courses) {
    if (courseById.has(course.id)) {
      addIssue(issues, "duplicate-course", `Duplicate course id '${course.id}'.`, course.id);
    } else {
      courseById.set(course.id, course);
    }
  }

  for (const roadmap of options.roadmapManifests ?? []) {
    if (roadmapById.has(roadmap.id)) {
      addIssue(issues, "duplicate-track", `Duplicate roadmap manifest id '${roadmap.id}'.`, roadmap.id);
    } else {
      roadmapById.set(roadmap.id, roadmap);
    }
  }

  for (const track of catalog.tracks) {
    if (track.manifest_kind === "roadmap") {
      const roadmap = roadmapById.get(track.id);
      if (!roadmap) {
        if (options.roadmapManifests !== undefined) {
          addIssue(
            issues,
            "catalog-roadmap-missing",
            `Catalog roadmap track '${track.id}' has no roadmap manifest.`,
            track.id,
          );
        }
        continue;
      }
      if (
        track.status !== roadmap.status ||
        track.release !== roadmap.release ||
        track.prerequisites.join("\u0000") !== roadmap.prerequisites.join("\u0000")
      ) {
        addIssue(
          issues,
          "catalog-roadmap-mismatch",
          `Catalog and roadmap manifest status/release/prerequisites differ for '${track.id}'.`,
          track.id,
        );
      }
      if (track.status !== "coming-soon" || track.gating.enrollment !== "blocked-until-published") {
        addIssue(
          issues,
          "catalog-gating-mismatch",
          `Roadmap track '${track.id}' must remain coming-soon and blocked until a separate publication.`,
          track.id,
        );
      }
      const actualPath = options.roadmapManifestPaths?.[track.id];
      if (actualPath && actualPath !== track.manifest) {
        addIssue(
          issues,
          "catalog-path-mismatch",
          `Catalog path '${track.manifest}' does not match loaded roadmap path '${actualPath}'.`,
          track.id,
        );
      }
      continue;
    }

    const course = courseById.get(track.id);
    if (!course) {
      addIssue(
        issues,
        "catalog-course-missing",
        `Catalog track '${track.id}' has no course manifest.`,
        track.id,
      );
      continue;
    }
    if (track.status !== course.status || track.release !== course.release) {
      addIssue(
        issues,
        "catalog-course-mismatch",
        `Catalog and manifest status/release differ for '${track.id}'.`,
        track.id,
      );
    }
    if (track.gating.enrollment !== "prerequisite-gated") {
      addIssue(
        issues,
        "catalog-gating-mismatch",
        `Course track '${track.id}' must use prerequisite-gated enrollment.`,
        track.id,
      );
    }
    const actualPath = options.manifestPaths?.[track.id];
    if (actualPath && actualPath !== track.manifest) {
      addIssue(
        issues,
        "catalog-path-mismatch",
        `Catalog path '${track.manifest}' does not match loaded path '${actualPath}'.`,
        track.id,
      );
    }
  }

  for (const course of courses) {
    if (trackById.get(course.id)?.manifest_kind !== "course") {
      addIssue(
        issues,
        "course-not-cataloged",
        `Course '${course.id}' is not declared in catalog.json.`,
        course.id,
      );
    }
  }


  for (const roadmap of options.roadmapManifests ?? []) {
    if (trackById.get(roadmap.id)?.manifest_kind !== "roadmap") {
      addIssue(
        issues,
        "roadmap-not-cataloged",
        `Roadmap manifest '${roadmap.id}' is not declared as a roadmap track in catalog.json.`,
        roadmap.id,
      );
    }
  }

  const catalogPaths = new Set(
    catalog.tracks.filter((track) => track.manifest_kind === "course").map((track) => track.manifest),
  );
  for (const manifestPath of options.discoveredManifestPaths ?? []) {
    if (!catalogPaths.has(manifestPath)) {
      addIssue(
        issues,
        "unlisted-manifest",
        `Manifest '${manifestPath}' exists on disk but is not in catalog.json.`,
        manifestPath,
      );
    }
  }
  const roadmapCatalogPaths = new Set(
    catalog.tracks.filter((track) => track.manifest_kind === "roadmap").map((track) => track.manifest),
  );
  for (const manifestPath of options.discoveredRoadmapManifestPaths ?? []) {
    if (!roadmapCatalogPaths.has(manifestPath)) {
      addIssue(
        issues,
        "unlisted-manifest",
        `Roadmap manifest '${manifestPath}' exists on disk but is not in catalog.json.`,
        manifestPath,
      );
    }
  }

  const validateTrackExpression = (ownerId: string, expression: string): void => {
    let alternatives: readonly string[];
    try {
      alternatives = parseTrackPrerequisiteExpression(expression);
    } catch (error) {
      const message =
        error instanceof TrackPrerequisiteExpressionError ? error.message : String(error);
      addIssue(issues, "invalid-track-prerequisite", message, ownerId);
      return;
    }
    for (const alternative of alternatives) {
      if (!trackById.has(alternative)) {
        addIssue(
          issues,
          "unknown-track-prerequisite",
          `'${ownerId}' prerequisite '${expression}' references unknown track '${alternative}'.`,
          ownerId,
        );
      }
    }
  };

  for (const track of catalog.tracks) {
    for (const expression of track.prerequisites) {
      validateTrackExpression(track.id, expression);
    }
  }
  for (const pathDefinition of catalog.recommended_paths) {
    for (const expression of pathDefinition.tracks) {
      validateTrackExpression(pathDefinition.id, expression);
    }
  }

  const trackPrerequisites = new Map<string, readonly string[]>();
  for (const track of catalog.tracks) {
    trackPrerequisites.set(
      track.id,
      track.prerequisites.flatMap((expression) => {
        try {
          return parseTrackPrerequisiteExpression(expression);
        } catch {
          return [];
        }
      }),
    );
  }
  for (const cycle of findCycles(trackPrerequisites)) {
    addIssue(
      issues,
      "track-prerequisite-cycle",
      `Track prerequisite cycle: ${cycle.join(" -> ")}.`,
      cycle[0],
    );
  }

  if (catalog.governance.live_ai_course_generation) {
    addIssue(
      issues,
      "live-ai-generation-enabled",
      "Catalog governance must keep live AI course generation disabled.",
    );
  }

  const moduleById = new Map<string, CourseModule>();
  const skillById = new Map<string, AtomicSkill>();
  const moduleCourseById = new Map<string, CourseManifest>();
  const skillLocationById = new Map<string, SkillLocation>();
  const requiredSkillIdsByModule = new Map<string, readonly string[]>();
  const allNodeIds = new Set<string>();
  const nodePrerequisites = new Map<string, readonly string[]>();

  for (const course of courses) {
    const sourceIds = new Set<string>();
    for (const source of course.authoritative_sources) {
      if (sourceIds.has(source.id)) {
        addIssue(
          issues,
          "duplicate-source",
          `Course '${course.id}' declares source '${source.id}' more than once.`,
          course.id,
        );
      }
      sourceIds.add(source.id);
    }

    const calculated = calculatedCoverage(course);
    for (const [key, value] of Object.entries(calculated)) {
      const declared = course.coverage_summary[key as keyof typeof calculated];
      if (declared !== value) {
        addIssue(
          issues,
          "coverage-summary-mismatch",
          `Course '${course.id}' coverage_summary.${key} is ${declared}; calculated ${value}.`,
          course.id,
        );
      }
    }
    if (
      (course.status === "beta" || course.status === "verified") &&
      (calculated.partial > 0 || calculated.planned > 0)
    ) {
      addIssue(
        issues,
        "incomplete-published-course",
        `Course '${course.id}' is ${course.status} but contains partial or planned skills.`,
        course.id,
      );
    }

    for (const courseModule of course.modules) {
      if (allNodeIds.has(courseModule.id)) {
        addIssue(
          issues,
          "duplicate-node",
          `Duplicate node id '${courseModule.id}'.`,
          courseModule.id,
        );
      } else {
        allNodeIds.add(courseModule.id);
      }
      if (!moduleById.has(courseModule.id)) {
        moduleById.set(courseModule.id, courseModule);
        moduleCourseById.set(courseModule.id, course);
      }
      nodePrerequisites.set(courseModule.id, courseModule.prerequisites);
      requiredSkillIdsByModule.set(
        courseModule.id,
        courseModule.skills
          .filter((skill) => skill.status === "required")
          .map((skill) => skill.id),
      );

      for (const skill of courseModule.skills) {
        if (allNodeIds.has(skill.id)) {
          addIssue(issues, "duplicate-node", `Duplicate node id '${skill.id}'.`, skill.id);
        } else {
          allNodeIds.add(skill.id);
        }
        if (!skillById.has(skill.id)) {
          skillById.set(skill.id, skill);
          skillLocationById.set(skill.id, { course, module: courseModule, skill });
        }
        nodePrerequisites.set(skill.id, skill.prerequisites);
        for (const sourceRef of skill.source_refs) {
          if (!sourceIds.has(sourceRef)) {
            addIssue(
              issues,
              "unknown-source-reference",
              `Skill '${skill.id}' references unknown local source '${sourceRef}'.`,
              skill.id,
            );
          }
        }
      }
    }
  }

  for (const [nodeId, prerequisites] of nodePrerequisites) {
    for (const prerequisite of prerequisites) {
      if (!allNodeIds.has(prerequisite)) {
        addIssue(
          issues,
          "unknown-node-prerequisite",
          `Node '${nodeId}' references unknown prerequisite '${prerequisite}'.`,
          nodeId,
        );
      }
    }
  }

  for (const cycle of findCycles(nodePrerequisites)) {
    addIssue(
      issues,
      "prerequisite-cycle",
      `Prerequisite cycle: ${cycle.join(" -> ")}.`,
      cycle[0],
    );
  }

  if (issues.length) throw new ContentIntegrityError(issues);

  return {
    courseById,
    moduleById,
    skillById,
    moduleCourseById,
    skillLocationById,
    requiredSkillIdsByModule,
  };
}
