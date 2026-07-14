import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { pool } from "@/lib/db/client";
import {
  PROJECT_REVIEW_ANALYZER_VERSION,
  PROJECT_REVIEW_RUBRIC_VERSION,
  reviewPublicRepositoryAtCommit,
} from "@/lib/github/reviewer";
import { writeAuditEvent } from "@/lib/security/audit-writer";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60_000;

export type ProjectReviewCorrectionErrorCode =
  | "ADMIN_REQUIRED"
  | "INVALID_INPUT"
  | "REVIEW_NOT_FOUND"
  | "REVIEW_NOT_CORRECTABLE"
  | "APPEAL_NOT_OVERTURNED"
  | "PROVENANCE_INCOMPLETE"
  | "IDEMPOTENCY_MISMATCH"
  | "CORRECTION_ALREADY_EXISTS"
  | "PINNED_COMMIT_MISMATCH"
  | "STATIC_ANALYSIS_FAILED"
  | "SOURCE_EVIDENCE_CHANGED"
  | "CORRECTION_NOT_RETRYABLE"
  | "CORRECTION_DEAD_LETTERED"
  | "WRITE_CONFLICT";

export class ProjectReviewCorrectionError extends Error {
  constructor(public readonly code: ProjectReviewCorrectionErrorCode) {
    super(code);
    this.name = "ProjectReviewCorrectionError";
  }
}

type ReviewProvenance = Record<string, unknown>;

export function hasCompleteProjectReviewProvenance(
  value: unknown,
  persistedModelCallId: string | null,
  authoritativeRubricVersion: string,
): value is ReviewProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  if (
    provenance.schemaVersion !== 1
    || provenance.repositoryExecution !== "none"
    || provenance.runnerTemplateId !== null
    || provenance.rubricVersion !== authoritativeRubricVersion
  ) return false;
  if (provenance.analysisMode === "deterministic_static") {
    return (
      provenance.aiUsed === false
      && provenance.promptVersion === null
      && provenance.provider === null
      && provenance.model === null
      && provenance.modelCallId === null
      && persistedModelCallId === null
    );
  }
  if (provenance.analysisMode === "ai_assisted") {
    return (
      provenance.aiUsed === true
      && typeof provenance.promptVersion === "string"
      && provenance.promptVersion.length > 0
      && typeof provenance.provider === "string"
      && provenance.provider.length > 0
      && typeof provenance.model === "string"
      && provenance.model.length > 0
      && typeof provenance.modelCallId === "string"
      && provenance.modelCallId === persistedModelCallId
    );
  }
  return false;
}

function completedFindings(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))
    ? value as Record<string, unknown>[]
    : null;
}

function validateQueueInput(input: {
  actorUserId: string;
  sourceReviewId: string;
  sourceAppealId?: string | null;
  requestId: string;
  reason: string;
  now: Date;
}) {
  if (
    input.actorUserId.length < 1
    || input.actorUserId.length > 255
    || !UUID_PATTERN.test(input.sourceReviewId)
    || (input.sourceAppealId !== undefined
      && input.sourceAppealId !== null
      && !UUID_PATTERN.test(input.sourceAppealId))
  ) throw new ProjectReviewCorrectionError("INVALID_INPUT");
  if (!UUID_PATTERN.test(input.requestId)) throw new ProjectReviewCorrectionError("INVALID_INPUT");
  if (!Number.isFinite(input.now.getTime())) throw new ProjectReviewCorrectionError("INVALID_INPUT");
  const reason = input.reason.trim();
  if (reason.length < 20 || reason.length > 2_000) {
    throw new ProjectReviewCorrectionError("INVALID_INPUT");
  }
  return reason;
}

type QueueResult = Readonly<{
  correctionId: string;
  projectId: string;
  sourceReviewId: string;
  userId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  revision: number;
  duplicate: boolean;
}>;

type QueueInput = {
  actorUserId: string;
  sourceReviewId: string;
  sourceAppealId?: string | null;
  requestId: string;
  reason: string;
  now?: Date;
};

type ExistingCorrectionRow = {
  id: string;
  project_id: string;
  source_review_id: string;
  source_appeal_id: string | null;
  requested_by: string;
  request_id: string;
  reason: string;
  status: "queued" | "running" | "succeeded" | "failed";
  revision: number;
  user_id: string;
};

function queueReplayMatches(row: ExistingCorrectionRow, input: QueueInput, reason: string) {
  return row.requested_by === input.actorUserId
    && row.source_review_id === input.sourceReviewId
    && row.source_appeal_id === (input.sourceAppealId ?? null)
    && row.reason === reason;
}

async function findCorrectionByRequest(
  client: PoolClient,
  actorUserId: string,
  requestId: string,
) {
  const result = await client.query<ExistingCorrectionRow>(
    `select c.id, c.project_id, c.source_review_id, c.source_appeal_id,
            c.requested_by, c.request_id, c.reason, c.status, c.revision,
            p.user_id
       from project_review_correction c
       join project p on p.id = c.project_id
      where c.requested_by = $1 and c.request_id = $2
      limit 1`,
    [actorUserId, requestId],
  );
  return result.rows[0];
}

async function appendCorrectionEvent(client: PoolClient, input: {
  correctionId: string;
  actorUserId?: string | null;
  actorRole: "admin" | "system";
  event: "queued" | "retry_queued" | "analysis_started" | "analysis_succeeded" | "analysis_failed" | "projection_applied" | "projection_skipped";
  requestId?: string;
  reason: string;
  evidence: Record<string, unknown>;
  now: Date;
}) {
  const evidenceHash = hashAppealEvidence(input.evidence);
  await client.query(
    `insert into project_review_correction_event
      (correction_id, actor_user_id, actor_role, event, request_id,
       reason, evidence, evidence_hash, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [input.correctionId, input.actorUserId ?? null, input.actorRole, input.event,
      input.requestId ?? randomUUID(), input.reason, JSON.stringify(input.evidence), evidenceHash, input.now],
  );
}

/**
 * Transaction-aware queueing used by appeal adjudication so the overturn and
 * its exact corrective job are committed together.
 */
export async function queueProjectReviewCorrectionWithClient(
  client: PoolClient,
  input: QueueInput,
): Promise<QueueResult> {
  const now = input.now ?? new Date();
  const reason = validateQueueInput({ ...input, now });
  const actor = await client.query<{ role: string | null; status: string }>(
    `select role, status from "user" where id = $1 for update`,
    [input.actorUserId],
  );
  if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
    throw new ProjectReviewCorrectionError("ADMIN_REQUIRED");
  }
  const existingRequest = await findCorrectionByRequest(client, input.actorUserId, input.requestId);
  if (existingRequest) {
    if (!queueReplayMatches(existingRequest, input, reason)) {
      throw new ProjectReviewCorrectionError("IDEMPOTENCY_MISMATCH");
    }
    return {
      correctionId: existingRequest.id,
      projectId: existingRequest.project_id,
      sourceReviewId: existingRequest.source_review_id,
      userId: existingRequest.user_id,
      status: existingRequest.status,
      revision: Number(existingRequest.revision),
      duplicate: true,
    };
  }
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `project-review-correction:${input.sourceReviewId}`,
  ]);
  const source = await client.query<{
    review_id: string;
    project_id: string;
    user_id: string;
    github_url: string | null;
    commit_sha: string;
    analyzer_version: string;
    rubric_version: string;
    model_call_id: string | null;
    analysis_provenance: Record<string, unknown>;
    findings: unknown;
    findings_hash: string | null;
    status: string;
  }>(
    `select r.id as review_id, r.project_id, p.user_id, p.github_url,
            r.commit_sha, r.analyzer_version, r.rubric_version, r.model_call_id,
            r.analysis_provenance, r.findings, r.findings_hash, r.status
       from project_review r
       join project p on p.id = r.project_id
      where r.id = $1
      for update of r, p`,
    [input.sourceReviewId],
  );
  const review = source.rows[0];
  if (!review) throw new ProjectReviewCorrectionError("REVIEW_NOT_FOUND");
  const findings = completedFindings(review.findings);
  if (
    review.status !== "complete"
    || !review.github_url
    || !SHA_PATTERN.test(review.commit_sha)
    || !findings
  ) throw new ProjectReviewCorrectionError("REVIEW_NOT_CORRECTABLE");
  if (!hasCompleteProjectReviewProvenance(
    review.analysis_provenance,
    review.model_call_id,
    review.rubric_version,
  )) {
    throw new ProjectReviewCorrectionError("PROVENANCE_INCOMPLETE");
  }
  if (input.sourceAppealId) {
    const sourceAppeal = await client.query<{
      id: string;
      project_review_id: string | null;
      status: string;
      decision: string | null;
    }>(
      `select id, project_review_id, status, decision from appeal where id = $1 for update`,
      [input.sourceAppealId],
    );
    const linked = sourceAppeal.rows[0];
    if (
      !linked
      || linked.project_review_id !== input.sourceReviewId
      || linked.status !== "overturned"
      || linked.decision !== "overturned"
    ) throw new ProjectReviewCorrectionError("APPEAL_NOT_OVERTURNED");
    const appealCorrection = await client.query<ExistingCorrectionRow>(
      `select c.id, c.project_id, c.source_review_id, c.source_appeal_id,
              c.requested_by, c.request_id, c.reason, c.status, c.revision,
              p.user_id
         from project_review_correction c join project p on p.id = c.project_id
        where c.source_appeal_id = $1 limit 1`,
      [input.sourceAppealId],
    );
    if (appealCorrection.rows[0]) {
      if (!queueReplayMatches(appealCorrection.rows[0], input, reason)) {
        throw new ProjectReviewCorrectionError("CORRECTION_ALREADY_EXISTS");
      }
      const replay = appealCorrection.rows[0];
      return {
        correctionId: replay.id,
        projectId: replay.project_id,
        sourceReviewId: replay.source_review_id,
        userId: replay.user_id,
        status: replay.status,
        revision: Number(replay.revision),
        duplicate: true,
      };
    }
  }
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `project-review-correction-revision:${review.project_id}`,
  ]);
  const revisionResult = await client.query<{ next_revision: number }>(
    `select coalesce(max(revision), 0)::int + 1 as next_revision
       from project_review_correction where project_id = $1`,
    [review.project_id],
  );
  const revision = Number(revisionResult.rows[0]?.next_revision ?? 1);
  const sourceFindingsHash = hashAppealEvidence(findings);
  if (review.findings_hash && review.findings_hash !== sourceFindingsHash) {
    throw new ProjectReviewCorrectionError("SOURCE_EVIDENCE_CHANGED");
  }
  const created = await client.query<{ id: string }>(
    `insert into project_review_correction
      (project_id, source_review_id, source_appeal_id, requested_by, request_id,
       revision, reason, source_commit_sha, source_analyzer_version,
       source_rubric_version, source_provenance, source_findings_hash,
       target_analyzer_version, target_rubric_version, status, next_attempt_at,
       created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,'queued',$15,$15,$15)
     returning id`,
    [review.project_id, input.sourceReviewId, input.sourceAppealId ?? null,
      input.actorUserId, input.requestId, revision, reason, review.commit_sha,
      review.analyzer_version, review.rubric_version,
      JSON.stringify(review.analysis_provenance), sourceFindingsHash,
      PROJECT_REVIEW_ANALYZER_VERSION, PROJECT_REVIEW_RUBRIC_VERSION, now],
  );
  const correctionId = created.rows[0]?.id;
  if (!correctionId) throw new ProjectReviewCorrectionError("WRITE_CONFLICT");
  const queueEvidence = {
    schemaVersion: 1,
    correctionId,
    revision,
    sourceReviewId: input.sourceReviewId,
    sourceAppealId: input.sourceAppealId ?? null,
    sourceCommitSha: review.commit_sha,
    sourceAnalyzerVersion: review.analyzer_version,
    sourceRubricVersion: review.rubric_version,
    sourceFindingsHash,
    targetAnalyzerVersion: PROJECT_REVIEW_ANALYZER_VERSION,
    targetRubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
    adminReasonHash: hashAppealEvidence(reason),
    requestedAt: now.toISOString(),
  };
  await appendCorrectionEvent(client, {
    correctionId,
    actorUserId: input.actorUserId,
    actorRole: "admin",
    event: "queued",
    requestId: input.requestId,
    reason,
    evidence: queueEvidence,
    now,
  });
  await client.query(
    `insert into notification (user_id, type, title, body, action_url, created_at)
     values ($1, 'project-review-correction-queued',
       'A corrective project review was queued',
       'An administrator preserved the original review and queued a deterministic static re-analysis of the exact same commit.',
       '/projects', $2)`,
    [review.user_id, now],
  );
  return {
    correctionId,
    projectId: review.project_id,
    sourceReviewId: input.sourceReviewId,
    userId: review.user_id,
    status: "queued",
    revision,
    duplicate: false,
  };
}

export async function queueProjectReviewCorrection(input: QueueInput): Promise<QueueResult> {
  validateQueueInput({ ...input, now: input.now ?? new Date() });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await queueProjectReviewCorrectionWithClient(client, input);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type ClaimedCorrection = {
  id: string;
  projectId: string;
  sourceReviewId: string;
  sourceAppealId: string | null;
  requestedBy: string;
  userId: string;
  revision: number;
  reason: string;
  repositoryUrl: string;
  sourceCommitSha: string;
  sourceAnalyzerVersion: string;
  sourceRubricVersion: string;
  sourceProvenance: Record<string, unknown>;
  sourceFindingsHash: string;
  targetAnalyzerVersion: string;
  targetRubricVersion: string;
  attemptCount: number;
  workerId: string;
};

export function hasCurrentProjectReviewCorrectionLease(
  row: { status: string; leaseOwner: string | null; attemptCount: number },
  expected: { workerId: string; attemptCount: number },
) {
  return row.status === "running"
    && row.leaseOwner === expected.workerId
    && row.attemptCount === expected.attemptCount;
}

async function notifyCorrectionFailureAdmins(client: PoolClient, input: {
  deadLettered: boolean;
  now: Date;
}) {
  await client.query(
    `insert into notification (user_id, type, title, body, action_url, created_at)
     select id, $1, $2, $3, '/admin/project-review-corrections', $4
       from "user" where role = 'admin' and status = 'active'`,
    input.deadLettered
      ? [
          "project-review-correction-dead-lettered",
          "A corrective project review is dead-lettered",
          "Static re-analysis exhausted its bounded attempts. Original and effective reviews remain unchanged; create a reviewed replacement correction before retrying.",
          input.now,
        ]
      : [
          "project-review-correction-failed",
          "A corrective project review needs attention",
          "Static re-analysis failed safely; the original and effective reviews were not changed.",
          input.now,
        ],
  );
}

async function recoverExpiredCorrectionLeases(client: PoolClient, now: Date) {
  const expired = await client.query<{
    id: string;
    attempt_count: number;
    lease_owner: string | null;
  }>(
    `select id, attempt_count, lease_owner
       from project_review_correction
      where status = 'running' and lease_expires_at < $1
      order by lease_expires_at asc, id asc
      for update skip locked
      limit 50`,
    [now],
  );
  for (const row of expired.rows) {
    const attemptCount = Number(row.attempt_count);
    const deadLettered = attemptCount >= MAX_ATTEMPTS;
    await client.query(
      `update project_review_correction
          set status = 'failed', lease_owner = null, lease_expires_at = null,
              last_error_code = 'WORKER_LEASE_EXPIRED', next_attempt_at = $2::timestamptz,
              dead_lettered_at = case
                when $3::boolean then $2::timestamptz
                else null::timestamptz
              end,
              updated_at = $2::timestamptz
        where id = $1 and status = 'running'`,
      [row.id, now, deadLettered],
    );
    await appendCorrectionEvent(client, {
      correctionId: row.id,
      actorRole: "system",
      event: "analysis_failed",
      reason: "The correction worker lease expired after process interruption; no effective review was changed.",
      evidence: {
        schemaVersion: 1,
        errorCode: "WORKER_LEASE_EXPIRED",
        attemptNumber: attemptCount,
        leaseGeneration: attemptCount,
        priorWorkerHash: row.lease_owner ? hashAppealEvidence(row.lease_owner) : null,
        retryAllowed: !deadLettered,
        deadLettered,
        recoveredAt: now.toISOString(),
      },
      now,
    });
    await notifyCorrectionFailureAdmins(client, { deadLettered, now });
  }
  return expired.rows.length;
}

async function claimCorrection(input: {
  workerId: string;
  correctionId?: string;
  now: Date;
}): Promise<ClaimedCorrection | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await recoverExpiredCorrectionLeases(client, input.now);
    const selected = await client.query<{
      id: string;
      project_id: string;
      source_review_id: string;
      source_appeal_id: string | null;
      requested_by: string;
      user_id: string;
      revision: number;
      reason: string;
      github_url: string | null;
      source_commit_sha: string;
      source_analyzer_version: string;
      source_rubric_version: string;
      source_provenance: Record<string, unknown>;
      source_findings_hash: string;
      target_analyzer_version: string;
      target_rubric_version: string;
      attempt_count: number;
    }>(
      `select c.id, c.project_id, c.source_review_id, c.source_appeal_id,
              c.requested_by, p.user_id, c.revision, c.reason, p.github_url,
              c.source_commit_sha, c.source_analyzer_version,
              c.source_rubric_version, c.source_provenance,
              c.source_findings_hash, c.target_analyzer_version,
              c.target_rubric_version, c.attempt_count
         from project_review_correction c
         join project p on p.id = c.project_id
        where ($1::uuid is null or c.id = $1)
          and c.status in ('queued', 'failed')
          and c.attempt_count < $2 and c.next_attempt_at <= $3
        order by c.next_attempt_at asc, c.created_at asc, c.id asc
        for update of c skip locked
        limit 1`,
      [input.correctionId ?? null, MAX_ATTEMPTS, input.now],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("commit");
      return null;
    }
    if (!row.github_url) throw new ProjectReviewCorrectionError("REVIEW_NOT_CORRECTABLE");
    await client.query(
      `update project_review_correction
          set status = 'running', attempt_count = attempt_count + 1,
              lease_owner = $2, lease_expires_at = $3, started_at = $1,
              last_error_code = null, dead_lettered_at = null, updated_at = $1
        where id = $4 and status in ('queued', 'failed')`,
      [input.now, input.workerId, new Date(input.now.getTime() + LEASE_MS), row.id],
    );
    await appendCorrectionEvent(client, {
      correctionId: row.id,
      actorRole: "system",
      event: "analysis_started",
      reason: "Deterministic static re-analysis started for the exact preserved commit.",
      evidence: {
        schemaVersion: 1,
        attemptNumber: Number(row.attempt_count) + 1,
        leaseGeneration: Number(row.attempt_count) + 1,
        workerHash: hashAppealEvidence(input.workerId),
        sourceCommitSha: row.source_commit_sha,
        repositoryExecution: "none",
        runnerTemplateId: null,
      },
      now: input.now,
    });
    await client.query("commit");
    return {
      id: row.id,
      projectId: row.project_id,
      sourceReviewId: row.source_review_id,
      sourceAppealId: row.source_appeal_id,
      requestedBy: row.requested_by,
      userId: row.user_id,
      revision: Number(row.revision),
      reason: row.reason,
      repositoryUrl: row.github_url,
      sourceCommitSha: row.source_commit_sha,
      sourceAnalyzerVersion: row.source_analyzer_version,
      sourceRubricVersion: row.source_rubric_version,
      sourceProvenance: row.source_provenance,
      sourceFindingsHash: row.source_findings_hash,
      targetAnalyzerVersion: row.target_analyzer_version,
      targetRubricVersion: row.target_rubric_version,
      attemptCount: Number(row.attempt_count) + 1,
      workerId: input.workerId,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type ProjectReviewAnalyzer = (
  repositoryUrl: string,
  commitSha: string,
) => Promise<Awaited<ReturnType<typeof reviewPublicRepositoryAtCommit>>>;

const configuredAnalyzer: ProjectReviewAnalyzer = (repositoryUrl, commitSha) => (
  reviewPublicRepositoryAtCommit(repositoryUrl, commitSha)
);

function validateCorrectiveResult(
  job: ClaimedCorrection,
  result: Awaited<ReturnType<typeof reviewPublicRepositoryAtCommit>>,
) {
  if (result.commitSha !== job.sourceCommitSha) {
    throw new ProjectReviewCorrectionError("PINNED_COMMIT_MISMATCH");
  }
  if (
    result.analyzerVersion !== job.targetAnalyzerVersion
    || result.rubricVersion !== job.targetRubricVersion
    || !hasCompleteProjectReviewProvenance(result.provenance, null, result.rubricVersion)
    || result.provenance.analysisMode !== "deterministic_static"
    || result.provenance.aiUsed !== false
    || result.provenance.repositoryExecution !== "none"
    || result.provenance.runnerTemplateId !== null
    || !completedFindings(result.findings)
  ) throw new ProjectReviewCorrectionError("PROVENANCE_INCOMPLETE");
}

async function persistCorrectionSuccess(
  job: ClaimedCorrection,
  result: Awaited<ReturnType<typeof reviewPublicRepositoryAtCommit>>,
  now: Date,
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `project-review-effective:${job.projectId}`,
    ]);
    await client.query("select set_config('app.project_review_projection_write', '1', true)");
    const currentJob = await client.query<{
      status: string;
      lease_owner: string | null;
      attempt_count: number;
    }>(
      `select status, lease_owner, attempt_count
         from project_review_correction where id = $1 for update`,
      [job.id],
    );
    const correction = currentJob.rows[0];
    if (!correction || !hasCurrentProjectReviewCorrectionLease({
      status: correction.status,
      leaseOwner: correction.lease_owner,
      attemptCount: Number(correction.attempt_count),
    }, job)) {
      throw new ProjectReviewCorrectionError("WRITE_CONFLICT");
    }
    const source = await client.query<{
      project_id: string;
      commit_sha: string;
      analyzer_version: string;
      rubric_version: string;
      model_call_id: string | null;
      analysis_provenance: Record<string, unknown>;
      findings: unknown;
      findings_hash: string | null;
      status: string;
    }>(
      `select project_id, commit_sha, analyzer_version, rubric_version,
              model_call_id, analysis_provenance, findings, findings_hash, status
         from project_review where id = $1 for update`,
      [job.sourceReviewId],
    );
    const review = source.rows[0];
    const sourceFindings = completedFindings(review?.findings);
    if (
      !review
      || review.project_id !== job.projectId
      || review.status !== "complete"
      || review.commit_sha !== job.sourceCommitSha
      || review.analyzer_version !== job.sourceAnalyzerVersion
      || review.rubric_version !== job.sourceRubricVersion
      || !sourceFindings
      || hashAppealEvidence(sourceFindings) !== job.sourceFindingsHash
      || (review.findings_hash !== null && review.findings_hash !== job.sourceFindingsHash)
      || hashAppealEvidence(review.analysis_provenance) !== hashAppealEvidence(job.sourceProvenance)
      || !hasCompleteProjectReviewProvenance(
        review.analysis_provenance,
        review.model_call_id,
        review.rubric_version,
      )
    ) throw new ProjectReviewCorrectionError("SOURCE_EVIDENCE_CHANGED");
    validateCorrectiveResult(job, result);
    const resultFindings = completedFindings(result.findings)!;
    const resultFindingsHash = hashAppealEvidence(resultFindings);
    const projectState = await client.query<{
      github_commit_sha: string | null;
      latest_review_id: string | null;
    }>(
      `select p.github_commit_sha,
              (select r.id from project_review r
                where r.project_id = p.id and r.status = 'complete'
                order by r.created_at desc, r.id desc limit 1) as latest_review_id
         from project p where p.id = $1 for update`,
      [job.projectId],
    );
    const effective = await client.query<{
      source_review_id: string;
      correction_id: string | null;
      revision: string | number;
      correction_revision: number | null;
    }>(
      `select e.source_review_id, e.correction_id, e.revision,
              prior.revision as correction_revision
         from project_review_effective e
         left join project_review_correction prior on prior.id = e.correction_id
        where e.project_id = $1 for update of e`,
      [job.projectId],
    );
    const state = projectState.rows[0];
    const currentProjection = effective.rows[0];
    const projectionApplied = Boolean(
      state
      && state.github_commit_sha === job.sourceCommitSha
      && state.latest_review_id === job.sourceReviewId
      && (!currentProjection || (
        currentProjection.source_review_id === job.sourceReviewId
        && Number(currentProjection.correction_revision ?? 0) < job.revision
      )),
    );
    let projectionRevision = Number(currentProjection?.revision ?? 0);
    if (projectionApplied) {
      projectionRevision += 1;
      if (currentProjection) {
        await client.query(
          `update project_review_effective
              set source_review_id = $2, correction_id = $3, commit_sha = $4,
                  analyzer_version = $5, rubric_version = $6,
                  provenance = $7::jsonb, findings = $8::jsonb,
                  findings_hash = $9, revision = $10, updated_at = $11
            where project_id = $1`,
          [job.projectId, job.sourceReviewId, job.id, job.sourceCommitSha,
            result.analyzerVersion, result.rubricVersion,
            JSON.stringify(result.provenance), JSON.stringify(resultFindings),
            resultFindingsHash, projectionRevision, now],
        );
      } else {
        await client.query(
          `insert into project_review_effective
            (project_id, source_review_id, correction_id, commit_sha,
             analyzer_version, rubric_version, provenance, findings,
             findings_hash, revision, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)`,
          [job.projectId, job.sourceReviewId, job.id, job.sourceCommitSha,
            result.analyzerVersion, result.rubricVersion,
            JSON.stringify(result.provenance), JSON.stringify(resultFindings),
            resultFindingsHash, projectionRevision, now],
        );
      }
    }
    const evidence = {
      schemaVersion: 1,
      correctionId: job.id,
      correctionRevision: job.revision,
      sourceAppealId: job.sourceAppealId,
      source: {
        reviewId: job.sourceReviewId,
        commitSha: job.sourceCommitSha,
        analyzerVersion: job.sourceAnalyzerVersion,
        rubricVersion: job.sourceRubricVersion,
        provenanceHash: hashAppealEvidence(job.sourceProvenance),
        findingsHash: job.sourceFindingsHash,
      },
      result: {
        commitSha: result.commitSha,
        analyzerVersion: result.analyzerVersion,
        rubricVersion: result.rubricVersion,
        provenance: result.provenance,
        findingsHash: resultFindingsHash,
        filesReviewed: result.filesReviewed,
      },
      authority: {
        requestedBy: job.requestedBy,
        adminReasonHash: hashAppealEvidence(job.reason),
      },
      execution: {
        deterministic: true,
        aiRole: "none",
        repositoryExecution: "none",
        runnerTemplateId: null,
      },
      projection: {
        applied: projectionApplied,
        revision: projectionApplied ? projectionRevision : null,
        skippedBecauseNewerReviewExists: !projectionApplied,
      },
      completedAt: now.toISOString(),
    };
    const evidenceHash = hashAppealEvidence(evidence);
    const updated = await client.query(
      `update project_review_correction
          set status = 'succeeded', result_findings = $2::jsonb,
              result_findings_hash = $3, result_provenance = $4::jsonb,
              evidence = $5::jsonb, evidence_hash = $6,
              projection_applied = $7, lease_owner = null,
              lease_expires_at = null, last_error_code = null,
              dead_lettered_at = null, completed_at = $8, updated_at = $8
        where id = $1 and status = 'running' and lease_owner = $9
          and attempt_count = $10`,
      [job.id, JSON.stringify(resultFindings), resultFindingsHash,
        JSON.stringify(result.provenance), JSON.stringify(evidence), evidenceHash,
        projectionApplied, now, job.workerId, job.attemptCount],
    );
    if (updated.rowCount !== 1) throw new ProjectReviewCorrectionError("WRITE_CONFLICT");
    await appendCorrectionEvent(client, {
      correctionId: job.id,
      actorRole: "system",
      event: "analysis_succeeded",
      reason: "Deterministic static re-analysis appended immutable corrective evidence.",
      evidence: {
        schemaVersion: 1,
        evidenceHash,
        resultFindingsHash,
        sourceFindingsHash: job.sourceFindingsHash,
        projectionApplied,
      },
      now,
    });
    await appendCorrectionEvent(client, {
      correctionId: job.id,
      actorRole: "system",
      event: projectionApplied ? "projection_applied" : "projection_skipped",
      reason: projectionApplied
        ? "The corrected static analysis became the effective project-review projection."
        : "A newer project review remained effective; the correction was preserved without overwriting it.",
      evidence: {
        schemaVersion: 1,
        sourceReviewId: job.sourceReviewId,
        correctionRevision: job.revision,
        projectionRevision: projectionApplied ? projectionRevision : null,
        latestReviewId: state?.latest_review_id ?? null,
      },
      now,
    });
    await client.query(
      `insert into notification (user_id, type, title, body, action_url, created_at)
       values ($1, 'project-review-corrected', 'Your project review was re-analyzed',
         $2, '/projects', $3)`,
      [job.userId, projectionApplied
        ? "The exact original commit was re-analyzed statically. The original review remains preserved and the corrected findings are now effective."
        : "The exact original commit was re-analyzed statically and preserved, but a newer review remains effective.", now],
    );
    await client.query("commit");
    return { replayed: false, projectionApplied, evidenceHash };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function correctionFailureCode(error: unknown): ProjectReviewCorrectionErrorCode {
  if (error instanceof ProjectReviewCorrectionError) return error.code;
  if (error instanceof Error && /exact pinned commit/i.test(error.message)) return "PINNED_COMMIT_MISMATCH";
  return "STATIC_ANALYSIS_FAILED";
}

async function persistCorrectionFailure(job: ClaimedCorrection, error: unknown, now: Date) {
  const code = correctionFailureCode(error);
  const deadLettered = job.attemptCount >= MAX_ATTEMPTS;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const retryAt = new Date(now.getTime() + Math.min(15 * 60_000, 60_000 * (2 ** (job.attemptCount - 1))));
    const updated = await client.query(
      `update project_review_correction
          set status = 'failed', lease_owner = null, lease_expires_at = null,
              last_error_code = $2, next_attempt_at = $3::timestamptz,
              dead_lettered_at = case
                when $7::boolean then $4::timestamptz
                else null::timestamptz
              end,
              updated_at = $4::timestamptz
        where id = $1 and status = 'running' and lease_owner = $5
          and attempt_count = $6`,
      [job.id, code, retryAt, now, job.workerId, job.attemptCount, deadLettered],
    );
    if (updated.rowCount === 1) {
      await appendCorrectionEvent(client, {
        correctionId: job.id,
        actorRole: "system",
        event: "analysis_failed",
        reason: "Corrective static analysis failed safely; no effective review was changed.",
        evidence: {
          schemaVersion: 1,
          errorCode: code,
          attemptNumber: job.attemptCount,
          leaseGeneration: job.attemptCount,
          retryAllowed: !deadLettered,
          retryAt: deadLettered ? null : retryAt.toISOString(),
          deadLettered,
        },
        now,
      });
      await notifyCorrectionFailureAdmins(client, { deadLettered, now });
    }
    await client.query("commit");
  } catch (failure) {
    await client.query("rollback").catch(() => undefined);
    throw failure;
  } finally {
    client.release();
  }
  return code;
}

export async function processOneProjectReviewCorrection(input: {
  workerId: string;
  correctionId?: string;
  analyzer?: ProjectReviewAnalyzer;
  now?: Date;
}) {
  if (!/^[A-Za-z0-9._:-]{3,100}$/.test(input.workerId)) {
    throw new ProjectReviewCorrectionError("INVALID_INPUT");
  }
  if (input.correctionId && !UUID_PATTERN.test(input.correctionId)) {
    throw new ProjectReviewCorrectionError("INVALID_INPUT");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new ProjectReviewCorrectionError("INVALID_INPUT");
  const job = await claimCorrection({ workerId: input.workerId, correctionId: input.correctionId, now });
  if (!job) return { processed: false as const };
  try {
    const result = await (input.analyzer ?? configuredAnalyzer)(job.repositoryUrl, job.sourceCommitSha);
    const outcome = await persistCorrectionSuccess(job, result, now);
    await writeAuditEvent({
      actorUserId: job.requestedBy,
      subjectUserId: job.userId,
      action: "project_review.reanalysis_complete",
      resourceType: "project_review_correction",
      resourceId: job.id,
      reason: job.reason,
      outcome: "success",
      correlationId: job.id,
      metadata: {
        sourceReviewId: job.sourceReviewId,
        sourceAppealId: job.sourceAppealId,
        revision: job.revision,
        projectionApplied: outcome.projectionApplied,
        replayed: outcome.replayed,
        evidenceHash: outcome.evidenceHash,
      },
    }).catch(() => undefined);
    return {
      processed: true as const,
      succeeded: true as const,
      correctionId: job.id,
      ...outcome,
    };
  } catch (error) {
    const errorCode = await persistCorrectionFailure(job, error, now);
    await writeAuditEvent({
      actorUserId: job.requestedBy,
      subjectUserId: job.userId,
      action: "project_review.reanalysis_complete",
      resourceType: "project_review_correction",
      resourceId: job.id,
      reason: job.reason,
      outcome: "failure",
      correlationId: job.id,
      metadata: {
        sourceReviewId: job.sourceReviewId,
        sourceAppealId: job.sourceAppealId,
        revision: job.revision,
        errorCode,
      },
    }).catch(() => undefined);
    return {
      processed: true as const,
      succeeded: false as const,
      correctionId: job.id,
      errorCode,
    };
  }
}

export async function processProjectReviewCorrectionBatch(input: {
  workerId: string;
  limit?: number;
  analyzer?: ProjectReviewAnalyzer;
}) {
  const limit = input.limit ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new ProjectReviewCorrectionError("INVALID_INPUT");
  }
  const reports = [];
  for (let index = 0; index < limit; index += 1) {
    const report = await processOneProjectReviewCorrection({
      workerId: input.workerId,
      ...(input.analyzer ? { analyzer: input.analyzer } : {}),
    });
    if (!report.processed) break;
    reports.push(report);
  }
  return {
    processed: reports.length,
    succeeded: reports.filter((report) => report.succeeded).length,
    failed: reports.filter((report) => !report.succeeded).length,
    reports,
  };
}

export async function requestProjectReviewCorrectionRetry(input: {
  actorUserId: string;
  correctionId: string;
  requestId: string;
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (
    !UUID_PATTERN.test(input.correctionId)
    || !UUID_PATTERN.test(input.requestId)
    || !Number.isFinite(now.getTime())
    || reason.length < 20
    || reason.length > 500
  ) throw new ProjectReviewCorrectionError("INVALID_INPUT");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `project-review-correction-retry:${input.correctionId}`,
    ]);
    const actor = await client.query<{ role: string | null; status: string }>(
      `select role, status from "user" where id = $1 for update`,
      [input.actorUserId],
    );
    if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
      throw new ProjectReviewCorrectionError("ADMIN_REQUIRED");
    }
    const correction = await client.query<{
      id: string;
      status: string;
      attempt_count: number;
      last_error_code: string | null;
      user_id: string;
    }>(
      `select c.id, c.status, c.attempt_count, c.last_error_code, p.user_id
         from project_review_correction c
         join project p on p.id = c.project_id
        where c.id = $1 for update of c`,
      [input.correctionId],
    );
    const row = correction.rows[0];
    if (!row) throw new ProjectReviewCorrectionError("REVIEW_NOT_FOUND");
    const prior = await client.query<{
      actor_user_id: string | null;
      event: string;
      reason: string;
    }>(
      `select actor_user_id, event, reason
         from project_review_correction_event
        where correction_id = $1 and request_id = $2 for update`,
      [input.correctionId, input.requestId],
    );
    if (prior.rows[0]) {
      if (
        prior.rows[0].actor_user_id !== input.actorUserId
        || prior.rows[0].event !== "retry_queued"
        || prior.rows[0].reason !== reason
      ) throw new ProjectReviewCorrectionError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return {
        correctionId: input.correctionId,
        userId: row.user_id,
        status: row.status,
        attemptCount: Number(row.attempt_count),
        duplicate: true,
      };
    }
    if (Number(row.attempt_count) >= MAX_ATTEMPTS) {
      throw new ProjectReviewCorrectionError("CORRECTION_DEAD_LETTERED");
    }
    if (row.status !== "failed") {
      throw new ProjectReviewCorrectionError("CORRECTION_NOT_RETRYABLE");
    }
    const updated = await client.query(
      `update project_review_correction
          set status = 'queued', next_attempt_at = $2,
              dead_lettered_at = null, updated_at = $2
        where id = $1 and status = 'failed' and attempt_count < $3`,
      [input.correctionId, now, MAX_ATTEMPTS],
    );
    if (updated.rowCount !== 1) throw new ProjectReviewCorrectionError("WRITE_CONFLICT");
    await appendCorrectionEvent(client, {
      correctionId: input.correctionId,
      actorUserId: input.actorUserId,
      actorRole: "admin",
      event: "retry_queued",
      requestId: input.requestId,
      reason,
      evidence: {
        schemaVersion: 1,
        priorStatus: row.status,
        priorErrorCode: row.last_error_code,
        priorAttemptCount: Number(row.attempt_count),
        queuedAt: now.toISOString(),
      },
      now,
    });
    await client.query("commit");
    return {
      correctionId: input.correctionId,
      userId: row.user_id,
      status: "queued",
      attemptCount: Number(row.attempt_count),
      duplicate: false,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listProjectReviewCorrections(input: {
  scope?: "actionable" | "all";
  limit?: number;
} = {}) {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ProjectReviewCorrectionError("INVALID_INPUT");
  }
  const actionable = (input.scope ?? "actionable") === "actionable";
  const result = await pool.query<{
    id: string;
    project_id: string;
    project_title: string;
    user_id: string;
    learner_name: string;
    source_review_id: string;
    source_appeal_id: string | null;
    revision: number;
    source_commit_sha: string;
    status: string;
    attempt_count: number;
    last_error_code: string | null;
    projection_applied: boolean | null;
    dead_lettered_at: Date | null;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `select c.id, c.project_id, p.title as project_title, p.user_id,
            u.name as learner_name, c.source_review_id, c.source_appeal_id,
            c.revision, c.source_commit_sha, c.status, c.attempt_count,
            c.last_error_code, c.projection_applied, c.dead_lettered_at,
            c.created_at, c.completed_at
       from project_review_correction c
       join project p on p.id = c.project_id
       join "user" u on u.id = p.user_id and u.role = 'learner'
      where ($1::boolean = false or c.status in ('queued','running','failed'))
      order by c.created_at asc, c.id asc limit $2`,
    [actionable, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectTitle: row.project_title,
    userId: row.user_id,
    learnerName: row.learner_name,
    sourceReviewId: row.source_review_id,
    sourceAppealId: row.source_appeal_id,
    revision: Number(row.revision),
    sourceCommitSha: row.source_commit_sha,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    lastErrorCode: row.last_error_code,
    projectionApplied: row.projection_applied,
    deadLettered: row.dead_lettered_at !== null,
    deadLetteredAt: row.dead_lettered_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  }));
}

export async function getProjectReviewCorrection(correctionId: string) {
  if (!UUID_PATTERN.test(correctionId)) throw new ProjectReviewCorrectionError("INVALID_INPUT");
  const [main, events] = await Promise.all([
    pool.query<{
      id: string;
      project_id: string;
      project_title: string;
      user_id: string;
      learner_name: string;
      source_review_id: string;
      source_appeal_id: string | null;
      requested_by: string;
      revision: number;
      reason: string;
      source_commit_sha: string;
      source_analyzer_version: string;
      source_rubric_version: string;
      source_provenance: Record<string, unknown>;
      source_findings_hash: string;
      target_analyzer_version: string;
      target_rubric_version: string;
      status: string;
      attempt_count: number;
      last_error_code: string | null;
      result_findings: Record<string, unknown>[] | null;
      result_findings_hash: string | null;
      result_provenance: Record<string, unknown> | null;
      evidence: Record<string, unknown> | null;
      evidence_hash: string | null;
      projection_applied: boolean | null;
      created_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
      dead_lettered_at: Date | null;
    }>(
      `select c.id, c.project_id, p.title as project_title, p.user_id,
              u.name as learner_name, c.source_review_id, c.source_appeal_id,
              c.requested_by, c.revision, c.reason, c.source_commit_sha,
              c.source_analyzer_version, c.source_rubric_version,
              c.source_provenance, c.source_findings_hash,
              c.target_analyzer_version, c.target_rubric_version, c.status,
              c.attempt_count, c.last_error_code, c.result_findings,
              c.result_findings_hash, c.result_provenance, c.evidence,
              c.evidence_hash, c.projection_applied, c.created_at,
              c.started_at, c.completed_at, c.dead_lettered_at
         from project_review_correction c
         join project p on p.id = c.project_id
         join "user" u on u.id = p.user_id and u.role = 'learner'
        where c.id = $1`,
      [correctionId],
    ),
    pool.query<{
      id: string;
      actor_role: string;
      event: string;
      reason: string;
      evidence: Record<string, unknown>;
      evidence_hash: string;
      occurred_at: Date;
    }>(
      `select id, actor_role, event, reason, evidence, evidence_hash, occurred_at
         from project_review_correction_event where correction_id = $1
        order by occurred_at asc, id asc limit 200`,
      [correctionId],
    ),
  ]);
  const row = main.rows[0];
  if (!row) throw new ProjectReviewCorrectionError("REVIEW_NOT_FOUND");
  return {
    correction: {
      id: row.id,
      projectId: row.project_id,
      projectTitle: row.project_title,
      userId: row.user_id,
      learnerName: row.learner_name,
      sourceReviewId: row.source_review_id,
      sourceAppealId: row.source_appeal_id,
      requestedBy: row.requested_by,
      revision: Number(row.revision),
      reason: row.reason,
      sourceCommitSha: row.source_commit_sha,
      sourceAnalyzerVersion: row.source_analyzer_version,
      sourceRubricVersion: row.source_rubric_version,
      sourceProvenance: row.source_provenance,
      sourceFindingsHash: row.source_findings_hash,
      targetAnalyzerVersion: row.target_analyzer_version,
      targetRubricVersion: row.target_rubric_version,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      lastErrorCode: row.last_error_code,
      resultFindings: row.result_findings,
      resultFindingsHash: row.result_findings_hash,
      resultProvenance: row.result_provenance,
      evidence: row.evidence,
      evidenceHash: row.evidence_hash,
      evidenceHashValid: row.evidence !== null
        && row.evidence_hash !== null
        && hashAppealEvidence(row.evidence) === row.evidence_hash,
      projectionApplied: row.projection_applied,
      createdAt: row.created_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      deadLettered: row.dead_lettered_at !== null,
      deadLetteredAt: row.dead_lettered_at?.toISOString() ?? null,
    },
    timeline: events.rows.map((event) => ({
      id: event.id,
      actorRole: event.actor_role,
      event: event.event,
      reason: event.reason,
      evidence: event.evidence,
      evidenceHash: event.evidence_hash,
      evidenceHashValid: hashAppealEvidence(event.evidence) === event.evidence_hash,
      occurredAt: event.occurred_at.toISOString(),
    })),
  };
}
