import { createHash, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  type ExamResult,
  type ExamRunnerResult,
} from "@/lib/exams/contracts";
import { gradeExamSubmission } from "@/app/api/exams/_lib/policy";
import { EXAM_MASTERY_RULE_VERSION, examModuleMasterySlug } from "@/lib/achievements/exam-mastery";
import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { pool } from "@/lib/db/client";
import { runtimeByLanguage } from "@/lib/runner/client";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";

import { replacementEvidenceSchema, type ReplacementEvidence } from "./contracts";
import { reconcileAssessmentCorrectionCompletion } from "./completion";
import {
  AssessmentCorrectionError,
  correctionMasteryLanguageContext,
  correctionTarget,
  effectiveAnswers,
  masteryEffect,
  replaceFormEvidence,
  reviewedReplacement,
  runnerEvidenceManifest,
  verifyImpactSnapshot,
  type CorrectionTarget,
  type ImpactSnapshot,
} from "./domain";
import { applyAssessmentMasteryProjectionRepair } from "./mastery-repair";

import {
  configuredRegradeExecutor,
  type RegradeExecutor,
} from "./runner-executor";
export { configuredRegradeExecutor, type RegradeExecutionInput, type RegradeExecutor } from "./runner-executor";

interface ClaimedJob {
  readonly id: string;
  readonly correctionId: string;
  readonly impactId: string;
  readonly attemptId: string;
  readonly userId: string;
  readonly examSessionId: string | null;
  readonly attemptCount: number;
  readonly runnerRequestGeneration: number;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: Date;
  readonly snapshot: ImpactSnapshot;
  readonly snapshotHash: string;
  readonly formHash: string;
  readonly answerSetHash: string;
  readonly originalResultHash: string;
  readonly replacement: ReplacementEvidence;
  readonly expectedRuntimeImageDigest: string;
  readonly target: CorrectionTarget;
  readonly createdBy: string;
  readonly sourceAppealId: string | null;
  readonly reviewHash: string;
}

async function appendCorrectionEvent(client: PoolClient, input: {
  correctionId: string;
  actorUserId?: string;
  actorRole: "admin" | "system";
  event: "reviewed" | "queued" | "regrade_started" | "regrade_succeeded" | "regrade_failed" | "mastery_projection_applied" | "mastery_projection_unresolved" | "completed";
  reason: string;
  evidence: Record<string, unknown>;
  now: Date;
}) {
  const requestId = randomUUID();
  await client.query(
    `insert into assessment_correction_event
      (correction_id, actor_user_id, actor_role, event, request_id, reason, evidence, evidence_hash, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [input.correctionId, input.actorUserId ?? null, input.actorRole, input.event, requestId,
      input.reason, JSON.stringify(input.evidence), hashAppealEvidence(input.evidence), input.now],
  );
}

async function claimJob(workerId: string, correctionId: string | undefined, now: Date): Promise<ClaimedJob | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const leaseExpiresAt = new Date(now.getTime() + 10 * 60_000);
    const expired = await client.query<{
      id: string;
      correction_id: string;
      attempt_count: number;
      runner_request_generation: number;
    }>(
      `select j.id, j.correction_id, j.attempt_count, j.runner_request_generation
         from assessment_regrade_job j
        where j.status = 'running' and j.lease_expires_at <= $1
        order by j.lease_expires_at, j.id
        for update of j skip locked`,
      [now],
    );
    for (const row of expired.rows) {
      const recovered = await client.query(
        `update assessment_regrade_job
            set status = 'queued', lease_owner = null, lease_expires_at = null,
                last_error_code = 'WORKER_LEASE_EXPIRED_RECONCILING', updated_at = $1
          where id = $2 and status = 'running' and lease_expires_at <= $1
          returning id`,
        [now, row.id],
      );
      if (recovered.rowCount !== 1) throw new AssessmentCorrectionError("WRITE_CONFLICT");
      if (row.attempt_count >= 3) {
        await appendCorrectionEvent(client, {
          correctionId: row.correction_id,
          actorRole: "system",
          event: "queued",
          reason: "Expired worker lease retained for exact same-generation runner admission reconciliation.",
          evidence: {
            schemaVersion: 1,
            jobId: row.id,
            expiredLeaseAttempt: row.attempt_count,
            runnerRequestGeneration: row.runner_request_generation,
            reconciliation: "same_runner_request_generation",
          },
          now,
        });
      }
    }
    const result = await client.query<{
      id: string;
      correction_id: string;
      impact_id: string;
      attempt_count: number;
      runner_request_generation: number;
      attempt_id: string;
      user_id: string;
      exam_session_id: string | null;
      snapshot: ImpactSnapshot;
      snapshot_hash: string;
      form_hash: string;
      answer_set_hash: string;
      original_result_hash: string;
      replacement_evidence: Record<string, unknown>;
      faulty_bundle_version: string;
      faulty_evidence_hash: string;
      course_id: string;
      module_id: string;
      item_id: string;
      skill_id: string;
      content_version: string;
      created_by: string;
      source_appeal_id: string | null;
      review_hash: string;
    }>(
      `select j.id, j.correction_id, j.impact_id, j.attempt_count,j.runner_request_generation,
              i.attempt_id, i.user_id, i.exam_session_id, i.snapshot,
              i.snapshot_hash, i.form_hash, i.answer_set_hash, i.original_result_hash,
              c.replacement_evidence, c.faulty_bundle_version, c.faulty_evidence_hash,
              c.course_id, c.module_id, c.item_id, c.skill_id, c.content_version,
              c.created_by, c.source_appeal_id, c.review_hash
         from assessment_regrade_job j
         join assessment_correction_impact i on i.id = j.impact_id
         join assessment_correction c on c.id = j.correction_id
        where j.status = 'queued' and ($1::uuid is null or j.correction_id = $1)
        order by j.queued_at asc, j.id asc
        for update of j skip locked
        limit 1`,
      [correctionId ?? null],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("commit");
      return null;
    }
    const targetFromSnapshot = correctionTarget(row.snapshot.form, row.item_id);
    const target: CorrectionTarget = {
      ...targetFromSnapshot,
      courseId: row.course_id,
      moduleId: row.module_id,
      itemId: row.item_id,
      skillId: row.skill_id,
      contentVersion: row.content_version,
      faultyBundleVersion: row.faulty_bundle_version,
      faultyEvidenceHash: row.faulty_evidence_hash,
    };
    const replacement = reviewedReplacement(target, replacementEvidenceSchema.parse(row.replacement_evidence));
    await client.query(
      `update assessment_regrade_job
          set status = 'running', attempt_count = attempt_count + 1,
              lease_owner = $2, lease_expires_at = $3, started_at = $1,
              last_error_code = null, updated_at = $1
        where id = $4`,
      [now, workerId, leaseExpiresAt, row.id],
    );
    await client.query(
      `update assessment_correction set status = 'processing', updated_at = $2 where id = $1`,
      [row.correction_id, now],
    );
    await appendCorrectionEvent(client, {
      correctionId: row.correction_id,
      actorRole: "system",
      event: "regrade_started",
      reason: "Automatic deterministic regrade started from the reviewed correction queue.",
      evidence: {
        schemaVersion: 1,
        jobId: row.id,
        impactId: row.impact_id,
        attemptHash: hashAppealEvidence(row.attempt_id),
        workerHash: hashAppealEvidence(workerId),
        attemptNumber: row.attempt_count + 1,
      },
      now,
    });
    await client.query("commit");
    return {
      id: row.id,
      correctionId: row.correction_id,
      impactId: row.impact_id,
      attemptId: row.attempt_id,
      userId: row.user_id,
      examSessionId: row.exam_session_id,
      attemptCount: row.attempt_count + 1,
      runnerRequestGeneration: row.runner_request_generation,
      leaseOwner: workerId,
      leaseExpiresAt,
      snapshot: row.snapshot,
      snapshotHash: row.snapshot_hash,
      formHash: row.form_hash,
      answerSetHash: row.answer_set_hash,
      originalResultHash: row.original_result_hash,
      replacement,
      expectedRuntimeImageDigest: replacement.runtimeImageDigest,
      target,
      createdBy: row.created_by,
      sourceAppealId: row.source_appeal_id,
      reviewHash: row.review_hash,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function markFailure(job: ClaimedJob, error: unknown, now: Date) {
  const client = await pool.connect();
  const code = error instanceof AssessmentCorrectionError ? error.code : "REGRADING_FAILED";
  try {
    await client.query("begin");
    const failed = await client.query(
      `update assessment_regrade_job
          set status = 'failed', lease_owner = null, lease_expires_at = null,
              last_error_code = $2, completed_at = $3, updated_at = $3
        where id = $1 and status = 'running' and lease_owner = $4
          and attempt_count = $5 and runner_request_generation = $6
          and lease_expires_at > $3
        returning id`,
      [job.id, code, now, job.leaseOwner, job.attemptCount, job.runnerRequestGeneration],
    );
    if (failed.rowCount !== 1) throw new AssessmentCorrectionError("WRITE_CONFLICT");
    const priorDeterminateFailures = await client.query<{ count: number }>(
      `select count(*)::int count
         from assessment_correction_event
        where correction_id = $1 and event = 'regrade_failed'
          and evidence->>'jobId' = $2`,
      [job.correctionId, job.id],
    );
    const determinateAttemptNumber = (priorDeterminateFailures.rows[0]?.count ?? 0) + 1;
    const counts = await client.query<{ succeeded: number; failed: number; pending: number }>(
      `select count(*) filter (where status = 'succeeded')::int as succeeded,
              count(*) filter (where status in ('failed','timed_out'))::int as failed,
              count(*) filter (where status in ('queued','leased','running'))::int as pending
         from assessment_regrade_job where correction_id = $1`,
      [job.correctionId],
    );
    const aggregate = counts.rows[0]!;
    const status = aggregate.succeeded > 0 ? "partially_failed" : "failed";
    await client.query(
      `update assessment_correction set status = $2, updated_at = $3 where id = $1`,
      [job.correctionId, status, now],
    );
    await appendCorrectionEvent(client, {
      correctionId: job.correctionId,
      actorRole: "system",
      event: "regrade_failed",
      reason: "Automatic deterministic regrade failed safely; no official result was changed.",
      evidence: {
        schemaVersion: 1,
        jobId: job.id,
        impactId: job.impactId,
        errorCode: code,
        attemptNumber: job.attemptCount,
        leaseAttemptNumber: job.attemptCount,
        determinateAttemptNumber,
        retryAllowed: determinateAttemptNumber < 3,
      },
      now,
    });
    await client.query("commit");
  } catch (failure) {
    await client.query("rollback").catch(() => undefined);
    throw failure;
  } finally {
    client.release();
  }
}

async function writeWorkerAuditSafely(
  operation: Promise<unknown>,
  phase: "succeeded" | "deferred" | "failed",
) {
  try {
    await operation;
    return true;
  } catch {
    console.error(JSON.stringify({ event: "assessment_regrade.audit_failed", phase }));
    return false;
  }
}

async function requeueForRunnerCapacity(
  job: ClaimedJob,
  workerId: string,
  now: Date,
) {
  const requeued = await pool.query(
    `with requeued as (
       update assessment_regrade_job
          set status = 'queued', lease_owner = null, lease_expires_at = null,
              runner_request_generation = runner_request_generation + 1,
              last_error_code = 'RUNNER_CAPACITY_BUSY', updated_at = $4
        where id = $1 and status = 'running' and lease_owner = $2 and attempt_count = $3
          and runner_request_generation = $5 and lease_expires_at > $4
        returning correction_id
     )
     update assessment_correction c set status = 'queued', updated_at = $4
       from requeued r where c.id = r.correction_id
     returning c.id`,
    [job.id, workerId, job.attemptCount, now, job.runnerRequestGeneration],
  );
  if (requeued.rowCount !== 1) throw new AssessmentCorrectionError("WRITE_CONFLICT");
}

async function requeueForRunnerIndeterminate(
  job: ClaimedJob,
  workerId: string,
  now: Date,
) {
  const requeued = await pool.query(
    `with requeued as (
       update assessment_regrade_job
          set status = 'queued', lease_owner = null, lease_expires_at = null,
              last_error_code = 'RUNNER_INDETERMINATE', updated_at = $4
        where id = $1 and status = 'running' and lease_owner = $2 and attempt_count = $3
          and runner_request_generation = $5 and lease_expires_at > $4
        returning correction_id
     )
     update assessment_correction c set status = 'queued', updated_at = $4
       from requeued r where c.id = r.correction_id
     returning c.id`,
    [job.id, workerId, job.attemptCount, now, job.runnerRequestGeneration],
  );
  if (requeued.rowCount !== 1) throw new AssessmentCorrectionError("WRITE_CONFLICT");
}

async function persistOutcome(job: ClaimedJob, correctedResult: ExamResult, runnerManifest: Record<string, unknown>, now: Date) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(job.userId)]);
    const learnerAuthority = await client.query<{ status: string; name: string; email: string }>(
      `select status, name, email from "user" where id = $1 for update`,
      [job.userId],
    );
    if (learnerAuthority.rows[0]?.status !== "active") {
      throw new AssessmentCorrectionError("LEARNER_NOT_ACTIVE");
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`assessment-effective-result:${job.attemptId}`]);
    const jobRow = await client.query<{ status: string }>(
      `select status from assessment_regrade_job
        where id = $1 and status = 'running' and lease_owner = $2
          and attempt_count = $3 and runner_request_generation = $5
          and lease_expires_at > $4
        for update`,
      [job.id, job.leaseOwner, job.attemptCount, now, job.runnerRequestGeneration],
    );
    if (!jobRow.rows[0]) throw new AssessmentCorrectionError("WRITE_CONFLICT");
    const priorOutcome = await client.query<{
      outcome_id: string;
      result_hash: string;
      revision: number;
      result: ExamResult;
    }>(
      `select outcome_id, result_hash, revision, result
         from assessment_attempt_effective_result where attempt_id = $1 for update`,
      [job.attemptId],
    );
    const existing = await client.query<{ id: string }>(
      `select id from assessment_regrade_outcome where correction_id = $1 and attempt_id = $2`,
      [job.correctionId, job.attemptId],
    );
    if (existing.rows[0]) {
      const replayed = await client.query(
        `update assessment_regrade_job set status = 'succeeded', lease_owner = null,
            lease_expires_at = null, completed_at = coalesce(completed_at, $2), updated_at = $2
          where id = $1 and status = 'running' and lease_owner = $3
            and attempt_count = $4 and runner_request_generation = $5
            and lease_expires_at > $2
          returning id`,
        [job.id, now, job.leaseOwner, job.attemptCount, job.runnerRequestGeneration],
      );
      if (replayed.rowCount !== 1) throw new AssessmentCorrectionError("WRITE_CONFLICT");
      await client.query("commit");
      return { replayed: true, outcomeId: existing.rows[0].id };
    }
    const currentHash = priorOutcome.rows[0]?.result_hash ?? hashAppealEvidence(job.snapshot.originalResult);
    if (currentHash !== job.originalResultHash) {
      throw new AssessmentCorrectionError("WRITE_CONFLICT");
    }
    const revision = Number(priorOutcome.rows[0]?.revision ?? 0) + 1;
    const correctedResultHash = hashAppealEvidence(correctedResult);
    const runnerEvidenceHash = hashAppealEvidence(runnerManifest);
    const decisionEvidence = {
      schemaVersion: 1,
      correctionId: job.correctionId,
      impactId: job.impactId,
      sourceAppealId: job.sourceAppealId,
      priorResultHash: job.originalResultHash,
      correctedResultHash,
      runnerEvidenceHash,
      faultyEvidenceHash: job.target.faultyEvidenceHash,
      replacementEvidenceHash: hashAppealEvidence(job.replacement),
      reviewHash: job.reviewHash,
      revision,
      deterministic: true,
      aiRole: "none",
    };
    const inserted = await client.query<{ id: string }>(
      `insert into assessment_regrade_outcome
        (correction_id, impact_id, attempt_id, user_id, revision, supersedes_outcome_id,
         original_result, original_result_hash, corrected_result, corrected_result_hash,
         runner_evidence, runner_evidence_hash, decision_evidence, decision_evidence_hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11::jsonb,$12,$13::jsonb,$14,$15)
       returning id`,
      [job.correctionId, job.impactId, job.attemptId, job.userId, revision,
        priorOutcome.rows[0]?.outcome_id ?? null, JSON.stringify(job.snapshot.originalResult),
        job.originalResultHash, JSON.stringify(correctedResult), correctedResultHash,
        JSON.stringify(runnerManifest), runnerEvidenceHash, JSON.stringify(decisionEvidence),
        hashAppealEvidence(decisionEvidence), now],
    );
    const outcomeId = inserted.rows[0]!.id;
    const effect = masteryEffect(job.snapshot.originalResult.outcome, correctedResult.outcome);
    const languageContext = correctionMasteryLanguageContext(job.snapshot.form);
    const skills = new Set<string>();
    const masteryRepairIds: string[] = [];
    for (const item of job.snapshot.form.items) {
      skills.add(item.skillId);
    }
    for (const skillId of skills) {
      const evidence = {
        schemaVersion: 1,
        correctionId: job.correctionId,
        outcomeId,
        attemptId: job.attemptId,
        skillId,
        languageContext,
        effect,
        priorOutcome: job.snapshot.originalResult.outcome,
        correctedOutcome: correctedResult.outcome,
        correctedResultHash,
      };
      const adjustment = await client.query<{ id: string }>(
        `insert into assessment_mastery_adjustment
          (outcome_id, user_id, attempt_id, skill_id, language_context, effect,
           prior_outcome, corrected_outcome, evidence, evidence_hash, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
         returning id`,
        [outcomeId, job.userId, job.attemptId, skillId, languageContext, effect,
          job.snapshot.originalResult.outcome, correctedResult.outcome,
          JSON.stringify(evidence), hashAppealEvidence(evidence), now],
      );
      const adjustmentId = adjustment.rows[0]?.id;
      if (!adjustmentId) throw new AssessmentCorrectionError("WRITE_CONFLICT");
      masteryRepairIds.push((await client.query<{ id: string }>(
        `insert into assessment_mastery_projection_repair
          (adjustment_id, outcome_id, user_id, attempt_id, course_id, module_id,
           content_version, skill_id, language_context, effect, status, next_attempt_at,
           created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$11,$11)
         returning id`,
        [adjustmentId, outcomeId, job.userId, job.attemptId,
          job.snapshot.form.courseId, job.snapshot.form.moduleId,
          job.snapshot.form.contentVersion, skillId, languageContext, effect, now],
      )).rows[0]!.id);
    }
    for (const repairId of masteryRepairIds) {
      await applyAssessmentMasteryProjectionRepair(client, repairId, now);
    }
    if (effect !== "no_change") {
      const slug = examModuleMasterySlug(job.snapshot.form.courseId, job.snapshot.form.moduleId);
      await client.query(
        `insert into achievement (slug, title, description, icon, rule_version, rule, created_at, updated_at)
         values ($1,$2,$3,'medal',$4,$5::jsonb,$6,$6)
         on conflict (slug) do nothing`,
        [
          slug,
          `Mastery: ${job.snapshot.form.moduleTitle}`,
          `Demonstrated at least 95% with every critical requirement satisfied in ${job.snapshot.form.courseTitle}.`,
          EXAM_MASTERY_RULE_VERSION,
          JSON.stringify({
            event: "exam_mastery",
            courseId: job.snapshot.form.courseId,
            moduleId: job.snapshot.form.moduleId,
            minimumScorePercent: 95,
            criticalRequirementsRequired: true,
          }),
          now,
        ],
      );
      if (effect === "award") {
        await client.query(
          `insert into user_achievement
            (user_id, achievement_id, evidence_id, visibility, awarded_at, revoked_at)
           select $1, id, $2, 'private', $3, null from achievement where slug = $4
           on conflict (user_id, achievement_id, evidence_id) do update
             set revoked_at = null`,
          [job.userId, `exam-attempt:${job.attemptId}`, now, slug],
        );
      } else {
        await client.query(
          `update user_achievement ua set revoked_at = $3
            from achievement a
           where ua.achievement_id = a.id and ua.user_id = $1
             and ua.evidence_id = $2 and a.slug = $4 and ua.revoked_at is null`,
          [job.userId, `exam-attempt:${job.attemptId}`, now, slug],
        );
      }
    }
    await client.query(
      `insert into assessment_attempt_effective_result
        (attempt_id, outcome_id, user_id, result, result_hash, revision, updated_at)
       values ($1,$2,$3,$4::jsonb,$5,$6,$7)
       on conflict (attempt_id) do update
         set outcome_id = excluded.outcome_id, user_id = excluded.user_id,
             result = excluded.result, result_hash = excluded.result_hash,
             revision = excluded.revision, updated_at = excluded.updated_at
       where assessment_attempt_effective_result.revision < excluded.revision`,
      [job.attemptId, outcomeId, job.userId, JSON.stringify(correctedResult), correctedResultHash, revision, now],
    );
    if (job.examSessionId) {
      await client.query(
        `update exam_session set status = $2, integrity_review_state = $3, updated_at = $4 where id = $1`,
        [job.examSessionId,
          correctedResult.gradingStatus === "graded" ? "graded" : "under_review",
          correctedResult.gradingStatus === "graded" ? "assessment_correction_applied" : "assessment_correction_manual_review",
          now],
      );
    }
    const completed = await client.query(
      `update assessment_regrade_job set status = 'succeeded', lease_owner = null,
          lease_expires_at = null, completed_at = $2, updated_at = $2
        where id = $1 and status = 'running' and lease_owner = $3
          and attempt_count = $4 and runner_request_generation = $5
          and lease_expires_at > $2
        returning id`,
      [job.id, now, job.leaseOwner, job.attemptCount, job.runnerRequestGeneration],
    );
    if (completed.rowCount !== 1) throw new AssessmentCorrectionError("WRITE_CONFLICT");
    const appUrl = process.env.APP_URL ?? "http://localhost:3000";
    const actionPath = job.examSessionId ? `/exams/${job.examSessionId}` : "/exams";
    await client.query(
      `insert into notification (user_id, type, title, body, action_url, created_at)
       values ($1,'assessment-corrected','Your assessment was regraded',
         'A reviewed faulty assessment version was corrected. The original evidence remains preserved and the superseding result is now effective.',
         $2,$3)`,
      [job.userId, actionPath, now],
    );
    if (learnerAuthority.rows[0]) {
      const mailKey = createHash("sha256")
        .update(`assessment-corrected:${learnerAuthority.rows[0].email.toLowerCase()}:${outcomeId}`)
        .digest("hex");
      await client.query(
        `insert into email_outbox
          (user_id, to_email, template, template_version, variables, idempotency_key, status)
         values ($1,lower($2),'assessment-corrected','1',$3::jsonb,$4,'pending')
         on conflict (idempotency_key) do nothing`,
        [job.userId, learnerAuthority.rows[0].email, JSON.stringify({
          name: learnerAuthority.rows[0].name,
          outcome: correctedResult.outcome,
          url: `${appUrl}${actionPath}`,
        }), mailKey],
      );
    }
    await appendCorrectionEvent(client, {
      correctionId: job.correctionId,
      actorRole: "system",
      event: "regrade_succeeded",
      reason: "Automatic deterministic regrade appended a superseding official result.",
      evidence: {
        schemaVersion: 1,
        jobId: job.id,
        impactId: job.impactId,
        outcomeId,
        correctedResultHash,
        runnerEvidenceHash,
        revision,
        masteryEffect: effect,
      },
      now,
    });
    await reconcileAssessmentCorrectionCompletion(client, job.correctionId, now);
    await client.query("commit");
    return { replayed: false, outcomeId };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function processOneAssessmentRegrade(input: {
  readonly workerId: string;
  readonly correctionId?: string;
  readonly executor?: RegradeExecutor;
  readonly now?: Date;
  readonly clock?: () => Date;
}) {
  if (!/^[A-Za-z0-9._:-]{3,100}$/.test(input.workerId)) throw new Error("workerId is invalid.");
  const mutationClock = input.clock ?? (() => new Date());
  const claimNow = input.now ?? mutationClock();
  const job = await claimJob(input.workerId, input.correctionId, claimNow);
  if (!job) return { processed: false as const };
  try {
    if (!verifyImpactSnapshot(job.snapshot, {
      formHash: job.formHash,
      answerSetHash: job.answerSetHash,
      originalResultHash: job.originalResultHash,
      snapshotHash: job.snapshotHash,
    })) throw new AssessmentCorrectionError("EXAM_EVIDENCE_MISSING");
    const correctedForm = replaceFormEvidence(job.snapshot.form, job.target, job.replacement);
    const answers = effectiveAnswers(job.snapshot);
    const runnerResults: Record<string, ExamRunnerResult> = {};
    const executor = input.executor ?? configuredRegradeExecutor;
    for (const item of correctedForm.items) {
      if (item.gradingEvidence.kind !== "runner-tests") continue;
      const sourceCode = answers[item.id]?.sourceCode?.trim();
      if (!sourceCode) continue;
      if (
        !item.language
        || !(item.language in runtimeByLanguage)
        || !item.runtime?.version
        || !item.runtime.imageDigest
      ) {
        throw new AssessmentCorrectionError("EXAM_EVIDENCE_MISSING");
      }
      const expectedRuntimeImageDigest = item.id === job.target.itemId
        ? job.expectedRuntimeImageDigest
        : item.runtime.imageDigest;
      runnerResults[item.id] = await executor.execute({
        jobId: job.id,
        jobAttemptCount: job.attemptCount,
        runnerRequestGeneration: job.runnerRequestGeneration,
        correctionId: job.correctionId,
        attemptId: job.attemptId,
        userId: job.userId,
        itemId: item.id,
        language: item.language,
        expectedRuntimeVersion: item.runtime.version,
        sourceCode,
        evidence: item.gradingEvidence,
        expectedRuntimeImageDigest,
      });
      if (
        runnerResults[item.id]!.runtimeVersion !== item.runtime.version
        || runnerResults[item.id]!.imageDigest !== expectedRuntimeImageDigest
      ) {
        throw new AssessmentCorrectionError("RUNNER_INFRASTRUCTURE_FAILURE");
      }
    }
    const mutationNow = mutationClock();
    const correctedResult = gradeExamSubmission({
      form: correctedForm,
      answers,
      runnerResults,
      finalizedAt: mutationNow.toISOString(),
      finalizedBy: job.snapshot.originalResult.finalizedBy,
    });
    if (correctedResult.gradingStatus !== "graded" || correctedResult.infrastructureFailure) {
      throw new AssessmentCorrectionError("RUNNER_INFRASTRUCTURE_FAILURE");
    }
    const runnerManifest = runnerEvidenceManifest({
      target: job.target,
      replacement: job.replacement,
      results: runnerResults,
      executedAt: mutationNow,
    });
    const outcome = await persistOutcome(job, correctedResult, runnerManifest, mutationNow);
    const auditRecorded = await writeWorkerAuditSafely(writeAuditEvent({
      actorUserId: job.createdBy,
      subjectUserId: job.userId,
      action: "assessment.regrade.complete",
      resourceType: "assessment_correction",
      resourceId: job.correctionId,
      reason: "Reviewed faulty assessment version was deterministically regraded.",
      outcome: "success",
      correlationId: job.id,
      metadata: {
        impactId: job.impactId,
        outcomeId: outcome.outcomeId,
        replayed: outcome.replayed,
      },
    }), "succeeded");
    return { processed: true as const, succeeded: true as const, jobId: job.id, auditRecorded, ...outcome };
  } catch (error) {
    const mutationNow = mutationClock();
    const deferredRunner = error instanceof AssessmentCorrectionError
      && (error.code === "RUNNER_CAPACITY_BUSY" || error.code === "RUNNER_INDETERMINATE");
    if (deferredRunner) {
      if (error.code === "RUNNER_INDETERMINATE") {
        await requeueForRunnerIndeterminate(job, input.workerId, mutationNow);
      } else {
        await requeueForRunnerCapacity(job, input.workerId, mutationNow);
      }
      const auditRecorded = await writeWorkerAuditSafely(writeAuditEvent({
        actorUserId: job.createdBy,
        subjectUserId: job.userId,
        action: "assessment.regrade.deferred",
        resourceType: "assessment_correction",
        resourceId: job.correctionId,
        reason: error.code === "RUNNER_INDETERMINATE"
          ? "The official runner outcome was indeterminate; the same admission generation was safely requeued for reconciliation."
          : "Official runner capacity was busy; the reviewed regrade was safely requeued.",
        outcome: "denied",
        correlationId: job.id,
        metadata: { impactId: job.impactId, errorCode: error.code, retryable: true },
      }), "deferred");
      return {
        processed: true as const,
        succeeded: false as const,
        requeued: true as const,
        retryable: true as const,
        jobId: job.id,
        errorCode: error.code,
        auditRecorded,
      };
    }
    let failureRecorded = true;
    try {
      await markFailure(job, error, mutationNow);
    } catch (failure) {
      if (
        failure instanceof AssessmentCorrectionError
        && failure.code === "WRITE_CONFLICT"
      ) {
        throw failure;
      }
      failureRecorded = false;
      console.error(JSON.stringify({ event: "assessment_regrade.failure_record_failed" }));
    }
    const auditRecorded = await writeWorkerAuditSafely(writeAuditEvent({
      actorUserId: job.createdBy,
      subjectUserId: job.userId,
      action: "assessment.regrade.complete",
      resourceType: "assessment_correction",
      resourceId: job.correctionId,
      reason: "Reviewed faulty assessment regrade failed safely without changing official evidence.",
      outcome: "failure",
      correlationId: job.id,
      metadata: {
        impactId: job.impactId,
        errorCode: error instanceof AssessmentCorrectionError
          ? error.code
          : error instanceof Error
            ? error.name
            : "UNKNOWN",
      },
    }), "failed");
    return {
      processed: true as const,
      succeeded: false as const,
      jobId: job.id,
      errorCode: !failureRecorded
        ? "FAILURE_RECORDING_FAILED"
        : error instanceof AssessmentCorrectionError
          ? error.code
          : "REGRADING_FAILED",
      failureRecorded,
      auditRecorded,
      retryable: !failureRecorded,
    };
  }
}

export async function processAssessmentRegradeBatch(input: {
  readonly workerId: string;
  readonly correctionId?: string;
  readonly limit?: number;
  readonly executor?: RegradeExecutor;
}) {
  const limit = input.limit ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Regrade batch limit must be from 1 to 20.");
  const reports = [];
  for (let index = 0; index < limit; index += 1) {
    const report = await processOneAssessmentRegrade(input);
    if (!report.processed) break;
    reports.push(report);
    if ("requeued" in report && report.requeued) break;
  }
  return {
    processed: reports.length,
    succeeded: reports.filter((report) => report.succeeded).length,
    failed: reports.filter((report) => !report.succeeded).length,
    reports,
  };
}
