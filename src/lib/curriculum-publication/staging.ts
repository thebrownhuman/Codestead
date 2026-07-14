import type { PoolClient } from "pg";

import { createContentRepository } from "@/lib/content";
import type { AssessmentBank, AuthoredLesson } from "@/lib/content/authored-types";
import type { CourseManifest } from "@/lib/content/types";
import { pool } from "@/lib/db/client";

import { aggregateArtifactHash, hashCurriculumValue } from "./hash";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CurriculumStagingError extends Error {
  constructor(public readonly code:
    | "ADMIN_REQUIRED"
    | "INVALID_REQUEST"
    | "COURSE_METADATA_CONFLICT"
    | "CONTENT_VERSION_MUTATION"
    | "ARTIFACT_VERSION_MUTATION"
    | "IDEMPOTENCY_MISMATCH") {
    super(code);
  }
}

export interface FilesystemCurriculumArtifact {
  readonly artifactKey: string;
  readonly artifactType: "course_manifest" | "authored_lesson" | "assessment_bank";
  readonly skillKey: string | null;
  readonly sourcePath: string;
  readonly content: Record<string, unknown>;
  readonly contentHash: string;
  readonly publicationStage: "draft" | "in-review" | "approved" | "published" | "retired";
  readonly aiAssisted: boolean;
  readonly provenance: Record<string, unknown>;
}

export interface FilesystemCurriculumCandidate {
  readonly course: CourseManifest;
  readonly domain: string;
  readonly sourceCommit: string | null;
  readonly contentHash: string;
  readonly artifacts: readonly FilesystemCurriculumArtifact[];
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function authoredArtifact(
  value: AuthoredLesson | AssessmentBank,
  artifactType: "authored_lesson" | "assessment_bank",
): FilesystemCurriculumArtifact {
  const content = asJsonObject(value);
  return {
    artifactKey: value.id,
    artifactType,
    skillKey: value.skillId,
    sourcePath: artifactType === "authored_lesson"
      ? `authored/lessons/${value.skillId}.json`
      : `authored/assessment-banks/${value.skillId}.json`,
    content,
    contentHash: hashCurriculumValue(content),
    publicationStage: value.publication.stage,
    aiAssisted: value.publication.aiAssisted,
    provenance: asJsonObject({
      author: value.publication.author,
      authoredAt: value.publication.authoredAt,
      reviewer: value.publication.reviewer,
      changeSummary: value.publication.changeSummary,
      schemaVersion: value.schemaVersion,
    }),
  };
}

export async function buildFilesystemCurriculumCandidates(options: {
  readonly contentRoot?: string;
  readonly sourceCommit?: string | null;
} = {}): Promise<readonly FilesystemCurriculumCandidate[]> {
  const repository = createContentRepository({ contentRoot: options.contentRoot });
  const [snapshot, authored] = await Promise.all([
    repository.getSnapshot(),
    repository.getAuthoredContentSet(),
  ]);
  const trackById = new Map(snapshot.catalog.tracks.map((track) => [track.id, track]));
  return snapshot.courses.map((course) => {
    const manifestContent = asJsonObject(course);
    const manifest: FilesystemCurriculumArtifact = {
      artifactKey: `manifest.${course.id}.${course.version}`,
      artifactType: "course_manifest",
      skillKey: null,
      sourcePath: snapshot.manifestPaths[course.id] ?? `courses/${course.id}.json`,
      content: manifestContent,
      contentHash: hashCurriculumValue(manifestContent),
      publicationStage: "draft",
      aiAssisted: false,
      provenance: {
        source: "validated-filesystem-manifest",
        schema: course.$schema,
        generatedByAi: false,
      },
    };
    const artifacts = [
      manifest,
      ...authored.lessons
        .filter((lesson) => lesson.courseId === course.id && lesson.courseVersion === course.version)
        .map((lesson) => authoredArtifact(lesson, "authored_lesson")),
      ...authored.assessmentBanks
        .filter((bank) => bank.courseId === course.id && bank.courseVersion === course.version)
        .map((bank) => authoredArtifact(bank, "assessment_bank")),
    ].sort((left, right) =>
      left.artifactKey < right.artifactKey ? -1 : left.artifactKey > right.artifactKey ? 1 : 0);
    return {
      course,
      domain: trackById.get(course.id)?.category ?? "curriculum",
      sourceCommit: options.sourceCommit ?? process.env.CONTENT_SOURCE_COMMIT ?? null,
      contentHash: aggregateArtifactHash(artifacts),
      artifacts,
    };
  });
}

async function assertAdmin(client: PoolClient, actorUserId: string): Promise<void> {
  const actor = await client.query<{ role: string | null; status: string }>(
    `select role, status from "user" where id = $1 for update`,
    [actorUserId],
  );
  if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
    throw new CurriculumStagingError("ADMIN_REQUIRED");
  }
}

export async function stageFilesystemCurriculum(input: {
  readonly actorUserId?: string;
  readonly requestId?: string;
  readonly reason?: string;
  readonly contentRoot?: string;
  readonly sourceCommit?: string | null;
  readonly now?: Date;
} = {}) {
  const now = input.now ?? new Date();
  const reason = input.reason?.trim();
  if (!Number.isFinite(now.getTime())) throw new CurriculumStagingError("INVALID_REQUEST");
  if (input.actorUserId) {
    if (!input.requestId || !UUID_PATTERN.test(input.requestId) || !reason || reason.length < 20 || reason.length > 2_000) {
      throw new CurriculumStagingError("INVALID_REQUEST");
    }
  }
  const candidates = await buildFilesystemCurriculumCandidates({
    contentRoot: input.contentRoot,
    sourceCommit: input.sourceCommit,
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (input.actorUserId) await assertAdmin(client, input.actorUserId);
    let stagedArtifacts = 0;
    let aiAssistedArtifacts = 0;
    const versionIds: string[] = [];
    for (const candidate of candidates) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`curriculum-stage:${candidate.course.id}:${candidate.course.version}`]);
      await client.query(
        `insert into course (slug, title, summary, domain, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $5)
         on conflict (slug) do nothing returning id`,
        [candidate.course.id, candidate.course.title, candidate.course.summary, candidate.domain, now],
      );
      const courseRow = (await client.query<{
        id: string; title: string; summary: string; domain: string;
      }>(`select id, title, summary, domain from course where slug = $1`, [candidate.course.id])).rows[0];
      if (!courseRow) throw new CurriculumStagingError("COURSE_METADATA_CONFLICT");
      if (
        courseRow.title !== candidate.course.title || courseRow.summary !== candidate.course.summary
      ) {
        throw new CurriculumStagingError("COURSE_METADATA_CONFLICT");
      }
      const scope = JSON.stringify({
        includes: candidate.course.scope.includes,
        excludes: candidate.course.scope.non_goals,
        exitOutcomes: candidate.course.exit_outcomes,
      });
      const insertedVersion = await client.query<{ id: string }>(
        `insert into course_version
          (course_id, version, stage, scope_statement, source_commit, content_hash, publication_revision, created_at, updated_at)
         values ($1, $2, 'draft', $3, $4, $5, 1, $6, $6)
         on conflict (course_id, version) do nothing returning id`,
        [courseRow.id, candidate.course.version, scope, candidate.sourceCommit, candidate.contentHash, now],
      );
      const versionRow = insertedVersion.rows[0] ?? (await client.query<{ id: string; content_hash: string }>(
        `select id, content_hash from course_version where course_id = $1 and version = $2 for update`,
        [courseRow.id, candidate.course.version],
      )).rows[0];
      if (!versionRow) throw new CurriculumStagingError("CONTENT_VERSION_MUTATION");
      if ("content_hash" in versionRow && versionRow.content_hash !== candidate.contentHash) {
        throw new CurriculumStagingError("CONTENT_VERSION_MUTATION");
      }
      versionIds.push(versionRow.id);
      const artifactPayload = candidate.artifacts.map((artifact) => ({
        artifact_key: artifact.artifactKey,
        artifact_type: artifact.artifactType,
        skill_key: artifact.skillKey,
        source_path: artifact.sourcePath,
        content: artifact.content,
        content_hash: artifact.contentHash,
        publication_stage: artifact.publicationStage,
        ai_assisted: artifact.aiAssisted,
        provenance: artifact.provenance,
      }));
      await client.query(
        `insert into curriculum_artifact
          (course_version_id, artifact_key, artifact_type, skill_key, source_path,
           content, content_hash, publication_stage, ai_assisted, provenance,
           review_status, row_version, created_at, updated_at)
         select $1, x.artifact_key, x.artifact_type, x.skill_key, x.source_path,
                x.content, x.content_hash, x.publication_stage, x.ai_assisted, x.provenance,
                'unreviewed', 1, $2, $2
           from jsonb_to_recordset($3::jsonb) as x(
             artifact_key text, artifact_type text, skill_key text, source_path text,
             content jsonb, content_hash text, publication_stage text,
             ai_assisted boolean, provenance jsonb)
         on conflict (course_version_id, artifact_key) do nothing`,
        [versionRow.id, now, JSON.stringify(artifactPayload)],
      );
      const stored = await client.query<{ artifact_key: string; content_hash: string; ai_assisted: boolean }>(
        `select artifact_key, content_hash, ai_assisted from curriculum_artifact where course_version_id = $1`,
        [versionRow.id],
      );
      const storedHashes = new Map(stored.rows.map((row) => [row.artifact_key, row.content_hash]));
      if (
        stored.rows.length !== candidate.artifacts.length
        || candidate.artifacts.some((artifact) => storedHashes.get(artifact.artifactKey) !== artifact.contentHash)
      ) {
        throw new CurriculumStagingError("ARTIFACT_VERSION_MUTATION");
      }
      stagedArtifacts += stored.rows.length;
      aiAssistedArtifacts += stored.rows.filter((artifact) => artifact.ai_assisted).length;
      if (input.actorUserId && input.requestId && reason) {
        const eventEvidence = {
          source: "validated-filesystem",
          contentHash: candidate.contentHash,
          artifactCount: candidate.artifacts.length,
          aiAssistedArtifactCount: candidate.artifacts.filter((artifact) => artifact.aiAssisted).length,
          publicationStage: "draft",
        };
        const evidenceHash = hashCurriculumValue(eventEvidence);
        const prior = await client.query<{
          actor_user_id: string;
          course_version_id: string;
          event: string;
          reason: string;
          evidence_hash: string;
        }>(
          `select actor_user_id, course_version_id, event, reason, evidence_hash
             from curriculum_publication_event where course_id = $1 and request_id = $2`,
          [courseRow.id, input.requestId],
        );
        if (prior.rows[0]) {
          const event = prior.rows[0];
          if (
            event.actor_user_id !== input.actorUserId
            || event.course_version_id !== versionRow.id
            || event.event !== "candidate_staged"
            || event.reason !== reason
            || event.evidence_hash !== evidenceHash
          ) throw new CurriculumStagingError("IDEMPOTENCY_MISMATCH");
        } else await client.query(
          `insert into curriculum_publication_event
            (course_id, course_version_id, actor_user_id, event, request_id, reason, evidence, evidence_hash, occurred_at)
           values ($1, $2, $3, 'candidate_staged', $4, $5, $6::jsonb, $7, $8)
           `,
          [courseRow.id, versionRow.id, input.actorUserId, input.requestId, reason, JSON.stringify(eventEvidence), evidenceHash, now],
        );
      }
    }
    await client.query("commit");
    return {
      courses: candidates.length,
      artifacts: stagedArtifacts,
      aiAssistedArtifacts,
      courseVersionIds: versionIds,
    } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
