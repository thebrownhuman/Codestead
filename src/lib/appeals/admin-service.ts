import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import {
  BLUEPRINT_RESPONSE_KEY,
  RESULT_RESPONSE_KEY,
  toPublicExamForm,
  type ExamFormSnapshot,
  type ExamResult,
} from "@/lib/exams/contracts";
import { pool } from "@/lib/db/client";
import { queueProjectReviewCorrectionWithClient } from "@/lib/projects/review-correction-service";

import { hashAppealEvidence } from "./evidence";

export type AppealDecision = "needs_learner_input" | "upheld" | "overturned";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONABLE_STATUSES = ["open", "under_review", "needs_learner_input"] as const;

export class AppealAdminError extends Error {
  constructor(
    public readonly code:
      | "ADMIN_REQUIRED"
      | "APPEAL_NOT_FOUND"
      | "VERSION_CONFLICT"
      | "ALREADY_DECIDED"
      | "IDEMPOTENCY_MISMATCH"
      | "CORRECTIVE_ACTION_REQUIRED"
      | "WRITE_CONFLICT",
  ) {
    super(code);
  }
}

export interface AppealDecisionReport {
  readonly appealId: string;
  readonly userId: string;
  readonly decision: AppealDecision;
  readonly status: string;
  readonly rowVersion: number;
  readonly decidedAt: string;
  readonly examSessionId: string | null;
  readonly correctionPending: boolean;
  readonly projectReviewCorrectionId: string | null;
  readonly projectReviewCorrectionStatus: string | null;
  readonly projectReviewCorrectionRevision: number | null;
  readonly replayed: boolean;
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function resultFromStored(value: unknown): ExamResult | null {
  if (!value || typeof value !== "object") return null;
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  return result as ExamResult;
}

function publicFormFromStored(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const snapshot = (value as { snapshot?: unknown }).snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  try {
    return toPublicExamForm(snapshot as ExamFormSnapshot);
  } catch {
    return null;
  }
}

export async function listAdminAppeals(input: {
  scope?: "actionable" | "all";
  limit?: number;
} = {}) {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Appeal list limit must be from 1 to 200.");
  }
  const actionable = (input.scope ?? "actionable") === "actionable";
  const result = await pool.query<{
    id: string;
    user_id: string;
    learner_public_id: string;
    learner_name: string;
    category: string;
    reason: string;
    status: string;
    decision: string | null;
    attempt_id: string | null;
    project_review_id: string | null;
    exam_session_id: string | null;
    row_version: string | number;
    created_at: Date;
    updated_at: Date;
    decided_at: Date | null;
  }>(
    `select a.id, a.user_id, u.public_id::text as learner_public_id,
            u.name as learner_name, a.category, a.reason, a.status, a.decision,
            a.attempt_id, a.project_review_id, es.id as exam_session_id, a.row_version,
            a.created_at, a.updated_at, a.decided_at
       from appeal a
       join "user" u on u.id = a.user_id and u.role = 'learner'
       left join exam_session es on es.attempt_id = a.attempt_id
      where ($1::boolean = false or a.status = any($2::text[]))
      order by case when a.status = 'needs_learner_input' then 1 else 0 end,
               a.created_at asc, a.id asc
      limit $3`,
    [actionable, ACTIONABLE_STATUSES, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    learnerPublicId: row.learner_public_id,
    learnerName: row.learner_name,
    category: row.category,
    reason: row.reason,
    status: row.status,
    decision: row.decision,
    target: row.attempt_id ? "exam_attempt" as const : "project_review" as const,
    attemptId: row.attempt_id,
    projectReviewId: row.project_review_id,
    examSessionId: row.exam_session_id,
    rowVersion: Number(row.row_version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    decidedAt: iso(row.decided_at),
  }));
}

export async function getAppealSubject(appealId: string) {
  const result = await pool.query<{ id: string; user_id: string; status: string }>(
    `select a.id, a.user_id, a.status
       from appeal a join "user" u on u.id = a.user_id and u.role = 'learner'
      where a.id = $1`,
    [appealId],
  );
  return result.rows[0] ?? null;
}

export async function getAdminAppealDetail(appealId: string) {
  const main = await pool.query<{
    id: string;
    user_id: string;
    learner_public_id: string;
    learner_name: string;
    learner_email: string;
    category: string;
    reason: string;
    evidence: Record<string, unknown>;
    evidence_hash: string;
    status: string;
    decision: string | null;
    decision_reason: string | null;
    row_version: string | number;
    created_at: Date;
    updated_at: Date;
    decided_at: Date | null;
    attempt_id: string | null;
    attempt_kind: string | null;
    attempt_status: string | null;
    attempt_score: number | null;
    attempt_passed: boolean | null;
    policy_version: string | null;
    content_version: string | null;
    exam_session_id: string | null;
    exam_status: string | null;
    integrity_review_state: string | null;
    project_review_id: string | null;
    project_id: string | null;
    project_title: string | null;
    review_commit_sha: string | null;
    review_analyzer_version: string | null;
    review_rubric_version: string | null;
    review_provenance: Record<string, unknown> | null;
    review_findings_hash: string | null;
    review_status: string | null;
    correction_id: string | null;
    correction_status: string | null;
    correction_revision: number | null;
    correction_reason: string | null;
    correction_source_findings_hash: string | null;
    correction_result_findings_hash: string | null;
    correction_evidence: Record<string, unknown> | null;
    correction_evidence_hash: string | null;
    correction_projection_applied: boolean | null;
    correction_attempt_count: number | null;
    correction_last_error_code: string | null;
    correction_completed_at: Date | null;
  }>(
    `select a.id, a.user_id, u.public_id::text as learner_public_id,
            u.name as learner_name, u.email as learner_email,
            a.category, a.reason, a.evidence, a.evidence_hash,
            a.status, a.decision, a.decision_reason, a.row_version,
            a.created_at, a.updated_at, a.decided_at, a.attempt_id,
            t.kind as attempt_kind, t.status as attempt_status, t.score as attempt_score,
            t.passed as attempt_passed, t.policy_version, t.content_version,
            es.id as exam_session_id, es.status as exam_status,
            es.integrity_review_state, a.project_review_id,
            p.id as project_id, p.title as project_title,
            pr.commit_sha as review_commit_sha,
            pr.analyzer_version as review_analyzer_version,
            pr.rubric_version as review_rubric_version,
            pr.analysis_provenance as review_provenance,
            pr.findings_hash as review_findings_hash,
            pr.status as review_status,
            prc.id as correction_id, prc.status as correction_status,
            prc.revision as correction_revision, prc.reason as correction_reason,
            prc.source_findings_hash as correction_source_findings_hash,
            prc.result_findings_hash as correction_result_findings_hash,
            prc.evidence as correction_evidence,
            prc.evidence_hash as correction_evidence_hash,
            prc.projection_applied as correction_projection_applied,
            prc.attempt_count as correction_attempt_count,
            prc.last_error_code as correction_last_error_code,
            prc.completed_at as correction_completed_at
       from appeal a
       join "user" u on u.id = a.user_id and u.role = 'learner'
       left join attempt t on t.id = a.attempt_id
       left join exam_session es on es.attempt_id = a.attempt_id
       left join project_review pr on pr.id = a.project_review_id
       left join project p on p.id = pr.project_id
       left join project_review_correction prc on prc.source_appeal_id = a.id
      where a.id = $1`,
    [appealId],
  );
  const row = main.rows[0];
  if (!row) throw new AppealAdminError("APPEAL_NOT_FOUND");
  const [timeline, responses, submissions, integrityEvents, correctionEvents] = await Promise.all([
    pool.query<{
      id: string;
      actor_role: string;
      event: string;
      reason: string;
      evidence: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `select id, actor_role, event, reason, evidence, occurred_at
         from appeal_event where appeal_id = $1
        order by occurred_at asc, id asc limit 200`,
      [appealId],
    ),
    row.attempt_id
      ? pool.query<{
          item_key: string;
          revision: number;
          answer: Record<string, unknown>;
          source: string;
          saved_at: Date;
          submitted_at: Date | null;
        }>(
          `select item_key, revision, answer, source, saved_at, submitted_at
             from response where attempt_id = $1
            order by saved_at asc, id asc limit 500`,
          [row.attempt_id],
        )
      : Promise.resolve({ rows: [] }),
    row.attempt_id
      ? pool.query<{
          id: string;
          language: string;
          source_code: string;
          source_truncated: boolean;
          source_hash: string;
          runtime_image_digest: string;
          status: string;
          created_at: Date;
        }>(
          `select id, language, left(source_code, 524288) as source_code,
                  octet_length(source_code) > 524288 as source_truncated,
                  source_hash, runtime_image_digest, status, created_at
             from code_submission where attempt_id = $1
            order by created_at asc, id asc limit 100`,
          [row.attempt_id],
        )
      : Promise.resolve({ rows: [] }),
    row.exam_session_id
      ? pool.query<{
          id: string;
          type: string;
          metadata: Record<string, unknown>;
          occurred_at: Date;
        }>(
          `select id, type, metadata, occurred_at from exam_event
            where exam_session_id = $1
            order by occurred_at asc, id asc limit 1000`,
          [row.exam_session_id],
        )
      : Promise.resolve({ rows: [] }),
    row.correction_id
      ? pool.query<{
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
          [row.correction_id],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const blueprintRow = responses.rows.find((entry) => entry.item_key === BLUEPRINT_RESPONSE_KEY);
  const resultRow = responses.rows.find((entry) => entry.item_key === RESULT_RESPONSE_KEY);
  const answers = responses.rows
    .filter((entry) => !entry.item_key.startsWith("__"))
    .map((entry) => ({
      itemId: entry.item_key,
      revision: entry.revision,
      answer: entry.answer,
      source: entry.source,
      savedAt: entry.saved_at.toISOString(),
      submittedAt: iso(entry.submitted_at),
    }));
  return {
    appeal: {
      id: row.id,
      userId: row.user_id,
      learnerPublicId: row.learner_public_id,
      learnerName: row.learner_name,
      learnerEmail: row.learner_email,
      category: row.category,
      reason: row.reason,
      status: row.status,
      decision: row.decision,
      decisionReason: row.decision_reason,
      evidenceHash: row.evidence_hash,
      evidenceHashValid: hashAppealEvidence(row.evidence) === row.evidence_hash,
      evidence: row.evidence,
      rowVersion: Number(row.row_version),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      decidedAt: iso(row.decided_at),
    },
    target: {
      attemptId: row.attempt_id,
      attemptKind: row.attempt_kind,
      attemptStatus: row.attempt_status,
      score: row.attempt_score,
      passed: row.attempt_passed,
      policyVersion: row.policy_version,
      contentVersion: row.content_version,
      examSessionId: row.exam_session_id,
      examStatus: row.exam_status,
      integrityReviewState: row.integrity_review_state,
      projectReviewId: row.project_review_id,
      projectId: row.project_id,
      projectTitle: row.project_title,
      reviewCommitSha: row.review_commit_sha,
      reviewAnalyzerVersion: row.review_analyzer_version,
      reviewRubricVersion: row.review_rubric_version,
      reviewProvenance: row.review_provenance,
      reviewFindingsHash: row.review_findings_hash,
      reviewStatus: row.review_status,
    },
    projectCorrection: row.correction_id ? {
      id: row.correction_id,
      status: row.correction_status,
      revision: Number(row.correction_revision),
      reason: row.correction_reason,
      sourceFindingsHash: row.correction_source_findings_hash,
      resultFindingsHash: row.correction_result_findings_hash,
      evidence: row.correction_evidence,
      evidenceHash: row.correction_evidence_hash,
      evidenceHashValid: row.correction_evidence !== null
        && row.correction_evidence_hash !== null
        && hashAppealEvidence(row.correction_evidence) === row.correction_evidence_hash,
      projectionApplied: row.correction_projection_applied,
      attemptCount: Number(row.correction_attempt_count ?? 0),
      lastErrorCode: row.correction_last_error_code,
      completedAt: iso(row.correction_completed_at),
      timeline: correctionEvents.rows.map((event) => ({
        id: event.id,
        actorRole: event.actor_role,
        event: event.event,
        reason: event.reason,
        evidence: event.evidence,
        evidenceHash: event.evidence_hash,
        evidenceHashValid: hashAppealEvidence(event.evidence) === event.evidence_hash,
        occurredAt: event.occurred_at.toISOString(),
      })),
    } : null,
    publicForm: publicFormFromStored(blueprintRow?.answer),
    originalResult: resultFromStored(resultRow?.answer),
    answers,
    codeSubmissions: submissions.rows.map((entry) => ({
      id: entry.id,
      language: entry.language,
      sourceCode: entry.source_code,
      sourceTruncated: entry.source_truncated,
      sourceHash: entry.source_hash,
      runtimeImageDigest: entry.runtime_image_digest,
      status: entry.status,
      createdAt: entry.created_at.toISOString(),
    })),
    integrityEvents: integrityEvents.rows.map((entry) => ({
      id: entry.id,
      type: entry.type,
      metadata: entry.metadata,
      occurredAt: entry.occurred_at.toISOString(),
    })),
    timeline: timeline.rows.map((entry) => ({
      id: entry.id,
      actorRole: entry.actor_role,
      event: entry.event,
      reason: entry.reason,
      evidence: entry.evidence,
      occurredAt: entry.occurred_at.toISOString(),
    })),
  };
}

function notificationCopy(
  decision: AppealDecision,
  reason: string,
  target: "exam_attempt" | "project_review",
) {
  if (decision === "needs_learner_input") {
    return {
      title: "Your appeal needs more information",
      body: `The reviewer asked for more information: ${reason}`,
    };
  }
  if (decision === "overturned") {
    if (target === "project_review") {
      return {
        title: "Your project-review appeal was granted",
        body: `The original review remains preserved and an exact-commit deterministic static re-analysis was queued: ${reason}`,
      };
    }
    return {
      title: "Your appeal was granted",
      body: `The original result was overturned and corrective review is pending: ${reason}`,
    };
  }
  return {
    title: "The original result was upheld",
    body: `The reviewer upheld the original result: ${reason}`,
  };
}

async function currentDecisionReport(
  client: PoolClient,
  appealId: string,
  replayed: boolean,
): Promise<AppealDecisionReport> {
  const current = await client.query<{
    id: string;
    user_id: string;
    decision: AppealDecision;
    status: string;
    row_version: string | number;
    decided_at: Date;
    exam_session_id: string | null;
    project_review_id: string | null;
    correction_id: string | null;
    correction_status: string | null;
    correction_revision: number | null;
  }>(
    `select a.id, a.user_id, a.decision, a.status, a.row_version, a.decided_at,
            es.id as exam_session_id, a.project_review_id,
            prc.id as correction_id, prc.status as correction_status,
            prc.revision as correction_revision
       from appeal a
       left join exam_session es on es.attempt_id = a.attempt_id
       left join project_review_correction prc on prc.source_appeal_id = a.id
      where a.id = $1`,
    [appealId],
  );
  const row = current.rows[0];
  if (!row?.decision || !row.decided_at) throw new AppealAdminError("WRITE_CONFLICT");
  return {
    appealId: row.id,
    userId: row.user_id,
    decision: row.decision,
    status: row.status,
    rowVersion: Number(row.row_version),
    decidedAt: row.decided_at.toISOString(),
    examSessionId: row.exam_session_id,
    correctionPending: row.decision === "overturned"
      && (row.project_review_id === null || row.correction_status !== "succeeded"),
    projectReviewCorrectionId: row.correction_id,
    projectReviewCorrectionStatus: row.correction_status,
    projectReviewCorrectionRevision: row.correction_revision === null
      ? null
      : Number(row.correction_revision),
    replayed,
  };
}

export async function decideAppeal(input: {
  actorUserId: string;
  appealId: string;
  requestId: string;
  expectedVersion: number;
  decision: AppealDecision;
  reason: string;
  correctiveAction?: string;
  now?: Date;
}): Promise<AppealDecisionReport> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  const correctiveAction = input.correctiveAction?.trim();
  if (!Number.isFinite(now.getTime())) throw new Error("A valid decision timestamp is required.");
  if (!UUID_PATTERN.test(input.requestId)) throw new Error("requestId must be a UUID.");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error("expectedVersion must be a positive integer.");
  }
  if (reason.length < 20 || reason.length > 2000) {
    throw new Error("A decision reason from 20 to 2000 characters is required.");
  }
  if (input.decision === "overturned" && (!correctiveAction || correctiveAction.length < 20)) {
    throw new AppealAdminError("CORRECTIVE_ACTION_REQUIRED");
  }
  if (correctiveAction && correctiveAction.length > 2000) {
    throw new Error("Corrective action must not exceed 2000 characters.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`appeal-decision:${input.appealId}`]);
    const actor = await client.query<{ role: string | null; status: string }>(
      `select role, status from "user" where id = $1 for update`,
      [input.actorUserId],
    );
    if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
      throw new AppealAdminError("ADMIN_REQUIRED");
    }
    const candidate = await client.query<{
      id: string;
      user_id: string;
      learner_name: string;
      learner_email: string;
      attempt_id: string | null;
      project_review_id: string | null;
      status: string;
      evidence_hash: string;
      row_version: string | number;
      exam_session_id: string | null;
      attempt_status: string | null;
    }>(
      `select a.id, a.user_id, u.name as learner_name, u.email as learner_email,
              a.attempt_id, a.project_review_id, a.status, a.evidence_hash, a.row_version,
              es.id as exam_session_id, t.status as attempt_status
         from appeal a
         join "user" u on u.id = a.user_id and u.role = 'learner'
         left join attempt t on t.id = a.attempt_id
         left join exam_session es on es.attempt_id = a.attempt_id
        where a.id = $1 for update of a`,
      [input.appealId],
    );
    const row = candidate.rows[0];
    if (!row) throw new AppealAdminError("APPEAL_NOT_FOUND");
    const priorEvent = await client.query<{
      actor_user_id: string | null;
      event: string;
      reason: string;
      evidence: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `select actor_user_id, event, reason, evidence, occurred_at from appeal_event
        where appeal_id = $1 and client_request_id = $2 for update`,
      [input.appealId, input.requestId],
    );
    if (priorEvent.rows[0]) {
      const prior = priorEvent.rows[0];
      if (
        prior.actor_user_id !== input.actorUserId
        || prior.event !== input.decision
        || prior.reason !== reason
        || (prior.evidence.correctiveAction ?? null) !== (correctiveAction ?? null)
      ) {
        throw new AppealAdminError("IDEMPOTENCY_MISMATCH");
      }
      const report = await currentDecisionReport(client, input.appealId, true);
      await client.query("commit");
      return report;
    }
    if (!ACTIONABLE_STATUSES.includes(row.status as (typeof ACTIONABLE_STATUSES)[number])) {
      throw new AppealAdminError("ALREADY_DECIDED");
    }
    if (Number(row.row_version) !== input.expectedVersion) {
      throw new AppealAdminError("VERSION_CONFLICT");
    }
    await client.query(
      `insert into appeal_event
        (appeal_id, actor_user_id, actor_role, event, client_request_id, reason, evidence, occurred_at)
       values ($1, $2, 'admin', $3, $4, $5, $6::jsonb, $7)`,
      [
        input.appealId,
        input.actorUserId,
        input.decision,
        input.requestId,
        reason,
        JSON.stringify({
          priorStatus: row.status,
          priorVersion: Number(row.row_version),
          resultingVersion: input.expectedVersion + 1,
          resultingStatus: input.decision,
          sourceEvidenceHash: row.evidence_hash,
          ...(correctiveAction ? { correctiveAction } : {}),
        }),
        now,
      ],
    );
    const updated = await client.query(
      `update appeal
          set status = $2, decision = $2, decision_reason = $3,
              decided_by = $4, decided_at = $5,
              row_version = row_version + 1, updated_at = $5
        where id = $1 and row_version = $6
          and status = any($7::text[])`,
      [
        input.appealId,
        input.decision,
        reason,
        input.actorUserId,
        now,
        input.expectedVersion,
        ACTIONABLE_STATUSES,
      ],
    );
    if (updated.rowCount !== 1) throw new AppealAdminError("WRITE_CONFLICT");
    if (row.exam_session_id) {
      const examStatus = input.decision === "upheld" && row.attempt_status === "graded"
        ? "graded"
        : "under_review";
      const integrityState = input.decision === "needs_learner_input"
        ? "appeal_needs_learner_input"
        : input.decision === "overturned"
          ? "appeal_overturned_correction_pending"
          : row.attempt_status === "graded"
            ? "appeal_upheld"
            : "appeal_upheld_manual_grading_pending";
      await client.query(
        `update exam_session set status = $2, integrity_review_state = $3, updated_at = $4
          where id = $1`,
        [row.exam_session_id, examStatus, integrityState, now],
      );
    }
    if (input.decision === "overturned" && row.project_review_id) {
      await queueProjectReviewCorrectionWithClient(client, {
        actorUserId: input.actorUserId,
        sourceReviewId: row.project_review_id,
        sourceAppealId: input.appealId,
        requestId: input.requestId,
        reason: correctiveAction!,
        now,
      });
    }
    const copy = notificationCopy(
      input.decision,
      reason,
      row.project_review_id ? "project_review" : "exam_attempt",
    );
    const actionPath = row.exam_session_id
      ? `/exams/${row.exam_session_id}`
      : row.project_review_id
        ? "/projects"
        : "/exams";
    await client.query(
      `insert into notification (user_id, type, title, body, action_url, created_at)
       values ($1, 'appeal-updated', $2, $3, $4, $5)`,
      [row.user_id, copy.title, copy.body, actionPath, now],
    );
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const mailKey = createHash("sha256")
      .update(`appeal-updated:${row.learner_email.toLowerCase()}:${input.appealId}:${input.requestId}`)
      .digest("hex");
    await client.query(
      `insert into email_outbox
        (user_id, to_email, template, template_version, variables, idempotency_key, status)
       values ($1, lower($2), 'appeal-updated', '1', $3::jsonb, $4, 'pending')
       on conflict (idempotency_key) do nothing`,
      [
        row.user_id,
        row.learner_email,
        JSON.stringify({
          name: row.learner_name,
          decision: input.decision,
          url: `${appUrl}${actionPath}`,
        }),
        mailKey,
      ],
    );
    const report = await currentDecisionReport(client, input.appealId, false);
    await client.query("commit");
    return report;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
