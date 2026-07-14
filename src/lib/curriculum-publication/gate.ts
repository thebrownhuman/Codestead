import type { PoolClient } from "pg";

import { parseCourseManifest } from "@/lib/content/schema";
import type { AssessmentBank } from "@/lib/content/authored-types";
import { pool } from "@/lib/db/client";

import {
  allReviewDimensionsPassed,
  curriculumReleaseEvidenceSchema,
  curriculumReviewChecklistSchema,
} from "./contracts";
import { aggregateArtifactHash, hashCurriculumValue } from "./hash";

type Queryable = Pick<PoolClient, "query">;

export interface PublicationGateIssue {
  readonly code: string;
  readonly artifactKey?: string;
  readonly message: string;
}

export interface PublicationGateReport {
  readonly allowed: boolean;
  readonly courseVersionId: string;
  readonly targetStage: "beta" | "verified";
  readonly currentStage: string;
  readonly issues: readonly PublicationGateIssue[];
  readonly summary: {
    readonly promisedSkills: number;
    readonly artifacts: number;
    readonly approvedArtifacts: number;
    readonly codeItems: number;
    readonly runtimeLessons: number;
    readonly releaseEvidenceVersion: number | null;
  };
  readonly reportHash: string;
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function evaluateCurriculumPublicationGate(input: {
  readonly courseVersionId: string;
  readonly targetStage: "beta" | "verified";
  readonly client?: Queryable;
}): Promise<PublicationGateReport> {
  const client = input.client ?? pool;
  const issues: PublicationGateIssue[] = [];
  let truncated = false;
  const issue = (value: PublicationGateIssue) => {
    if (issues.length < 500) issues.push(value);
    else truncated = true;
  };
  const versionResult = await client.query<{
    id: string;
    stage: string;
    content_hash: string;
  }>(`select id, stage, content_hash from course_version where id = $1`, [input.courseVersionId]);
  const version = versionResult.rows[0];
  if (!version) {
    const report = {
      allowed: false,
      courseVersionId: input.courseVersionId,
      targetStage: input.targetStage,
      currentStage: "missing",
      issues: [{ code: "COURSE_VERSION_MISSING", message: "The publication candidate does not exist." }],
      summary: { promisedSkills: 0, artifacts: 0, approvedArtifacts: 0, codeItems: 0, runtimeLessons: 0, releaseEvidenceVersion: null },
    } as const;
    return { ...report, reportHash: hashCurriculumValue(report) };
  }
  if (input.targetStage === "beta" && version.stage !== "draft") {
    issue({ code: "INVALID_STAGE_TRANSITION", message: "Beta publication requires a draft course version." });
  }
  if (input.targetStage === "verified" && version.stage !== "beta") {
    issue({ code: "INVALID_STAGE_TRANSITION", message: "Verified promotion requires an existing beta version." });
  }
  const artifactsResult = await client.query<{
    id: string;
    artifact_key: string;
    artifact_type: string;
    skill_key: string | null;
    content: Record<string, unknown>;
    content_hash: string;
    publication_stage: string;
    review_status: string;
  }>(
    `select id, artifact_key, artifact_type, skill_key, content, content_hash,
            publication_stage, review_status
       from curriculum_artifact where course_version_id = $1
      order by artifact_key`,
    [input.courseVersionId],
  );
  const artifacts = artifactsResult.rows;
  for (const artifact of artifacts) {
    if (hashCurriculumValue(artifact.content) !== artifact.content_hash) {
      issue({ code: "ARTIFACT_HASH_MISMATCH", artifactKey: artifact.artifact_key, message: "The stored artifact content does not match its immutable hash." });
    }
    if (!["approved", "published"].includes(artifact.publication_stage)) {
      issue({ code: "ARTIFACT_STAGE_UNAPPROVED", artifactKey: artifact.artifact_key, message: "Every publication artifact must carry an approved or published immutable stage." });
    }
  }
  const aggregateHash = aggregateArtifactHash(artifacts.map((artifact) => ({
    artifactKey: artifact.artifact_key,
    artifactType: artifact.artifact_type,
    contentHash: artifact.content_hash,
  })));
  if (aggregateHash !== version.content_hash) {
    issue({ code: "CONTENT_HASH_MISMATCH", message: "The immutable artifact set does not match the candidate content hash." });
  }
  const manifestRows = artifacts.filter((artifact) => artifact.artifact_type === "course_manifest");
  if (manifestRows.length !== 1) {
    issue({ code: "MANIFEST_CARDINALITY", message: "Exactly one validated course manifest is required." });
  }
  let manifest: ReturnType<typeof parseCourseManifest> | null = null;
  if (manifestRows[0]) {
    try {
      manifest = parseCourseManifest(manifestRows[0].content, `curriculum_artifact:${manifestRows[0].artifact_key}`);
    } catch {
      issue({ code: "MANIFEST_INVALID", artifactKey: manifestRows[0].artifact_key, message: "The stored course manifest no longer satisfies the authoritative schema." });
    }
  }
  const promisedSkills = manifest?.modules.flatMap((courseModule) => courseModule.skills) ?? [];
  const skillIds = promisedSkills.map((skill) => skill.id);
  const lessonArtifacts = artifacts.filter((artifact) => artifact.artifact_type === "authored_lesson");
  const bankArtifacts = artifacts.filter((artifact) => artifact.artifact_type === "assessment_bank");
  for (const skillId of skillIds) {
    if (lessonArtifacts.filter((artifact) => artifact.skill_key === skillId).length !== 1) {
      issue({ code: "LESSON_COVERAGE_MISSING", artifactKey: skillId, message: "Every promised skill requires exactly one immutable authored lesson." });
    }
    if (bankArtifacts.filter((artifact) => artifact.skill_key === skillId).length !== 1) {
      issue({ code: "BANK_COVERAGE_MISSING", artifactKey: skillId, message: "Every promised skill requires exactly one deterministic assessment bank." });
    }
  }
  const reviewsResult = await client.query<{
    artifact_id: string;
    reviewer_kind: string;
    decision: string;
    content_hash: string;
    checklist: Record<string, unknown>;
    reviewed_item_ids: string[];
  }>(
    `select distinct on (artifact_id) artifact_id, reviewer_kind, decision, content_hash,
            checklist, reviewed_item_ids
      from curriculum_review_event
      where artifact_id = any($1::uuid[])
      order by artifact_id, resulting_version desc, id desc`,
    [artifacts.map((artifact) => artifact.id)],
  );
  const reviews = new Map(reviewsResult.rows.map((review) => [review.artifact_id, review]));
  let approvedArtifacts = 0;
  const codeItems: Array<{ id: string; artifactKey: string }> = [];
  for (const artifact of artifacts) {
    const review = reviews.get(artifact.id);
    if (artifact.review_status !== "approved" || review?.decision !== "approved" || review.reviewer_kind !== "human") {
      issue({ code: "HUMAN_REVIEW_MISSING", artifactKey: artifact.artifact_key, message: "The latest bound review must be an attributable human approval." });
      continue;
    }
    if (review.content_hash !== artifact.content_hash) {
      issue({ code: "REVIEW_HASH_MISMATCH", artifactKey: artifact.artifact_key, message: "The review is not bound to this immutable artifact hash." });
      continue;
    }
    const checklist = curriculumReviewChecklistSchema.safeParse(review.checklist);
    if (!checklist.success || !allReviewDimensionsPassed(checklist.data)) {
      issue({ code: "REVIEW_CHECKLIST_INCOMPLETE", artifactKey: artifact.artifact_key, message: "All seven review dimensions require passing evidence." });
      continue;
    }
    const expectedItems = artifact.artifact_type === "assessment_bank"
      ? ((artifact.content.items as Array<{ id?: unknown }> | undefined) ?? []).map((item) => typeof item.id === "string" ? item.id : "").filter(Boolean)
      : [artifact.artifact_key];
    if (!exactSet(review.reviewed_item_ids, expectedItems)) {
      issue({ code: "ITEM_REVIEW_INCOMPLETE", artifactKey: artifact.artifact_key, message: "Every item in the immutable artifact must be explicitly reviewed." });
      continue;
    }
    if (artifact.artifact_type !== "course_manifest") {
      const publication = object(artifact.content.publication);
      const reviewer = object(publication?.reviewer);
      if (
        !publication
        || !["approved", "published"].includes(String(publication.stage))
        || reviewer?.kind !== "human"
      ) {
        issue({ code: "AUTHORED_PUBLICATION_UNREVIEWED", artifactKey: artifact.artifact_key, message: "The authored file itself must carry human-reviewed approved publication metadata." });
        continue;
      }
    }
    if (artifact.artifact_type === "assessment_bank") {
      const bank = artifact.content as unknown as AssessmentBank;
      for (const item of bank.items ?? []) {
        if (!item.examEligibility?.eligible) {
          issue({ code: "ITEM_EXAM_INELIGIBLE", artifactKey: item.id, message: "Published deterministic banks cannot contain an exam-ineligible item." });
        }
        if (item.kind === "code") codeItems.push({ id: item.id, artifactKey: artifact.artifact_key });
      }
    }
    approvedArtifacts += 1;
  }
  const runtimeLessonsResult = await client.query<{
    slug: string;
    content_status: string;
    block_count: string | number;
  }>(
    `select l.slug, l.content_status, count(lb.id) as block_count
       from lesson l
       join course_module m on m.id = l.module_id
       left join lesson_block lb on lb.lesson_id = l.id
      where m.course_version_id = $1
      group by l.id, l.slug, l.content_status`,
    [input.courseVersionId],
  );
  const runtimeLessons = new Map(runtimeLessonsResult.rows.map((row) => [row.slug, row]));
  for (const skillId of skillIds) {
    const runtime = runtimeLessons.get(skillId);
    if (!runtime || Number(runtime.block_count) < 1) {
      issue({ code: "RUNTIME_LESSON_MISSING", artifactKey: skillId, message: "Every promised skill requires a materialized runtime lesson with at least one block." });
    } else if (input.targetStage === "verified" ? runtime.content_status !== "verified" : !["beta", "verified"].includes(runtime.content_status)) {
      issue({ code: "RUNTIME_LESSON_STAGE", artifactKey: skillId, message: "The runtime lesson stage does not meet the publication target." });
    }
  }
  const bundleResult = await client.query<{
    item_id: string | null;
    harness_hash: string | null;
    runtime_image_digest: string | null;
    verified_at: Date | null;
  }>(
    `select a.specification->>'authoredItemId' as item_id,
            tb.harness_hash, tb.runtime_image_digest, tb.verified_at
       from activity a
       join lesson l on l.id = a.lesson_id
       join course_module m on m.id = l.module_id
       left join lateral (
         select harness_hash, runtime_image_digest, verified_at
           from test_bundle where activity_id = a.id
          order by verified_at desc nulls last, created_at desc limit 1
       ) tb on true
      where m.course_version_id = $1`,
    [input.courseVersionId],
  );
  const bundleByItem = new Map(bundleResult.rows.filter((row) => row.item_id).map((row) => [row.item_id!, row]));
  for (const item of codeItems) {
    const bundle = bundleByItem.get(item.id);
    if (
      !bundle?.verified_at
      || !/^[0-9a-f]{64}$/.test(bundle.harness_hash ?? "")
      || !/^sha256:[0-9a-f]{64}$/.test(bundle.runtime_image_digest ?? "")
    ) {
      issue({ code: "EXECUTION_EVIDENCE_MISSING", artifactKey: item.id, message: "Every code item requires a verified test bundle, harness hash, and pinned runtime image digest." });
    }
  }
  const releaseResult = await client.query<{
    evidence_version: string | number;
    content_hash: string;
    evidence: Record<string, unknown>;
    evidence_hash: string;
  }>(
    `select evidence_version, content_hash, evidence, evidence_hash
       from curriculum_release_evidence where course_version_id = $1
      order by evidence_version desc limit 1`,
    [input.courseVersionId],
  );
  const releaseRow = releaseResult.rows[0];
  const release = curriculumReleaseEvidenceSchema.safeParse(releaseRow?.evidence);
  if (!releaseRow || !release.success) {
    issue({ code: "RELEASE_EVIDENCE_MISSING", message: "A valid signed release evidence bundle is required." });
  } else {
    if (
      releaseRow.content_hash !== version.content_hash
      || hashCurriculumValue(release.data) !== releaseRow.evidence_hash
    ) {
      issue({ code: "RELEASE_EVIDENCE_HASH_MISMATCH", message: "Release evidence is not bound to this immutable course version." });
    }
    const expectedSources = promisedSkills.flatMap((skill) => skill.source_refs);
    if (!exactSet(release.data.sourceCoverage.sourceRefs, expectedSources)) issue({ code: "SOURCE_COVERAGE_MISMATCH", message: "Source evidence does not cover every promised source reference." });
    if (!exactSet(release.data.skillCoverage.skillIds, skillIds)) issue({ code: "SKILL_COVERAGE_MISMATCH", message: "Skill coverage evidence does not exactly match the promised manifest." });
    if (!exactSet(release.data.skillCoverage.lessonArtifactKeys, lessonArtifacts.map((artifact) => artifact.artifact_key))) issue({ code: "LESSON_EVIDENCE_MISMATCH", message: "Lesson coverage evidence does not match the immutable artifact set." });
    if (!exactSet(release.data.skillCoverage.assessmentBankArtifactKeys, bankArtifacts.map((artifact) => artifact.artifact_key))) issue({ code: "BANK_EVIDENCE_MISMATCH", message: "Assessment coverage evidence does not match the immutable artifact set." });
    if (!exactSet(release.data.codeExecution.executedItemIds, codeItems.map((item) => item.id))) issue({ code: "EXECUTION_REPORT_MISMATCH", message: "Execution evidence does not exactly cover every code item." });
    const dbRuntimeDigests = codeItems.map((item) => bundleByItem.get(item.id)?.runtime_image_digest ?? "").filter(Boolean);
    if (!exactSet(release.data.codeExecution.runtimeImageDigests, dbRuntimeDigests)) issue({ code: "RUNTIME_DIGEST_MISMATCH", message: "Execution evidence runtime digests do not match verified test bundles." });
  }
  if (truncated) issues.push({ code: "ISSUES_TRUNCATED", message: "Additional publication blockers were omitted from this bounded response." });
  const reportWithoutHash = {
    allowed: issues.length === 0,
    courseVersionId: input.courseVersionId,
    targetStage: input.targetStage,
    currentStage: version.stage,
    issues,
    summary: {
      promisedSkills: skillIds.length,
      artifacts: artifacts.length,
      approvedArtifacts,
      codeItems: codeItems.length,
      runtimeLessons: runtimeLessons.size,
      releaseEvidenceVersion: releaseRow ? Number(releaseRow.evidence_version) : null,
    },
  };
  return { ...reportWithoutHash, reportHash: hashCurriculumValue(reportWithoutHash) };
}
