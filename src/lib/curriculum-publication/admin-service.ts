import type { PoolClient } from "pg";

import type { AssessmentBank } from "@/lib/content/authored-types";
import { pool } from "@/lib/db/client";

import {
  allReviewDimensionsPassed,
  curriculumReleaseEvidenceSchema,
  curriculumReviewChecklistSchema,
  type CurriculumReleaseEvidence,
  type CurriculumReviewChecklist,
  type CurriculumReviewDecision,
} from "./contracts";
import { evaluateCurriculumPublicationGate, type PublicationGateReport } from "./gate";
import { hashCurriculumValue } from "./hash";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CurriculumAdminError extends Error {
  constructor(
    public readonly code:
      | "ADMIN_REQUIRED"
      | "NOT_FOUND"
      | "INVALID_REQUEST"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_MISMATCH"
      | "HUMAN_APPROVAL_BLOCKED"
      | "PUBLICATION_GATE_BLOCKED"
      | "INVALID_STAGE_TRANSITION"
      | "CURRENT_VERSION_CANNOT_RETIRE"
      | "ROLLBACK_TARGET_INVALID"
      | "WRITE_CONFLICT",
    public readonly gate?: PublicationGateReport,
  ) {
    super(code);
  }
}

async function assertAdmin(client: PoolClient, actorUserId: string): Promise<void> {
  const actor = await client.query<{ role: string | null; status: string }>(
    `select role, status from "user" where id = $1 for update`,
    [actorUserId],
  );
  if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
    throw new CurriculumAdminError("ADMIN_REQUIRED");
  }
}

function validateCommon(input: { requestId: string; expectedVersion: number; reason: string; now: Date }) {
  if (
    !UUID_PATTERN.test(input.requestId)
    || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 1
    || input.reason.trim().length < 20
    || input.reason.trim().length > 2_000
    || !Number.isFinite(input.now.getTime())
  ) throw new CurriculumAdminError("INVALID_REQUEST");
}

function exactSet(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort());
}

function embeddedHumanApproval(artifactType: string, content: Record<string, unknown>): boolean {
  if (artifactType === "course_manifest") return true;
  const publication = content.publication as { stage?: unknown; reviewer?: { kind?: unknown } | null } | undefined;
  return Boolean(
    publication
    && ["approved", "published"].includes(String(publication.stage))
    && publication.reviewer?.kind === "human",
  );
}

function expectedReviewItemIds(artifact: {
  artifact_key: string;
  artifact_type: string;
  content: Record<string, unknown>;
}): string[] {
  if (artifact.artifact_type !== "assessment_bank") return [artifact.artifact_key];
  const items = (artifact.content.items ?? []) as Array<{ id?: unknown }>;
  return items.map((item) => typeof item.id === "string" ? item.id : "").filter(Boolean);
}

export async function listCurriculumCandidates() {
  const result = await pool.query<{
    id: string;
    course_id: string;
    course_slug: string;
    title: string;
    version: string;
    stage: string;
    publication_revision: string | number;
    content_hash: string;
    artifact_count: string | number;
    ai_assisted_count: string | number;
    approved_count: string | number;
    unreviewed_count: string | number;
    evidence_version: string | number | null;
    pointer_version: string | number | null;
    is_current: boolean;
    updated_at: Date;
  }>(
    `select cv.id, cv.course_id, c.slug as course_slug, c.title, cv.version, cv.stage,
            cv.publication_revision, cv.content_hash, cv.updated_at,
            count(ca.id)::int as artifact_count,
            count(ca.id) filter (where ca.ai_assisted)::int as ai_assisted_count,
            count(ca.id) filter (where ca.review_status = 'approved')::int as approved_count,
            count(ca.id) filter (where ca.review_status <> 'approved')::int as unreviewed_count,
            (select max(cre.evidence_version) from curriculum_release_evidence cre where cre.course_version_id = cv.id) as evidence_version,
            cpp.row_version as pointer_version,
            coalesce(cpp.current_course_version_id = cv.id, false) as is_current
       from course_version cv
       join course c on c.id = cv.course_id
       left join curriculum_artifact ca on ca.course_version_id = cv.id
       left join curriculum_publication_pointer cpp on cpp.course_id = cv.course_id
      group by cv.id, c.id, cpp.course_id, cpp.current_course_version_id, cpp.row_version
      order by cv.updated_at desc, c.slug, cv.version`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseSlug: row.course_slug,
    title: row.title,
    version: row.version,
    stage: row.stage,
    publicationRevision: Number(row.publication_revision),
    contentHash: row.content_hash,
    artifactCount: Number(row.artifact_count),
    aiAssistedCount: Number(row.ai_assisted_count),
    approvedCount: Number(row.approved_count),
    unreviewedCount: Number(row.unreviewed_count),
    evidenceVersion: row.evidence_version === null ? null : Number(row.evidence_version),
    pointerVersion: row.pointer_version === null ? null : Number(row.pointer_version),
    isCurrent: row.is_current,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * A cross-course editorial queue. The per-version artifact endpoint remains
 * useful for publication work, but administrators also need one place where
 * every staged artifact that still requires a decision is discoverable.
 */
export async function listCurriculumReviewQueue() {
  const result = await pool.query<{
    id: string;
    course_version_id: string;
    course_slug: string;
    course_title: string;
    course_version: string;
    course_stage: string;
    artifact_key: string;
    artifact_type: string;
    source_path: string;
    publication_stage: string;
    ai_assisted: boolean;
    review_status: string;
    row_version: string | number;
    updated_at: Date;
  }>(
    `select ca.id, ca.course_version_id, c.slug as course_slug, c.title as course_title,
            cv.version as course_version, cv.stage as course_stage,
            ca.artifact_key, ca.artifact_type, ca.source_path,
            ca.publication_stage, ca.ai_assisted, ca.review_status,
            ca.row_version, ca.updated_at
       from curriculum_artifact ca
       join course_version cv on cv.id = ca.course_version_id
       join course c on c.id = cv.course_id
      where ca.review_status <> 'approved'
        and cv.stage <> 'retired'
      order by case ca.review_status
                 when 'unreviewed' then 0
                 when 'in_review' then 1
                 when 'changes_requested' then 2
                 when 'rejected' then 3
                 else 4
               end,
               c.slug, cv.version,
               case ca.artifact_type when 'course_manifest' then 0 when 'authored_lesson' then 1 else 2 end,
               ca.artifact_key`,
  );
  const items = result.rows.map((row) => ({
    id: row.id,
    courseVersionId: row.course_version_id,
    courseSlug: row.course_slug,
    courseTitle: row.course_title,
    courseVersion: row.course_version,
    courseStage: row.course_stage,
    artifactKey: row.artifact_key,
    artifactType: row.artifact_type,
    sourcePath: row.source_path,
    publicationStage: row.publication_stage,
    aiAssisted: row.ai_assisted,
    reviewStatus: row.review_status,
    rowVersion: Number(row.row_version),
    updatedAt: row.updated_at.toISOString(),
  }));
  const statusCounts = new Map<string, number>();
  const courseCounts = new Map<string, {
    courseVersionId: string;
    courseSlug: string;
    courseTitle: string;
    courseVersion: string;
    count: number;
  }>();
  for (const item of items) {
    statusCounts.set(item.reviewStatus, (statusCounts.get(item.reviewStatus) ?? 0) + 1);
    const course = courseCounts.get(item.courseVersionId);
    if (course) course.count += 1;
    else courseCounts.set(item.courseVersionId, {
      courseVersionId: item.courseVersionId,
      courseSlug: item.courseSlug,
      courseTitle: item.courseTitle,
      courseVersion: item.courseVersion,
      count: 1,
    });
  }
  return {
    total: items.length,
    courseCount: courseCounts.size,
    statusCounts: [...statusCounts].map(([status, count]) => ({ status, count })),
    courseCounts: [...courseCounts.values()],
    items,
  };
}

export async function listCurriculumArtifacts(courseVersionId: string) {
  if (!UUID_PATTERN.test(courseVersionId)) throw new CurriculumAdminError("NOT_FOUND");
  const result = await pool.query<{
    id: string;
    artifact_key: string;
    artifact_type: string;
    skill_key: string | null;
    source_path: string;
    content_hash: string;
    publication_stage: string;
    ai_assisted: boolean;
    review_status: string;
    row_version: string | number;
    updated_at: Date;
  }>(
    `select id, artifact_key, artifact_type, skill_key, source_path, content_hash,
            publication_stage, ai_assisted, review_status, row_version, updated_at
       from curriculum_artifact where course_version_id = $1
      order by case artifact_type when 'course_manifest' then 0 when 'authored_lesson' then 1 else 2 end,
               artifact_key`,
    [courseVersionId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    artifactKey: row.artifact_key,
    artifactType: row.artifact_type,
    skillKey: row.skill_key,
    sourcePath: row.source_path,
    contentHash: row.content_hash,
    publicationStage: row.publication_stage,
    aiAssisted: row.ai_assisted,
    reviewStatus: row.review_status,
    rowVersion: Number(row.row_version),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function getCurriculumArtifactDetail(artifactId: string) {
  if (!UUID_PATTERN.test(artifactId)) throw new CurriculumAdminError("NOT_FOUND");
  const main = await pool.query<{
    id: string;
    course_version_id: string;
    course_slug: string;
    course_title: string;
    version: string;
    publication_revision: string | number;
    artifact_key: string;
    artifact_type: string;
    skill_key: string | null;
    source_path: string;
    content: Record<string, unknown>;
    content_hash: string;
    publication_stage: string;
    ai_assisted: boolean;
    provenance: Record<string, unknown>;
    review_status: string;
    row_version: string | number;
  }>(
    `select ca.id, ca.course_version_id, c.slug as course_slug, c.title as course_title,
            cv.version, cv.publication_revision, ca.artifact_key, ca.artifact_type,
            ca.skill_key, ca.source_path, ca.content, ca.content_hash,
            ca.publication_stage, ca.ai_assisted, ca.provenance,
            ca.review_status, ca.row_version
       from curriculum_artifact ca
       join course_version cv on cv.id = ca.course_version_id
       join course c on c.id = cv.course_id
      where ca.id = $1`,
    [artifactId],
  );
  const row = main.rows[0];
  if (!row) throw new CurriculumAdminError("NOT_FOUND");
  const timeline = await pool.query<{
    id: string;
    reviewer_user_id: string;
    reviewer_name: string;
    reviewer_kind: string;
    decision: string;
    content_hash: string;
    checklist: Record<string, unknown>;
    reviewed_item_ids: string[];
    reason: string;
    resulting_version: string | number;
    occurred_at: Date;
  }>(
    `select e.id, e.reviewer_user_id, u.name as reviewer_name, e.reviewer_kind,
            e.decision, e.content_hash, e.checklist, e.reviewed_item_ids,
            e.reason, e.resulting_version, e.occurred_at
       from curriculum_review_event e join "user" u on u.id = e.reviewer_user_id
      where e.artifact_id = $1 order by e.occurred_at asc, e.id asc`,
    [artifactId],
  );
  return {
    artifact: {
      id: row.id,
      courseVersionId: row.course_version_id,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      courseVersion: row.version,
      publicationRevision: Number(row.publication_revision),
      artifactKey: row.artifact_key,
      artifactType: row.artifact_type,
      skillKey: row.skill_key,
      sourcePath: row.source_path,
      content: row.content,
      contentHash: row.content_hash,
      contentHashValid: hashCurriculumValue(row.content) === row.content_hash,
      publicationStage: row.publication_stage,
      aiAssisted: row.ai_assisted,
      provenance: row.provenance,
      reviewStatus: row.review_status,
      rowVersion: Number(row.row_version),
      expectedReviewItemIds: expectedReviewItemIds(row),
      embeddedHumanApproval: embeddedHumanApproval(row.artifact_type, row.content),
    },
    timeline: timeline.rows.map((event) => ({
      id: event.id,
      reviewerUserId: event.reviewer_user_id,
      reviewerName: event.reviewer_name,
      reviewerKind: event.reviewer_kind,
      decision: event.decision,
      contentHash: event.content_hash,
      checklist: event.checklist,
      reviewedItemIds: event.reviewed_item_ids,
      reason: event.reason,
      resultingVersion: Number(event.resulting_version),
      occurredAt: event.occurred_at.toISOString(),
    })),
  };
}

export async function reviewCurriculumArtifact(input: {
  actorUserId: string;
  artifactId: string;
  requestId: string;
  expectedVersion: number;
  decision: CurriculumReviewDecision;
  checklist: CurriculumReviewChecklist;
  reviewedItemIds: readonly string[];
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  validateCommon({ ...input, reason, now });
  const checklist = curriculumReviewChecklistSchema.safeParse(input.checklist);
  if (!checklist.success || !UUID_PATTERN.test(input.artifactId)) throw new CurriculumAdminError("INVALID_REQUEST");
  const reviewedItemIds = [...new Set(input.reviewedItemIds.map((item) => item.trim()).filter(Boolean))].sort();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdmin(client, input.actorUserId);
    const artifactResult = await client.query<{
      id: string;
      course_version_id: string;
      artifact_key: string;
      artifact_type: string;
      content: Record<string, unknown>;
      content_hash: string;
      row_version: string | number;
    }>(`select id, course_version_id, artifact_key, artifact_type, content, content_hash, row_version from curriculum_artifact where id = $1 for update`, [input.artifactId]);
    const artifact = artifactResult.rows[0];
    if (!artifact) throw new CurriculumAdminError("NOT_FOUND");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`curriculum-version:${artifact.course_version_id}`]);
    const prior = await client.query<{
      reviewer_user_id: string;
      decision: string;
      checklist: Record<string, unknown>;
      reviewed_item_ids: string[];
      reason: string;
      resulting_version: string | number;
    }>(`select reviewer_user_id, decision, checklist, reviewed_item_ids, reason, resulting_version from curriculum_review_event where artifact_id = $1 and request_id = $2`, [input.artifactId, input.requestId]);
    if (prior.rows[0]) {
      const event = prior.rows[0];
      if (
        event.reviewer_user_id !== input.actorUserId
        || event.decision !== input.decision
        || event.reason !== reason
        || hashCurriculumValue(event.checklist) !== hashCurriculumValue(checklist.data)
        || !exactSet(event.reviewed_item_ids, reviewedItemIds)
      ) throw new CurriculumAdminError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return { artifactId: input.artifactId, decision: input.decision, rowVersion: Number(event.resulting_version), replayed: true } as const;
    }
    if (Number(artifact.row_version) !== input.expectedVersion) throw new CurriculumAdminError("VERSION_CONFLICT");
    const expectedItems = expectedReviewItemIds(artifact);
    if (input.decision === "approved") {
      const bank = artifact.artifact_type === "assessment_bank" ? artifact.content as unknown as AssessmentBank : null;
      if (
        hashCurriculumValue(artifact.content) !== artifact.content_hash
        || !allReviewDimensionsPassed(checklist.data)
        || !exactSet(reviewedItemIds, expectedItems)
        || !embeddedHumanApproval(artifact.artifact_type, artifact.content)
        || bank?.items.some((item) => !item.examEligibility.eligible)
      ) throw new CurriculumAdminError("HUMAN_APPROVAL_BLOCKED");
    }
    const resultingVersion = input.expectedVersion + 1;
    await client.query(
      `insert into curriculum_review_event
        (artifact_id, reviewer_user_id, reviewer_kind, decision, request_id,
         content_hash, checklist, reviewed_item_ids, reason, resulting_version, occurred_at)
       values ($1, $2, 'human', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
      [input.artifactId, input.actorUserId, input.decision, input.requestId, artifact.content_hash, JSON.stringify(checklist.data), JSON.stringify(reviewedItemIds), reason, resultingVersion, now],
    );
    const updated = await client.query(
      `update curriculum_artifact set review_status = $2, row_version = row_version + 1, updated_at = $3
        where id = $1 and row_version = $4`,
      [input.artifactId, input.decision, now, input.expectedVersion],
    );
    if (updated.rowCount !== 1) throw new CurriculumAdminError("WRITE_CONFLICT");
    await client.query("commit");
    return { artifactId: input.artifactId, decision: input.decision, rowVersion: resultingVersion, replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function submitCurriculumReleaseEvidence(input: {
  actorUserId: string;
  courseVersionId: string;
  requestId: string;
  expectedVersion: number;
  evidence: CurriculumReleaseEvidence;
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  validateCommon({ ...input, reason, now });
  const evidence = curriculumReleaseEvidenceSchema.safeParse(input.evidence);
  if (!evidence.success || !UUID_PATTERN.test(input.courseVersionId)) throw new CurriculumAdminError("INVALID_REQUEST");
  const evidenceHash = hashCurriculumValue(evidence.data);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdmin(client, input.actorUserId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`curriculum-version:${input.courseVersionId}`]);
    const versionResult = await client.query<{
      course_id: string; content_hash: string; publication_revision: string | number;
    }>(`select course_id, content_hash, publication_revision from course_version where id = $1 for update`, [input.courseVersionId]);
    const version = versionResult.rows[0];
    if (!version) throw new CurriculumAdminError("NOT_FOUND");
    const prior = await client.query<{
      submitted_by: string; evidence: Record<string, unknown>; evidence_hash: string; evidence_version: string | number; reason: string;
    }>(`select cre.submitted_by, cre.evidence, cre.evidence_hash, cre.evidence_version, cpe.reason
          from curriculum_release_evidence cre
          join curriculum_publication_event cpe
            on cpe.course_version_id = cre.course_version_id and cpe.request_id = cre.request_id
         where cre.course_version_id = $1 and cre.request_id = $2`, [input.courseVersionId, input.requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].submitted_by !== input.actorUserId || prior.rows[0].evidence_hash !== evidenceHash || prior.rows[0].reason !== reason) throw new CurriculumAdminError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return { courseVersionId: input.courseVersionId, evidenceVersion: Number(prior.rows[0].evidence_version), publicationRevision: Number(version.publication_revision), replayed: true } as const;
    }
    if (Number(version.publication_revision) !== input.expectedVersion) throw new CurriculumAdminError("VERSION_CONFLICT");
    const latest = await client.query<{ version: string | number }>(`select coalesce(max(evidence_version), 0) + 1 as version from curriculum_release_evidence where course_version_id = $1`, [input.courseVersionId]);
    const evidenceVersion = Number(latest.rows[0]?.version ?? 1);
    await client.query(
      `insert into curriculum_release_evidence
        (course_version_id, submitted_by, request_id, evidence_version, content_hash, evidence, evidence_hash, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [input.courseVersionId, input.actorUserId, input.requestId, evidenceVersion, version.content_hash, JSON.stringify(evidence.data), evidenceHash, now],
    );
    const eventEvidence = { evidenceVersion, evidenceHash, contentHash: version.content_hash };
    await client.query(
      `insert into curriculum_publication_event
        (course_id, course_version_id, actor_user_id, event, request_id, reason, evidence, evidence_hash, occurred_at)
       values ($1, $2, $3, 'evidence_submitted', $4, $5, $6::jsonb, $7, $8)`,
      [version.course_id, input.courseVersionId, input.actorUserId, input.requestId, reason, JSON.stringify(eventEvidence), hashCurriculumValue(eventEvidence), now],
    );
    await client.query(`update course_version set publication_revision = publication_revision + 1, updated_at = $2 where id = $1`, [input.courseVersionId, now]);
    await client.query("commit");
    return { courseVersionId: input.courseVersionId, evidenceVersion, publicationRevision: input.expectedVersion + 1, replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function publishCurriculumVersion(input: {
  actorUserId: string;
  courseVersionId: string;
  requestId: string;
  expectedVersion: number;
  targetStage: "beta" | "verified";
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  validateCommon({ ...input, reason, now });
  if (!UUID_PATTERN.test(input.courseVersionId)) throw new CurriculumAdminError("INVALID_REQUEST");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdmin(client, input.actorUserId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`curriculum-version:${input.courseVersionId}`]);
    const versionResult = await client.query<{
      course_id: string; stage: string; publication_revision: string | number;
    }>(`select course_id, stage, publication_revision from course_version where id = $1 for update`, [input.courseVersionId]);
    const version = versionResult.rows[0];
    if (!version) throw new CurriculumAdminError("NOT_FOUND");
    const eventName = input.targetStage === "beta" ? "published_beta" : "promoted_verified";
    const prior = await client.query<{ actor_user_id: string; event: string; reason: string; evidence: Record<string, unknown> }>(
      `select actor_user_id, event, reason, evidence from curriculum_publication_event where course_id = $1 and request_id = $2`,
      [version.course_id, input.requestId],
    );
    if (prior.rows[0]) {
      const event = prior.rows[0];
      if (event.actor_user_id !== input.actorUserId || event.event !== eventName || event.reason !== reason || event.evidence.targetStage !== input.targetStage) throw new CurriculumAdminError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return { courseVersionId: input.courseVersionId, stage: input.targetStage, publicationRevision: Number(event.evidence.resultingVersion), replayed: true, gate: event.evidence.gate as PublicationGateReport } as const;
    }
    if (Number(version.publication_revision) !== input.expectedVersion) throw new CurriculumAdminError("VERSION_CONFLICT");
    const gate = await evaluateCurriculumPublicationGate({ courseVersionId: input.courseVersionId, targetStage: input.targetStage, client });
    if (!gate.allowed) throw new CurriculumAdminError("PUBLICATION_GATE_BLOCKED", gate);
    const resultingVersion = input.expectedVersion + 1;
    const updated = await client.query(
      `update course_version set stage = $2, approved_by = $3, published_at = $4,
              publication_revision = publication_revision + 1, updated_at = $4
        where id = $1 and publication_revision = $5`,
      [input.courseVersionId, input.targetStage, input.actorUserId, now, input.expectedVersion],
    );
    if (updated.rowCount !== 1) throw new CurriculumAdminError("WRITE_CONFLICT");
    await client.query(
      `insert into curriculum_publication_pointer
        (course_id, current_course_version_id, row_version, updated_by, reason, updated_at)
       values ($1, $2, 1, $3, $4, $5)
       on conflict (course_id) do update set
         current_course_version_id = excluded.current_course_version_id,
         row_version = curriculum_publication_pointer.row_version + 1,
         updated_by = excluded.updated_by, reason = excluded.reason, updated_at = excluded.updated_at`,
      [version.course_id, input.courseVersionId, input.actorUserId, reason, now],
    );
    const eventEvidence = { targetStage: input.targetStage, resultingVersion, gate };
    await client.query(
      `insert into curriculum_publication_event
        (course_id, course_version_id, actor_user_id, event, request_id, reason, evidence, evidence_hash, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [version.course_id, input.courseVersionId, input.actorUserId, eventName, input.requestId, reason, JSON.stringify(eventEvidence), hashCurriculumValue(eventEvidence), now],
    );
    await client.query("commit");
    return { courseVersionId: input.courseVersionId, stage: input.targetStage, publicationRevision: resultingVersion, replayed: false, gate } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function retireCurriculumVersion(input: {
  actorUserId: string;
  courseVersionId: string;
  requestId: string;
  expectedVersion: number;
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  validateCommon({ ...input, reason, now });
  if (!UUID_PATTERN.test(input.courseVersionId)) throw new CurriculumAdminError("INVALID_REQUEST");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdmin(client, input.actorUserId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`curriculum-version:${input.courseVersionId}`]);
    const versionResult = await client.query<{ course_id: string; stage: string; publication_revision: string | number }>(`select course_id, stage, publication_revision from course_version where id = $1 for update`, [input.courseVersionId]);
    const version = versionResult.rows[0];
    if (!version) throw new CurriculumAdminError("NOT_FOUND");
    const current = await client.query<{ current_course_version_id: string }>(`select current_course_version_id from curriculum_publication_pointer where course_id = $1 for update`, [version.course_id]);
    if (current.rows[0]?.current_course_version_id === input.courseVersionId) throw new CurriculumAdminError("CURRENT_VERSION_CANNOT_RETIRE");
    const prior = await client.query<{ actor_user_id: string; event: string; reason: string; evidence: Record<string, unknown> }>(`select actor_user_id, event, reason, evidence from curriculum_publication_event where course_id = $1 and request_id = $2`, [version.course_id, input.requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].actor_user_id !== input.actorUserId || prior.rows[0].event !== "retired" || prior.rows[0].reason !== reason || prior.rows[0].evidence.courseVersionId !== input.courseVersionId) throw new CurriculumAdminError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return { courseVersionId: input.courseVersionId, stage: "retired", publicationRevision: Number(prior.rows[0].evidence.resultingVersion), replayed: true } as const;
    }
    if (Number(version.publication_revision) !== input.expectedVersion) throw new CurriculumAdminError("VERSION_CONFLICT");
    const resultingVersion = input.expectedVersion + 1;
    await client.query(`update course_version set stage = 'retired', publication_revision = publication_revision + 1, updated_at = $2 where id = $1 and publication_revision = $3`, [input.courseVersionId, now, input.expectedVersion]);
    const evidence = { courseVersionId: input.courseVersionId, previousStage: version.stage, resultingVersion };
    await client.query(`insert into curriculum_publication_event (course_id, course_version_id, actor_user_id, event, request_id, reason, evidence, evidence_hash, occurred_at) values ($1,$2,$3,'retired',$4,$5,$6::jsonb,$7,$8)`, [version.course_id, input.courseVersionId, input.actorUserId, input.requestId, reason, JSON.stringify(evidence), hashCurriculumValue(evidence), now]);
    await client.query("commit");
    return { courseVersionId: input.courseVersionId, stage: "retired", publicationRevision: resultingVersion, replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function rollbackCurriculumPointer(input: {
  actorUserId: string;
  courseId: string;
  targetCourseVersionId: string;
  requestId: string;
  expectedPointerVersion: number;
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  validateCommon({ requestId: input.requestId, expectedVersion: input.expectedPointerVersion, reason, now });
  if (!UUID_PATTERN.test(input.courseId) || !UUID_PATTERN.test(input.targetCourseVersionId)) throw new CurriculumAdminError("INVALID_REQUEST");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdmin(client, input.actorUserId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`curriculum-course:${input.courseId}`]);
    const target = await client.query<{ id: string; stage: string }>(`select id, stage from course_version where id = $1 and course_id = $2`, [input.targetCourseVersionId, input.courseId]);
    if (!target.rows[0] || !["beta", "verified"].includes(target.rows[0].stage)) throw new CurriculumAdminError("ROLLBACK_TARGET_INVALID");
    const pointerResult = await client.query<{ current_course_version_id: string; row_version: string | number }>(`select current_course_version_id, row_version from curriculum_publication_pointer where course_id = $1 for update`, [input.courseId]);
    const pointer = pointerResult.rows[0];
    if (!pointer) throw new CurriculumAdminError("ROLLBACK_TARGET_INVALID");
    const prior = await client.query<{ actor_user_id: string; event: string; reason: string; evidence: Record<string, unknown> }>(`select actor_user_id, event, reason, evidence from curriculum_publication_event where course_id = $1 and request_id = $2`, [input.courseId, input.requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].actor_user_id !== input.actorUserId || prior.rows[0].event !== "rolled_back" || prior.rows[0].reason !== reason || prior.rows[0].evidence.toCourseVersionId !== input.targetCourseVersionId) throw new CurriculumAdminError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return { courseId: input.courseId, currentCourseVersionId: input.targetCourseVersionId, pointerVersion: Number(prior.rows[0].evidence.resultingVersion), replayed: true } as const;
    }
    if (Number(pointer.row_version) !== input.expectedPointerVersion) throw new CurriculumAdminError("VERSION_CONFLICT");
    if (pointer.current_course_version_id === input.targetCourseVersionId) throw new CurriculumAdminError("ROLLBACK_TARGET_INVALID");
    const resultingVersion = input.expectedPointerVersion + 1;
    const updated = await client.query(`update curriculum_publication_pointer set current_course_version_id = $2, row_version = row_version + 1, updated_by = $3, reason = $4, updated_at = $5 where course_id = $1 and row_version = $6`, [input.courseId, input.targetCourseVersionId, input.actorUserId, reason, now, input.expectedPointerVersion]);
    if (updated.rowCount !== 1) throw new CurriculumAdminError("WRITE_CONFLICT");
    const evidence = { fromCourseVersionId: pointer.current_course_version_id, toCourseVersionId: input.targetCourseVersionId, resultingVersion };
    await client.query(`insert into curriculum_publication_event (course_id, course_version_id, actor_user_id, event, request_id, reason, evidence, evidence_hash, occurred_at) values ($1,$2,$3,'rolled_back',$4,$5,$6::jsonb,$7,$8)`, [input.courseId, input.targetCourseVersionId, input.actorUserId, input.requestId, reason, JSON.stringify(evidence), hashCurriculumValue(evidence), now]);
    await client.query("commit");
    return { courseId: input.courseId, currentCourseVersionId: input.targetCourseVersionId, pointerVersion: resultingVersion, replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
