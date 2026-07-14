import { z } from "zod";

import {
  CATALOG_MANIFEST_KINDS,
  CONTENT_PROGRESS_STAGES,
  COURSE_STATUSES,
  COVERAGE_STATUSES,
  EVIDENCE_TYPES,
  RUNTIME_KINDS,
  SKILL_STATUSES,
  TRACK_ADMIN_OVERRIDE_POLICIES,
  TRACK_ENROLLMENT_POLICIES,
  type ContentCatalog,
  type CourseManifest,
  type RoadmapTrackManifest,
} from "./types";

const identifier = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/);
const courseIdentifier = z.string().regex(/^[a-z][a-z0-9-]*$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const nonEmpty = z.string().min(1);

const catalogTrackSchema = z
  .object({
    id: courseIdentifier,
    // Catalog navigation labels may intentionally be terse (for example, "C").
    title: nonEmpty,
    category: nonEmpty,
    manifest: z.string().min(1),
    manifest_kind: z.enum(CATALOG_MANIFEST_KINDS),
    status: z.enum(COURSE_STATUSES),
    release: z.string().regex(/^launch-\d+$/),
    prerequisites: z.array(nonEmpty),
    gating: z
      .object({
        visibility: z.literal("listed"),
        enrollment: z.enum(TRACK_ENROLLMENT_POLICIES),
        admin_override: z.enum(TRACK_ADMIN_OVERRIDE_POLICIES),
      })
      .strict(),
    summary: z.string().min(20),
  })
  .strict();

export const roadmapTrackManifestSchema = z
  .object({
    $schema: nonEmpty,
    format: z.literal("roadmap-track"),
    schema_version: z.literal("1.0.0"),
    id: courseIdentifier,
    title: nonEmpty,
    status: z.literal("coming-soon"),
    release: z.string().regex(/^launch-\d+$/),
    prerequisites: z.array(nonEmpty),
    scope_brief: z.string().min(20),
    planned_scope: z.array(z.string().min(8)).min(1),
    non_goals: z.array(z.string().min(8)).min(1),
    approval: z
      .object({
        state: z.literal("approved-for-roadmap-only"),
        required_role: z.literal("admin"),
        decision_ref: z.string().min(8),
      })
      .strict(),
    publication: z
      .object({
        learner_content_available: z.literal(false),
        authored_lessons: z.literal(0),
        assessment_banks: z.literal(0),
        exam_eligible_items: z.literal(0),
        requires_separate_verified_release: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const contentCatalogSchema = z
  .object({
    version: semver,
    release: z.string().regex(/^launch-\d+$/),
    status: z.enum(COURSE_STATUSES),
    description: z.string().min(20),
    status_policy: z
      .object({
        "coming-soon": nonEmpty,
        beta: nonEmpty,
        verified: nonEmpty,
        retired: nonEmpty,
      })
      .strict(),
    tracks: z.array(catalogTrackSchema).min(1),
    recommended_paths: z.array(
      z
        .object({
          id: courseIdentifier,
          tracks: z.array(nonEmpty).min(1),
        })
        .strict(),
    ),
    governance: z
      .object({
        live_ai_course_generation: z.boolean(),
        publication_flow: z.array(nonEmpty).min(1),
        missing_promised_topic: nonEmpty,
        new_extension: nonEmpty,
      })
      .strict(),
  })
  .strict();

const sourceSchema = z
  .object({
    id: courseIdentifier,
    title: z.string().min(3),
    url: z.url(),
    type: z.enum([
      "standard",
      "specification",
      "official-docs",
      "curriculum",
      "security-guidance",
      "accessibility-standard",
      "research",
    ]),
    version_or_date: nonEmpty,
  })
  .strict();

const atomicSkillSchema = z
  .object({
    id: identifier,
    title: z.string().min(3),
    description: z.string().min(8),
    outcomes: z.array(z.string().min(8)).min(1),
    prerequisites: z.array(identifier),
    evidence_types: z.array(z.enum(EVIDENCE_TYPES)).min(1),
    status: z.enum(SKILL_STATUSES),
    coverage_status: z.enum(COVERAGE_STATUSES),
    source_refs: z.array(courseIdentifier).min(1),
  })
  .strict();

const moduleSchema = z
  .object({
    id: identifier,
    title: z.string().min(3),
    description: z.string().min(10),
    required: z.boolean(),
    prerequisites: z.array(identifier),
    skills: z.array(atomicSkillSchema).min(1),
  })
  .strict();

export const courseManifestSchema = z
  .object({
    $schema: nonEmpty,
    id: courseIdentifier,
    title: z.string().min(3),
    version: semver,
    status: z.enum(COURSE_STATUSES),
    release: z.string().regex(/^launch-\d+$/),
    summary: z.string().min(20),
    audience: z
      .object({
        level: z.string().min(3),
        assumed_knowledge: z.array(nonEmpty),
        target_capability: z.string().min(10),
      })
      .strict(),
    scope: z
      .object({
        includes: z.array(z.string().min(2)).min(1),
        non_goals: z.array(z.string().min(2)).min(1),
      })
      .strict(),
    authoritative_sources: z.array(sourceSchema).min(1),
    runtime: z
      .object({
        kind: z.enum(RUNTIME_KINDS),
        language: z.string(),
        standard: z.string(),
        toolchain: z.array(nonEmpty),
        execution_environment: z.string(),
        file_extensions: z.array(z.string().regex(/^\.[A-Za-z0-9+_-]+$/)),
        notes: z.array(nonEmpty),
      })
      .strict(),
    modules: z.array(moduleSchema).min(1),
    exit_outcomes: z.array(z.string().min(8)).min(2),
    coverage_summary: z
      .object({
        required_skills: z.number().int().nonnegative(),
        elective_skills: z.number().int().nonnegative(),
        total_skills: z.number().int().positive(),
        covered: z.number().int().nonnegative(),
        partial: z.number().int().nonnegative(),
        planned: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const skillProgressInputSchema = z
  .object({
    skillId: identifier,
    stage: z.enum(CONTENT_PROGRESS_STAGES),
    masteryProbability: z.number().min(0).max(1).optional(),
  })
  .strict();

export class ContentParseError extends Error {
  readonly context: string;
  readonly issues: readonly string[];

  constructor(context: string, error: z.ZodError) {
    const issues = error.issues.map((issue) => {
      const location = issue.path.length ? `/${issue.path.join("/")}` : "/";
      return `${location}: ${issue.message}`;
    });
    super(`Invalid content in ${context}: ${issues.join("; ")}`);
    this.name = "ContentParseError";
    this.context = context;
    this.issues = issues;
  }
}

export function parseContentCatalog(value: unknown, context = "catalog.json"): ContentCatalog {
  const result = contentCatalogSchema.safeParse(value);
  if (!result.success) throw new ContentParseError(context, result.error);
  return result.data as ContentCatalog;
}

export function parseCourseManifest(value: unknown, context: string): CourseManifest {
  const result = courseManifestSchema.safeParse(value);
  if (!result.success) throw new ContentParseError(context, result.error);
  return result.data as CourseManifest;
}

export function parseRoadmapTrackManifest(
  value: unknown,
  context: string,
): RoadmapTrackManifest {
  const result = roadmapTrackManifestSchema.safeParse(value);
  if (!result.success) throw new ContentParseError(context, result.error);
  return result.data as RoadmapTrackManifest;
}
