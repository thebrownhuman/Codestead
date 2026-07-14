import type { PoolClient } from "pg";

import {
  BLUEPRINT_RESPONSE_KEY,
  RESULT_RESPONSE_KEY,
  type ExamAnswer,
  type ExamFormSnapshot,
  type ExamResult,
} from "@/lib/exams/contracts";
import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { pool } from "@/lib/db/client";

import {
  createCorrectionSchema,
  queueCorrectionSchema,
  type CreateCorrectionInput,
  type QueueCorrectionInput,
} from "./contracts";
import {
  AssessmentCorrectionError,
  buildImpactHashes,
  correctionReviewHash,
  correctionTarget,
  formMatchesTarget,
  reviewedReplacement,
  type CorrectionTarget,
  type ImpactSnapshot,
} from "./domain";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storedForm(value: unknown): ExamFormSnapshot | null {
  const snapshot = record(record(value)?.snapshot);
  if (
    snapshot?.schemaVersion !== 1
    || typeof snapshot.formId !== "string"
    || typeof snapshot.courseId !== "string"
    || typeof snapshot.moduleId !== "string"
    || typeof snapshot.contentVersion !== "string"
    || !Array.isArray(snapshot.items)
  ) return null;
  return snapshot as unknown as ExamFormSnapshot;
}

function storedResult(value: unknown): ExamResult | null {
  const candidate = record(value);
  const result = record(candidate?.result) ?? candidate;
  if (
    result?.schemaVersion !== 1
    || (result.gradingStatus !== "graded" && result.gradingStatus !== "pending-review")
    || typeof result.outcome !== "string"
    || typeof result.finalizedAt !== "string"
  ) return null;
  return result as unknown as ExamResult;
}

function storedAnswer(value: unknown): ExamAnswer {
  const answer = record(value);
  if (!answer) return {};
  return {
    ...(typeof answer.text === "string" ? { text: answer.text } : {}),
    ...(typeof answer.sourceCode === "string" ? { sourceCode: answer.sourceCode } : {}),
    ...(typeof answer.language === "string" ? { language: answer.language as ExamAnswer["language"] } : {}),
  };
}

async function requireActiveAdmin(client: PoolClient, actorUserId: string) {
  const actor = await client.query<{ role: string | null; status: string }>(
    `select role, status from "user" where id = $1 for update`,
    [actorUserId],
  );
  if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
    throw new AssessmentCorrectionError("ADMIN_REQUIRED");
  }
}

interface CandidateRow {
  attempt_id: string;
  user_id: string;
  attempt_status: string;
  policy_version: string;
  content_version: string;
  score: number | null;
  passed: boolean | null;
  mastery_awarded: boolean;
  exam_session_id: string | null;
  blueprint: Record<string, unknown>;
  original_result: Record<string, unknown> | null;
  effective_result: Record<string, unknown> | null;
}

export const MAX_CORRECTION_IMPACTS = 500;

async function affectedCandidates(client: PoolClient, target: CorrectionTarget): Promise<readonly CandidateRow[]> {
  const rows = await client.query<CandidateRow>(
    `select a.id as attempt_id, a.user_id, a.status as attempt_status,
            a.policy_version, a.content_version, a.score, a.passed,
            coalesce(a.mastery_awarded, false) as mastery_awarded,
            es.id as exam_session_id, blueprint.answer as blueprint,
            original.answer as original_result, effective.result as effective_result
       from response blueprint
       join attempt a on a.id = blueprint.attempt_id
       left join exam_session es on es.attempt_id = a.id
       left join response original
         on original.attempt_id = a.id and original.item_key = $1 and original.revision = 1
       left join assessment_attempt_effective_result effective on effective.attempt_id = a.id
      where blueprint.item_key = $2 and blueprint.revision = 1
        and a.kind in ('exam', 'retake')
        and a.status in ('graded', 'grading')
        and blueprint.answer #>> '{snapshot,courseId}' = $3
        and blueprint.answer #>> '{snapshot,moduleId}' = $4
        and blueprint.answer #>> '{snapshot,contentVersion}' = $5
      order by a.created_at asc, a.id asc
      limit $6`,
    [
      RESULT_RESPONSE_KEY,
      BLUEPRINT_RESPONSE_KEY,
      target.courseId,
      target.moduleId,
      target.contentVersion,
      MAX_CORRECTION_IMPACTS + 1,
    ],
  );
  return rows.rows;
}

async function latestAnswers(client: PoolClient, attemptId: string) {
  const rows = await client.query<{
    item_key: string;
    revision: number;
    answer: Record<string, unknown>;
  }>(
    `select distinct on (item_key) item_key, revision, answer
       from response
      where attempt_id = $1 and item_key not like '\\_\\_%' escape '\\'
      order by item_key, revision desc, saved_at desc, id desc`,
    [attemptId],
  );
  return Object.fromEntries(rows.rows.map((row) => [row.item_key, {
    revision: row.revision,
    answer: storedAnswer(row.answer),
  }]));
}

function requestFingerprint(input: CreateCorrectionInput): string {
  return hashAppealEvidence({
    schemaVersion: 1,
    appealId: input.appealId,
    itemId: input.itemId,
    defectKind: input.defectKind,
    reason: input.reason.trim(),
    replacementEvidence: input.replacementEvidence,
    review: input.review,
  });
}

async function correctionById(client: PoolClient, correctionId: string, replayed: boolean) {
  const result = await client.query<{
    id: string;
    source_appeal_id: string | null;
    status: string;
    course_id: string;
    module_id: string;
    item_id: string;
    skill_id: string;
    content_version: string;
    faulty_bundle_version: string;
    faulty_evidence_hash: string;
    replacement_bundle_version: string;
    replacement_evidence_hash: string;
    review_hash: string;
    affected_count: number;
    row_version: number | string;
    created_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
  }>(
    `select id, source_appeal_id, status, course_id, module_id, item_id, skill_id,
            content_version, faulty_bundle_version, faulty_evidence_hash,
            replacement_bundle_version, replacement_evidence_hash, review_hash,
            affected_count, row_version, created_at, started_at, completed_at
       from assessment_correction where id = $1`,
    [correctionId],
  );
  const row = result.rows[0];
  if (!row) throw new AssessmentCorrectionError("CORRECTION_NOT_FOUND");
  return {
    id: row.id,
    sourceAppealId: row.source_appeal_id,
    status: row.status,
    target: {
      courseId: row.course_id,
      moduleId: row.module_id,
      itemId: row.item_id,
      skillId: row.skill_id,
      contentVersion: row.content_version,
      faultyBundleVersion: row.faulty_bundle_version,
      faultyEvidenceHash: row.faulty_evidence_hash,
    },
    replacement: {
      bundleVersion: row.replacement_bundle_version,
      evidenceHash: row.replacement_evidence_hash,
      reviewHash: row.review_hash,
    },
    affectedCount: Number(row.affected_count),
    rowVersion: Number(row.row_version),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    replayed,
  };
}

export async function createAssessmentCorrection(inputValue: CreateCorrectionInput & {
  readonly actorUserId: string;
  readonly now?: Date;
}) {
  const parsed = createCorrectionSchema.parse({
    requestId: inputValue.requestId,
    appealId: inputValue.appealId,
    itemId: inputValue.itemId,
    defectKind: inputValue.defectKind,
    reason: inputValue.reason,
    replacementEvidence: inputValue.replacementEvidence,
    review: inputValue.review,
  });
  const now = inputValue.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("A valid correction timestamp is required.");
  const input = { ...parsed, reason: parsed.reason.trim() };
  const fingerprint = requestFingerprint(input);
  const client = await pool.connect();
  try {
    // One repeatable-read snapshot binds the impact preview to a complete,
    // internally consistent set. We fail closed rather than silently truncate
    // when the reviewed batch exceeds the operational ceiling.
    await client.query("begin isolation level repeatable read");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`assessment-correction-request:${inputValue.actorUserId}:${input.requestId}`]);
    await requireActiveAdmin(client, inputValue.actorUserId);
    const replay = await client.query<{
      id: string;
      request_hash: string | null;
    }>(
      `select c.id, e.evidence ->> 'requestHash' as request_hash
         from assessment_correction c
         left join assessment_correction_event e
           on e.correction_id = c.id and e.request_id = c.create_request_id
        where c.created_by = $1 and c.create_request_id = $2`,
      [inputValue.actorUserId, input.requestId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== fingerprint) {
        throw new AssessmentCorrectionError("IDEMPOTENCY_MISMATCH");
      }
      const report = await correctionById(client, replay.rows[0].id, true);
      await client.query("commit");
      return report;
    }

    const appealResult = await client.query<{
      id: string;
      attempt_id: string | null;
      decision: string | null;
      status: string;
    }>(
      `select id, attempt_id, decision, status from appeal where id = $1 for update`,
      [input.appealId],
    );
    const appealRow = appealResult.rows[0];
    if (!appealRow) throw new AssessmentCorrectionError("APPEAL_NOT_FOUND");
    if (!appealRow.attempt_id || appealRow.decision !== "overturned") {
      throw new AssessmentCorrectionError("APPEAL_NOT_OVERTURNED");
    }
    const sourceFormResult = await client.query<{ answer: Record<string, unknown> }>(
      `select answer from response where attempt_id = $1 and item_key = $2 and revision = 1`,
      [appealRow.attempt_id, BLUEPRINT_RESPONSE_KEY],
    );
    const sourceForm = storedForm(sourceFormResult.rows[0]?.answer);
    if (!sourceForm) throw new AssessmentCorrectionError("EXAM_EVIDENCE_MISSING");
    const target = correctionTarget(sourceForm, input.itemId);
    const replacement = reviewedReplacement(target, input.replacementEvidence);
    const replacementHash = hashAppealEvidence(replacement);
    const reviewHash = correctionReviewHash(input.review);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `assessment-correction-scope:${target.courseId}:${target.moduleId}:${target.itemId}:${target.contentVersion}:${target.faultyEvidenceHash}`,
    ]);
    const duplicateScope = await client.query<{ id: string }>(
      `select id from assessment_correction
        where course_id = $1 and module_id = $2 and item_id = $3
          and content_version = $4 and faulty_evidence_hash = $5
          and replacement_evidence_hash = $6`,
      [target.courseId, target.moduleId, target.itemId, target.contentVersion,
        target.faultyEvidenceHash, replacementHash],
    );
    if (duplicateScope.rows[0]) throw new AssessmentCorrectionError("INVALID_STATE");

    const correction = await client.query<{ id: string }>(
      `insert into assessment_correction
        (source_appeal_id, created_by, create_request_id, status, defect_kind, reason,
         course_id, module_id, item_id, skill_id, content_version,
         faulty_bundle_version, faulty_evidence_hash, replacement_bundle_version,
         replacement_evidence, replacement_evidence_hash, review_checklist, review_hash,
         affected_count, row_version, created_at, updated_at)
       values ($1,$2,$3,'reviewed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17,0,1,$18,$18)
       returning id`,
      [
        input.appealId,
        inputValue.actorUserId,
        input.requestId,
        input.defectKind,
        input.reason,
        target.courseId,
        target.moduleId,
        target.itemId,
        target.skillId,
        target.contentVersion,
        target.faultyBundleVersion,
        target.faultyEvidenceHash,
        replacement.bundleVersion,
        JSON.stringify(replacement),
        replacementHash,
        JSON.stringify(input.review),
        reviewHash,
        now,
      ],
    );
    const correctionId = correction.rows[0]!.id;
    const candidates = await affectedCandidates(client, target);
    if (candidates.length > MAX_CORRECTION_IMPACTS) {
      throw new AssessmentCorrectionError("AFFECTED_ATTEMPT_LIMIT_EXCEEDED");
    }
    let affectedCount = 0;
    const impactedAttemptIds: string[] = [];
    for (const candidate of candidates) {
      const form = storedForm(candidate.blueprint);
      if (!form || !formMatchesTarget(form, target)) continue;
      const originalResult = storedResult(candidate.effective_result ?? candidate.original_result);
      if (!originalResult) continue;
      const answers = await latestAnswers(client, candidate.attempt_id);
      const snapshot: ImpactSnapshot = {
        schemaVersion: 1,
        attempt: {
          id: candidate.attempt_id,
          userId: candidate.user_id,
          status: candidate.attempt_status,
          policyVersion: candidate.policy_version,
          contentVersion: candidate.content_version,
          score: candidate.score,
          passed: candidate.passed,
          masteryAwarded: candidate.mastery_awarded,
        },
        examSessionId: candidate.exam_session_id,
        form,
        answers,
        originalResult,
      };
      const hashes = buildImpactHashes(snapshot);
      await client.query(
        `insert into assessment_correction_impact
          (correction_id, attempt_id, exam_session_id, user_id, form_id, form_hash,
           answer_set_hash, original_result_hash, snapshot, snapshot_hash, captured_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
         on conflict (correction_id, attempt_id) do nothing`,
        [correctionId, candidate.attempt_id, candidate.exam_session_id, candidate.user_id,
          form.formId, hashes.formHash, hashes.answerSetHash, hashes.originalResultHash,
          JSON.stringify(snapshot), hashes.snapshotHash, now],
      );
      affectedCount += 1;
      impactedAttemptIds.push(candidate.attempt_id);
    }
    if (affectedCount === 0) throw new AssessmentCorrectionError("NO_AFFECTED_ATTEMPTS");
    await client.query(
      `update assessment_correction set affected_count = $2, updated_at = $3 where id = $1`,
      [correctionId, affectedCount, now],
    );
    const eventEvidence = {
      schemaVersion: 1,
      requestHash: fingerprint,
      sourceAppealId: input.appealId,
      target,
      replacementEvidenceHash: replacementHash,
      reviewHash,
      affectedCount,
      impactedAttemptHashes: impactedAttemptIds.map((id) => hashAppealEvidence(id)).sort(),
      aiRole: "none",
    };
    await client.query(
      `insert into assessment_correction_event
        (correction_id, actor_user_id, actor_role, event, request_id, reason, evidence, evidence_hash, occurred_at)
       values ($1,$2,'admin','reviewed',$3,$4,$5::jsonb,$6,$7)`,
      [correctionId, inputValue.actorUserId, input.requestId, input.reason,
        JSON.stringify(eventEvidence), hashAppealEvidence(eventEvidence), now],
    );
    const report = await correctionById(client, correctionId, false);
    await client.query("commit");
    return report;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queueAssessmentCorrection(inputValue: QueueCorrectionInput & {
  readonly actorUserId: string;
  readonly correctionId: string;
  readonly now?: Date;
}) {
  const input = queueCorrectionSchema.parse({
    requestId: inputValue.requestId,
    expectedVersion: inputValue.expectedVersion,
    reason: inputValue.reason,
  });
  const now = inputValue.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`assessment-correction:${inputValue.correctionId}`]);
    await requireActiveAdmin(client, inputValue.actorUserId);
    const rowResult = await client.query<{
      id: string;
      status: string;
      row_version: string | number;
      created_by: string;
    }>(
      `select id, status, row_version, created_by from assessment_correction where id = $1 for update`,
      [inputValue.correctionId],
    );
    const row = rowResult.rows[0];
    if (!row) throw new AssessmentCorrectionError("CORRECTION_NOT_FOUND");
    const requestHash = hashAppealEvidence({
      schemaVersion: 1,
      correctionId: inputValue.correctionId,
      expectedVersion: input.expectedVersion,
      reason: input.reason.trim(),
    });
    const replay = await client.query<{ evidence: Record<string, unknown> }>(
      `select evidence from assessment_correction_event where correction_id = $1 and request_id = $2`,
      [inputValue.correctionId, input.requestId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].evidence.requestHash !== requestHash) {
        throw new AssessmentCorrectionError("IDEMPOTENCY_MISMATCH");
      }
      const report = await correctionById(client, inputValue.correctionId, true);
      await client.query("commit");
      return report;
    }
    if (Number(row.row_version) !== input.expectedVersion) {
      throw new AssessmentCorrectionError("VERSION_CONFLICT");
    }
    if (!["reviewed", "partially_failed", "failed"].includes(row.status)) {
      throw new AssessmentCorrectionError("INVALID_STATE");
    }
    const runnable = await client.query<{ id: string }>(
      `insert into assessment_regrade_job (correction_id, impact_id, status, attempt_count, queued_at, created_at, updated_at)
       select correction_id, id, 'queued', 0, $2, $2, $2
         from assessment_correction_impact where correction_id = $1
       on conflict (impact_id) do update
         set status = 'queued'::job_status,
             runner_request_generation = assessment_regrade_job.runner_request_generation + 1,
             queued_at = excluded.queued_at,
             lease_owner = null,
             lease_expires_at = null,
             completed_at = null,
             last_error_code = null,
             updated_at = excluded.updated_at
       where assessment_regrade_job.status = 'failed'
         and (
           select count(*)
             from assessment_correction_event failure
            where failure.correction_id = assessment_regrade_job.correction_id
              and failure.event = 'regrade_failed'
              and failure.evidence->>'jobId' = assessment_regrade_job.id::text
         ) < 3
       returning id`,
      [inputValue.correctionId, now],
    );
    if (runnable.rows.length === 0) {
      throw new AssessmentCorrectionError("RETRY_LIMIT_EXHAUSTED");
    }
    const updated = await client.query(
      `update assessment_correction
          set status = 'queued', row_version = row_version + 1,
              started_at = coalesce(started_at, $3), completed_at = null, updated_at = $3
        where id = $1 and row_version = $2`,
      [inputValue.correctionId, input.expectedVersion, now],
    );
    if (updated.rowCount !== 1) throw new AssessmentCorrectionError("WRITE_CONFLICT");
    const eventEvidence = {
      schemaVersion: 1,
      requestHash,
      expectedVersion: input.expectedVersion,
      resultingVersion: input.expectedVersion + 1,
      priorStatus: row.status,
      automaticDeterministicRegrade: true,
    };
    await client.query(
      `insert into assessment_correction_event
        (correction_id, actor_user_id, actor_role, event, request_id, reason, evidence, evidence_hash, occurred_at)
       values ($1,$2,'admin','queued',$3,$4,$5::jsonb,$6,$7)`,
      [inputValue.correctionId, inputValue.actorUserId, input.requestId, input.reason.trim(),
        JSON.stringify(eventEvidence), hashAppealEvidence(eventEvidence), now],
    );
    const report = await correctionById(client, inputValue.correctionId, false);
    await client.query("commit");
    return report;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listAssessmentCorrections(input: {
  readonly scope?: "open" | "all";
  readonly limit?: number;
} = {}) {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Correction list limit must be from 1 to 100.");
  const result = await pool.query<{
    id: string;
    source_appeal_id: string;
    status: string;
    defect_kind: string;
    course_id: string;
    module_id: string;
    item_id: string;
    content_version: string;
    faulty_bundle_version: string;
    replacement_bundle_version: string;
    affected_count: number;
    row_version: string | number;
    created_at: Date;
    completed_at: Date | null;
    succeeded: number;
    failed: number;
    pending: number;
    mastery_repairs_applied: number;
    mastery_repairs_unresolved: number;
    mastery_repairs_pending: number;
  }>(
    `select c.id, c.source_appeal_id, c.status, c.defect_kind, c.course_id,
            c.module_id, c.item_id, c.content_version, c.faulty_bundle_version,
            c.replacement_bundle_version, c.affected_count, c.row_version,
            c.created_at, c.completed_at,
            count(j.id) filter (where j.status = 'succeeded')::int as succeeded,
            count(j.id) filter (where j.status in ('failed','timed_out'))::int as failed,
            count(j.id) filter (where j.status in ('queued','leased','running'))::int as pending,
            (select count(*)::int from assessment_mastery_projection_repair p
              join assessment_regrade_outcome o on o.id = p.outcome_id
             where o.correction_id = c.id and p.status = 'applied') as mastery_repairs_applied,
            (select count(*)::int from assessment_mastery_projection_repair p
              join assessment_regrade_outcome o on o.id = p.outcome_id
             where o.correction_id = c.id and p.status = 'unresolved') as mastery_repairs_unresolved,
            (select count(*)::int from assessment_mastery_projection_repair p
              join assessment_regrade_outcome o on o.id = p.outcome_id
             where o.correction_id = c.id and p.status = 'pending') as mastery_repairs_pending
       from assessment_correction c
       left join assessment_regrade_job j on j.correction_id = c.id
      where ($1::boolean = false or c.status <> 'completed')
      group by c.id
      order by c.created_at desc, c.id desc
      limit $2`,
    [(input.scope ?? "open") === "open", limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    sourceAppealId: row.source_appeal_id,
    status: row.status,
    defectKind: row.defect_kind,
    courseId: row.course_id,
    moduleId: row.module_id,
    itemId: row.item_id,
    contentVersion: row.content_version,
    faultyBundleVersion: row.faulty_bundle_version,
    replacementBundleVersion: row.replacement_bundle_version,
    affectedCount: Number(row.affected_count),
    rowVersion: Number(row.row_version),
    jobs: { succeeded: Number(row.succeeded), failed: Number(row.failed), pending: Number(row.pending) },
    masteryRepairs: {
      applied: Number(row.mastery_repairs_applied),
      unresolved: Number(row.mastery_repairs_unresolved),
      pending: Number(row.mastery_repairs_pending),
    },
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  }));
}

export async function getAssessmentCorrectionDetail(correctionId: string) {
  const client = await pool.connect();
  try {
    const correction = await correctionById(client, correctionId, false);
    const events = await client.query<{
        id: string;
        actor_role: string;
        event: string;
        reason: string;
        evidence_hash: string;
        occurred_at: Date;
      }>(
        `select id, actor_role, event, reason, evidence_hash, occurred_at
           from assessment_correction_event where correction_id = $1
          order by occurred_at asc, id asc`,
        [correctionId],
      );
    const impacts = await client.query<{
        id: string;
        attempt_id: string;
        exam_session_id: string | null;
        user_id: string;
        learner_name: string;
        form_id: string;
        form_hash: string;
        answer_set_hash: string;
        original_result_hash: string;
        snapshot_hash: string;
        job_status: string | null;
        attempt_count: number | null;
        corrected_result: Record<string, unknown> | null;
        corrected_result_hash: string | null;
        captured_at: Date;
      }>(
        `select i.id, i.attempt_id, i.exam_session_id, i.user_id, u.name as learner_name,
                i.form_id, i.form_hash, i.answer_set_hash, i.original_result_hash,
                i.snapshot_hash, j.status as job_status, j.attempt_count,
                o.corrected_result, o.corrected_result_hash, i.captured_at
           from assessment_correction_impact i
           join "user" u on u.id = i.user_id
           left join assessment_regrade_job j on j.impact_id = i.id
           left join assessment_regrade_outcome o on o.impact_id = i.id
          where i.correction_id = $1
          order by i.captured_at asc, i.id asc`,
        [correctionId],
      );
    const masteryRepairs = await client.query<{
      id: string;
      attempt_id: string;
      skill_id: string;
      language_context: string;
      effect: string;
      status: string;
      attempt_count: number;
      last_error_code: string | null;
      resolution_code: string | null;
      applied_at: Date | null;
      updated_at: Date;
    }>(
      `select p.id, p.attempt_id, p.skill_id, p.language_context, p.effect,
              p.status, p.attempt_count, p.last_error_code, p.resolution_code,
              p.applied_at, p.updated_at
         from assessment_mastery_projection_repair p
         join assessment_regrade_outcome o on o.id = p.outcome_id
        where o.correction_id = $1
        order by p.created_at, p.id`,
      [correctionId],
    );
    return {
      correction,
      events: events.rows.map((row) => ({
        id: row.id,
        actorRole: row.actor_role,
        event: row.event,
        reason: row.reason,
        evidenceHash: row.evidence_hash,
        occurredAt: row.occurred_at.toISOString(),
      })),
      impacts: impacts.rows.map((row) => ({
        id: row.id,
        attemptId: row.attempt_id,
        examSessionId: row.exam_session_id,
        userId: row.user_id,
        learnerName: row.learner_name,
        formId: row.form_id,
        hashes: {
          form: row.form_hash,
          answers: row.answer_set_hash,
          originalResult: row.original_result_hash,
          snapshot: row.snapshot_hash,
          correctedResult: row.corrected_result_hash,
        },
        jobStatus: row.job_status ?? "not_queued",
        attemptCount: Number(row.attempt_count ?? 0),
        correctedResult: row.corrected_result,
        capturedAt: row.captured_at.toISOString(),
      })),
      masteryRepairs: masteryRepairs.rows.map((row) => ({
        id: row.id,
        attemptId: row.attempt_id,
        skillId: row.skill_id,
        languageContext: row.language_context,
        effect: row.effect,
        status: row.status,
        attemptCount: Number(row.attempt_count),
        errorCode: row.last_error_code,
        resolutionCode: row.resolution_code,
        appliedAt: row.applied_at?.toISOString() ?? null,
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  } finally {
    client.release();
  }
}

export function assessmentCorrectionErrorStatus(error: unknown): number {
  if (!(error instanceof AssessmentCorrectionError)) return 500;
  if (error.code === "ADMIN_REQUIRED") return 403;
  if (error.code === "APPEAL_NOT_FOUND" || error.code === "CORRECTION_NOT_FOUND") return 404;
  if (["ITEM_NOT_FOUND", "ITEM_NOT_DETERMINISTIC", "REPLACEMENT_VERSION_REUSED", "HIDDEN_TEST_COVERAGE_REMOVED", "NO_AFFECTED_ATTEMPTS", "EXAM_EVIDENCE_MISSING"].includes(error.code)) return 400;
  if (error.code === "AFFECTED_ATTEMPT_LIMIT_EXCEEDED" || error.code === "RETRY_LIMIT_EXHAUSTED") return 409;
  return 409;
}
