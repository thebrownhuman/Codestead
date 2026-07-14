import {
  parseAssessmentBank,
  parseCourseManifest,
  type AssessmentBank,
  type CourseManifest,
  type CourseModule,
} from "@/lib/content";
import { pool } from "@/lib/db/client";

import { aggregateArtifactHash, hashCurriculumValue } from "./hash";

interface RuntimeArtifactRow {
  readonly pointer_course_id: string;
  readonly version_course_id: string;
  readonly course_slug: string;
  readonly course_version_id: string;
  readonly course_version: string;
  readonly course_stage: string;
  readonly version_content_hash: string;
  readonly approved_by: string | null;
  readonly published_at: Date | null;
  readonly publication_event_exists: boolean;
  readonly release_evidence_exists: boolean;
  readonly artifact_key: string | null;
  readonly artifact_type: "course_manifest" | "authored_lesson" | "assessment_bank" | null;
  readonly skill_key: string | null;
  readonly content: Record<string, unknown> | null;
  readonly content_hash: string | null;
  readonly publication_stage: string | null;
  readonly review_status: string | null;
  readonly review_event_exists: boolean;
}

export interface PublishedExamCourse {
  readonly courseVersionId: string;
  readonly course: CourseManifest;
  readonly assessmentBanks: readonly AssessmentBank[];
}

export interface PublishedExamModule extends PublishedExamCourse {
  readonly module: CourseModule;
}

/**
 * Raised when the current publication pointer resolves to content that no
 * longer reproduces its immutable publication record. Formal assessment must
 * fail closed rather than silently fall back to a draft filesystem bank.
 */
export class PublishedCurriculumRuntimeError extends Error {
  constructor(readonly code: string) {
    super("The current reviewed curriculum publication could not be verified.");
    this.name = "PublishedCurriculumRuntimeError";
  }
}

function invalid(code: string): never {
  throw new PublishedCurriculumRuntimeError(code);
}

function materializePublishedCourse(rows: readonly RuntimeArtifactRow[]): PublishedExamCourse {
  const first = rows[0];
  if (!first) invalid("PUBLICATION_EMPTY");
  if (
    first.pointer_course_id !== first.version_course_id ||
    !["beta", "verified"].includes(first.course_stage) ||
    first.approved_by === null ||
    first.published_at === null ||
    !first.publication_event_exists ||
    !first.release_evidence_exists ||
    rows.some((row) =>
      row.artifact_key === null ||
      row.artifact_type === null ||
      row.content === null ||
      row.content_hash === null ||
      !row.review_event_exists
    )
  ) invalid("PUBLICATION_POINTER_INVALID");
  if (!rows.every((row) =>
    row.course_version_id === first.course_version_id &&
    row.course_stage === first.course_stage &&
    row.version_content_hash === first.version_content_hash
  )) invalid("PUBLICATION_VERSION_MIXED");
  if (!rows.every((row) =>
    row.review_status === "approved" &&
    (row.publication_stage === "approved" || row.publication_stage === "published") &&
    hashCurriculumValue(row.content!) === row.content_hash
  )) invalid("PUBLICATION_ARTIFACT_UNVERIFIED");

  const aggregateHash = aggregateArtifactHash(rows.map((row) => ({
    artifactKey: row.artifact_key!,
    artifactType: row.artifact_type!,
    contentHash: row.content_hash!,
  })));
  if (aggregateHash !== first.version_content_hash) invalid("PUBLICATION_HASH_MISMATCH");

  const manifests = rows.filter((row) => row.artifact_type === "course_manifest");
  if (manifests.length !== 1) invalid("PUBLICATION_MANIFEST_CARDINALITY");
  let course: CourseManifest;
  try {
    course = parseCourseManifest(
      manifests[0]!.content!,
      `curriculum_artifact:${manifests[0]!.artifact_key}`,
    );
  } catch {
    invalid("PUBLICATION_MANIFEST_INVALID");
  }
  if (
    course.id !== first.course_slug ||
    course.version !== first.course_version ||
    !["beta", "verified"].includes(course.status)
  ) invalid("PUBLICATION_MANIFEST_IDENTITY_MISMATCH");

  const assessmentBanks: AssessmentBank[] = [];
  for (const row of rows.filter((candidate) => candidate.artifact_type === "assessment_bank")) {
    let bank: AssessmentBank;
    try {
      bank = parseAssessmentBank(row.content!, `curriculum_artifact:${row.artifact_key}`);
    } catch {
      invalid("PUBLICATION_BANK_INVALID");
    }
    if (
      bank.courseId !== course.id ||
      bank.courseVersion !== course.version ||
      row.skill_key !== bank.skillId ||
      bank.publication.stage !== "approved" ||
      bank.publication.reviewer?.kind !== "human" ||
      bank.items.some((item) => !item.examEligibility.eligible)
    ) invalid("PUBLICATION_BANK_UNREVIEWED");
    assessmentBanks.push(bank);
  }

  const promisedSkills = course.modules.flatMap((courseModule) =>
    courseModule.skills.map((skill) => skill.id)
  );
  if (promisedSkills.some((skillId) =>
    assessmentBanks.filter((bank) => bank.skillId === skillId).length !== 1
  )) invalid("PUBLICATION_BANK_COVERAGE_MISMATCH");

  return {
    courseVersionId: first.course_version_id,
    course,
    assessmentBanks,
  };
}

/** Returns only immutable, pointer-selected, independently reviewed courses. */
export async function listPublishedExamCourses(): Promise<readonly PublishedExamCourse[]> {
  const result = await pool.query<RuntimeArtifactRow>(`
    select cpp.course_id as pointer_course_id,
           cv.course_id as version_course_id,
           c.slug as course_slug,
           cv.id as course_version_id,
           cv.version as course_version,
           cv.stage as course_stage,
           cv.content_hash as version_content_hash,
           cv.approved_by,
           cv.published_at,
           exists (
             select 1 from curriculum_publication_event cpe
              where cpe.course_version_id = cv.id
                and cpe.event in ('published_beta', 'promoted_verified')
           ) as publication_event_exists,
           exists (
             select 1 from curriculum_release_evidence cre
              where cre.course_version_id = cv.id
                and cre.content_hash = cv.content_hash
           ) as release_evidence_exists,
           ca.artifact_key,
           ca.artifact_type,
           ca.skill_key,
           ca.content,
           ca.content_hash,
           ca.publication_stage,
           ca.review_status,
           exists (
             select 1 from curriculum_review_event crv
              where crv.artifact_id = ca.id
                and crv.reviewer_kind = 'human'
                and crv.decision = 'approved'
                and crv.content_hash = ca.content_hash
           ) as review_event_exists
      from curriculum_publication_pointer cpp
      join course c on c.id = cpp.course_id
      join course_version cv on cv.id = cpp.current_course_version_id
      left join curriculum_artifact ca on ca.course_version_id = cv.id
     order by c.slug, ca.artifact_key
  `);
  const byVersion = new Map<string, RuntimeArtifactRow[]>();
  for (const row of result.rows) {
    const rows = byVersion.get(row.course_version_id) ?? [];
    rows.push(row);
    byVersion.set(row.course_version_id, rows);
  }
  return [...byVersion.values()].map(materializePublishedCourse);
}

export async function loadPublishedExamModule(
  moduleId: string,
): Promise<PublishedExamModule | null> {
  for (const publication of await listPublishedExamCourses()) {
    const courseModule = publication.course.modules.find((candidate) => candidate.id === moduleId);
    if (courseModule) return { ...publication, module: courseModule };
  }
  return null;
}
