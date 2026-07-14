import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { pool } from "@/lib/db/client";
import { deterministicUuid } from "@/lib/learning-service/ids";

import { reconcileAssessmentCorrectionCompletion } from "./completion";

const PROJECTION_POLICY_VERSION = "assessment-correction-projection-v1";
const FORMAL_EXAM_CRITERION = "formal_exam_mastery";
const RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;

type RepairEffect = "award" | "revoke" | "no_change";
type RepairStatus = "pending" | "applied" | "unresolved";

interface RepairRow {
  readonly id: string;
  readonly correction_id: string;
  readonly outcome_id: string;
  readonly supersedes_outcome_id: string | null;
  readonly adjustment_id: string;
  readonly user_id: string;
  readonly attempt_id: string;
  readonly course_id: string;
  readonly module_id: string;
  readonly content_version: string;
  readonly skill_id: string;
  readonly language_context: string;
  readonly effect: RepairEffect;
  readonly status: RepairStatus;
  readonly attempt_count: number;
  readonly last_error_code: string | null;
}

interface ProjectionRow {
  readonly score: number;
  readonly confidence: number;
  readonly status: string;
  readonly critical_requirements_met: boolean;
  readonly last_evidence_at: Date | null;
  readonly last_practiced_at: Date | null;
  readonly next_review_at: Date | null;
  readonly policy_version: string;
  readonly row_version: string | number;
}

interface PriorAwardRepair {
  readonly id: string;
  readonly concept_id: string | null;
  readonly enrollment_id: string | null;
  readonly projection_evidence_id: string | null;
  readonly before_projection: ProjectionSnapshot | null;
  readonly after_projection: ProjectionSnapshot | null;
  readonly applied_row_version: string | number | null;
}

export interface ProjectionSnapshot {
  readonly score: number;
  readonly confidence: number;
  readonly status: string;
  readonly criticalRequirementsMet: boolean;
  readonly lastEvidenceAt: string | null;
  readonly lastPracticedAt: string | null;
  readonly nextReviewAt: string | null;
  readonly policyVersion: string;
  readonly rowVersion: number;
}

export interface MasteryProjectionRepairReport {
  readonly repairId: string;
  readonly status: "applied" | "unresolved";
  readonly code: string;
  readonly replayed: boolean;
}

function projectionSnapshot(row: ProjectionRow | undefined): ProjectionSnapshot | null {
  if (!row) return null;
  return {
    score: Number(row.score),
    confidence: Number(row.confidence),
    status: row.status,
    criticalRequirementsMet: row.critical_requirements_met,
    lastEvidenceAt: row.last_evidence_at?.toISOString() ?? null,
    lastPracticedAt: row.last_practiced_at?.toISOString() ?? null,
    nextReviewAt: row.next_review_at?.toISOString() ?? null,
    policyVersion: row.policy_version,
    rowVersion: Number(row.row_version),
  };
}

function courseVersion(contentVersion: string): string | null {
  const value = contentVersion.trim();
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  const version = (separator >= 0 ? value.slice(separator + 1) : value).trim();
  return version || null;
}

async function appendProjectionEvent(
  client: PoolClient,
  input: {
    readonly row: RepairRow;
    readonly event: "mastery_projection_applied" | "mastery_projection_unresolved";
    readonly code: string;
    readonly now: Date;
    readonly evidence?: Record<string, unknown>;
  },
) {
  const evidence = {
    schemaVersion: 1,
    repairId: input.row.id,
    adjustmentId: input.row.adjustment_id,
    outcomeId: input.row.outcome_id,
    attemptHash: hashAppealEvidence(input.row.attempt_id),
    skillId: input.row.skill_id,
    languageContext: input.row.language_context,
    effect: input.row.effect,
    status: input.event === "mastery_projection_applied" ? "applied" : "unresolved",
    code: input.code,
    ...(input.evidence ?? {}),
  };
  await client.query(
    `insert into assessment_correction_event
      (correction_id, actor_role, event, request_id, reason, evidence, evidence_hash, occurred_at)
     values ($1,'system',$2,$3,$4,$5::jsonb,$6,$7)`,
    [
      input.row.correction_id,
      input.event,
      randomUUID(),
      input.event === "mastery_projection_applied"
        ? "The corrected mastery evidence was applied to its exact learner concept projection."
        : "The corrected mastery evidence remains queued because one exact learner concept projection could not be proven safely.",
      JSON.stringify(evidence),
      hashAppealEvidence(evidence),
      input.now,
    ],
  );
}

async function markUnresolved(
  client: PoolClient,
  row: RepairRow,
  code: string,
  now: Date,
): Promise<MasteryProjectionRepairReport> {
  await client.query(
    `update assessment_mastery_projection_repair
        set status = 'unresolved', attempt_count = attempt_count + 1,
            next_attempt_at = $2, last_error_code = $3, resolution_code = null,
            applied_at = null, updated_at = $1
      where id = $4`,
    [now, new Date(now.getTime() + RETRY_DELAY_MS), code, row.id],
  );
  if (row.status !== "unresolved" || row.last_error_code !== code) {
    await appendProjectionEvent(client, {
      row,
      event: "mastery_projection_unresolved",
      code,
      now,
    });
  }
  return { repairId: row.id, status: "unresolved", code, replayed: false };
}

async function markApplied(
  client: PoolClient,
  row: RepairRow,
  input: {
    readonly code: string;
    readonly now: Date;
    readonly conceptId?: string | null;
    readonly enrollmentId?: string | null;
    readonly evidenceId?: string | null;
    readonly before?: ProjectionSnapshot | null;
    readonly after?: ProjectionSnapshot | null;
    readonly appliedRowVersion?: number | null;
  },
): Promise<MasteryProjectionRepairReport> {
  await client.query(
    `update assessment_mastery_projection_repair
        set status = 'applied', attempt_count = attempt_count + 1,
            concept_id = $2, enrollment_id = $3, projection_evidence_id = $4,
            before_projection = $5::jsonb, after_projection = $6::jsonb,
            applied_row_version = $7, last_error_code = null,
            resolution_code = $8, applied_at = $1, next_attempt_at = $1, updated_at = $1
      where id = $9`,
    [
      input.now,
      input.conceptId ?? null,
      input.enrollmentId ?? null,
      input.evidenceId ?? null,
      input.before == null ? null : JSON.stringify(input.before),
      input.after == null ? null : JSON.stringify(input.after),
      input.appliedRowVersion ?? null,
      input.code,
      row.id,
    ],
  );
  await appendProjectionEvent(client, {
    row,
    event: "mastery_projection_applied",
    code: input.code,
    now: input.now,
    evidence: {
      conceptHash: input.conceptId ? hashAppealEvidence(input.conceptId) : null,
      enrollmentHash: input.enrollmentId ? hashAppealEvidence(input.enrollmentId) : null,
      beforeProjectionHash: input.before == null ? null : hashAppealEvidence(input.before),
      afterProjectionHash: input.after == null ? null : hashAppealEvidence(input.after),
      appliedRowVersion: input.appliedRowVersion ?? null,
    },
  });
  return { repairId: row.id, status: "applied", code: input.code, replayed: false };
}

async function loadProjection(
  client: PoolClient,
  input: { readonly userId: string; readonly enrollmentId: string; readonly conceptId: string; readonly languageContext: string },
): Promise<ProjectionRow | undefined> {
  const result = await client.query<ProjectionRow>(
    `select score, confidence, status, critical_requirements_met, last_evidence_at,
            last_practiced_at, next_review_at, policy_version, row_version
       from concept_mastery
      where user_id = $1 and enrollment_id = $2 and concept_id = $3 and language_context = $4
      for update`,
    [input.userId, input.enrollmentId, input.conceptId, input.languageContext],
  );
  return result.rows[0];
}

async function exactMapping(client: PoolClient, row: RepairRow) {
  const version = courseVersion(row.content_version);
  if (!version) return { code: "CONTENT_VERSION_UNRESOLVED", mapping: null } as const;
  const mappings = await client.query<{ concept_id: string; enrollment_id: string }>(
    `select distinct c.id as concept_id, e.id as enrollment_id
       from course co
       join course_version cv on cv.course_id = co.id
       join course_module cm on cm.course_version_id = cv.id
       join lesson l on l.module_id = cm.id
       join lesson_concept lc on lc.lesson_id = l.id
       join concept c on c.id = lc.concept_id
       join enrollment e on e.course_version_id = cv.id and e.user_id = $1
       where co.slug = $2 and cv.version = $3 and cm.slug = $4 and c.slug = $5
         and e.status <> 'withdrawn'
         and (
           $6::text = 'conceptual'
           or (
             co.slug = 'dsa'
             and left($6::text, 4) = 'dsa:'
             and case lower(trim(coalesce(e.implementation_language, '')))
               when 'cpp' then 'c++'
               when 'py' then 'python'
               else lower(trim(coalesce(e.implementation_language, '')))
             end = lower(substr($6::text, 5))
           )
         )
      order by c.id, e.id`,
    [row.user_id, row.course_id, version, row.module_id, row.skill_id, row.language_context],
  );
  if (mappings.rows.length === 0) return { code: "EXACT_MAPPING_NOT_FOUND", mapping: null } as const;
  if (mappings.rows.length !== 1) return { code: "EXACT_MAPPING_AMBIGUOUS", mapping: null } as const;
  return { code: null, mapping: mappings.rows[0]! } as const;
}

async function applyAward(client: PoolClient, row: RepairRow, now: Date) {
  const resolved = await exactMapping(client, row);
  if (!resolved.mapping) return markUnresolved(client, row, resolved.code, now);
  const { concept_id: conceptId, enrollment_id: enrollmentId } = resolved.mapping;
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `assessment-mastery-projection:${row.user_id}:${enrollmentId}:${conceptId}:${row.language_context}`,
  ]);
  const before = projectionSnapshot(await loadProjection(client, {
    userId: row.user_id,
    enrollmentId,
    conceptId,
    languageContext: row.language_context,
  }));
  const evidenceId = deterministicUuid(
    "assessment-correction-mastery-evidence",
    `${row.outcome_id}:${row.user_id}:${enrollmentId}:${conceptId}:${row.language_context}`,
  );
  await client.query(
    `insert into mastery_evidence
      (id, user_id, enrollment_id, concept_id, language_context, evidence_type,
       source_type, source_id, score, weight, critical_criterion, validity,
       policy_version, recorded_by, recorded_at)
     values ($1,$2,$3,$4,$5,'formal_exam','assessment_correction',$6,1,1,
       $7,'valid',$8,'verified-runner',$9)
     on conflict (user_id, source_type, source_id, concept_id, critical_criterion) do nothing`,
    [
      evidenceId,
      row.user_id,
      enrollmentId,
      conceptId,
      row.language_context,
      `assessment-correction:${row.outcome_id}`,
      FORMAL_EXAM_CRITERION,
      PROJECTION_POLICY_VERSION,
      now,
    ],
  );
  if (before) {
    await client.query(
      `update concept_mastery
          set score = greatest(score, 0.95), confidence = greatest(confidence, 0.95),
              status = 'mastered', critical_requirements_met = true,
              last_evidence_at = $5, policy_version = $6,
              row_version = row_version + 1, updated_at = $5
        where user_id = $1 and enrollment_id = $2 and concept_id = $3
          and language_context = $4 and row_version = $7`,
      [row.user_id, enrollmentId, conceptId, row.language_context, now, PROJECTION_POLICY_VERSION, before.rowVersion],
    );
  } else {
    await client.query(
      `insert into concept_mastery
        (user_id, enrollment_id, concept_id, language_context, score, confidence,
         status, critical_requirements_met, last_evidence_at, policy_version,
         row_version, created_at, updated_at)
       values ($1,$2,$3,$4,0.95,0.95,'mastered',true,$5,$6,1,$5,$5)`,
      [row.user_id, enrollmentId, conceptId, row.language_context, now, PROJECTION_POLICY_VERSION],
    );
  }
  const after = projectionSnapshot(await loadProjection(client, {
    userId: row.user_id,
    enrollmentId,
    conceptId,
    languageContext: row.language_context,
  }));
  if (!after || after.status !== "mastered") {
    throw new Error("MASTERY_PROJECTION_WRITE_CONFLICT");
  }
  return markApplied(client, row, {
    code: "PROJECTED_CORRECTED_MASTERY",
    now,
    conceptId,
    enrollmentId,
    evidenceId,
    before,
    after,
    appliedRowVersion: after.rowVersion,
  });
}

async function priorAwardRepair(client: PoolClient, row: RepairRow): Promise<PriorAwardRepair | null> {
  if (!row.supersedes_outcome_id) return null;
  const prior = await client.query<PriorAwardRepair>(
    `select p.id, p.concept_id, p.enrollment_id, p.projection_evidence_id,
            p.before_projection, p.after_projection, p.applied_row_version
       from assessment_mastery_projection_repair p
      where p.outcome_id = $1 and p.attempt_id = $2 and p.skill_id = $3
        and p.language_context = $4 and p.effect = 'award' and p.status = 'applied'
      order by p.applied_at desc, p.id desc
      limit 1`,
    [row.supersedes_outcome_id, row.attempt_id, row.skill_id, row.language_context],
  );
  return prior.rows[0] ?? null;
}

async function applyRevoke(client: PoolClient, row: RepairRow, now: Date) {
  const prior = await priorAwardRepair(client, row);
  if (!prior) {
    // Historic formal-exam mastery was not correction-owned and cannot be
    // safely reconstructed from a missing provenance link. Badge/effective
    // result revocation still commits, but concept mastery remains explicitly
    // unresolved until a reviewed evidence rebuild proves what to remove.
    return markUnresolved(client, row, "ORIGINAL_MASTERY_PROJECTION_REQUIRES_REBUILD", now);
  }
  if (!prior.concept_id || !prior.enrollment_id || !prior.projection_evidence_id || prior.applied_row_version === null) {
    return markUnresolved(client, row, "PRIOR_PROJECTION_EVIDENCE_INCOMPLETE", now);
  }
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `assessment-mastery-projection:${row.user_id}:${prior.enrollment_id}:${prior.concept_id}:${row.language_context}`,
  ]);
  await client.query(
    `update mastery_evidence set validity = 'revoked-by-correction'
      where id = $1 and user_id = $2 and source_type = 'assessment_correction'`,
    [prior.projection_evidence_id, row.user_id],
  );
  const current = projectionSnapshot(await loadProjection(client, {
    userId: row.user_id,
    enrollmentId: prior.enrollment_id,
    conceptId: prior.concept_id,
    languageContext: row.language_context,
  }));
  if (!current) {
    return markApplied(client, row, {
      code: "PROJECTION_ALREADY_ABSENT",
      now,
      conceptId: prior.concept_id,
      enrollmentId: prior.enrollment_id,
      evidenceId: prior.projection_evidence_id,
      before: null,
      after: null,
      appliedRowVersion: null,
    });
  }
  if (current.rowVersion !== Number(prior.applied_row_version)) {
    return markUnresolved(client, row, "INTERVENING_MASTERY_EVIDENCE", now);
  }
  const before = current;
  if (prior.before_projection === null) {
    const deleted = await client.query(
      `delete from concept_mastery
        where user_id = $1 and enrollment_id = $2 and concept_id = $3
          and language_context = $4 and row_version = $5`,
      [row.user_id, prior.enrollment_id, prior.concept_id, row.language_context, current.rowVersion],
    );
    if (deleted.rowCount !== 1) throw new Error("MASTERY_PROJECTION_WRITE_CONFLICT");
  } else {
    const restore = prior.before_projection;
    const restored = await client.query(
      `update concept_mastery
          set score = $5, confidence = $6, status = $7,
              critical_requirements_met = $8, last_evidence_at = $9,
              last_practiced_at = $10, next_review_at = $11,
              policy_version = $12, row_version = row_version + 1, updated_at = $13
        where user_id = $1 and enrollment_id = $2 and concept_id = $3
          and language_context = $4 and row_version = $14`,
      [
        row.user_id,
        prior.enrollment_id,
        prior.concept_id,
        row.language_context,
        restore.score,
        restore.confidence,
        restore.status,
        restore.criticalRequirementsMet,
        restore.lastEvidenceAt,
        restore.lastPracticedAt,
        restore.nextReviewAt,
        restore.policyVersion,
        now,
        current.rowVersion,
      ],
    );
    if (restored.rowCount !== 1) throw new Error("MASTERY_PROJECTION_WRITE_CONFLICT");
  }
  const after = projectionSnapshot(await loadProjection(client, {
    userId: row.user_id,
    enrollmentId: prior.enrollment_id,
    conceptId: prior.concept_id,
    languageContext: row.language_context,
  }));
  return markApplied(client, row, {
    code: "REVERTED_CORRECTION_OWNED_MASTERY",
    now,
    conceptId: prior.concept_id,
    enrollmentId: prior.enrollment_id,
    evidenceId: prior.projection_evidence_id,
    before,
    after,
    appliedRowVersion: after?.rowVersion ?? null,
  });
}

/** Process one repair inside the caller's transaction. */
export async function applyAssessmentMasteryProjectionRepair(
  client: PoolClient,
  repairId: string,
  now = new Date(),
): Promise<MasteryProjectionRepairReport> {
  const result = await client.query<RepairRow>(
    `select p.id, o.correction_id, p.outcome_id, o.supersedes_outcome_id,
            p.adjustment_id, p.user_id, p.attempt_id, p.course_id, p.module_id,
            p.content_version, p.skill_id, p.language_context, p.effect,
            p.status, p.attempt_count, p.last_error_code
       from assessment_mastery_projection_repair p
       join assessment_regrade_outcome o on o.id = p.outcome_id
      where p.id = $1
      for update of p`,
    [repairId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("MASTERY_PROJECTION_REPAIR_NOT_FOUND");
  if (row.status === "applied") {
    return {
      repairId: row.id,
      status: "applied",
      code: "ALREADY_APPLIED",
      replayed: true,
    };
  }
  if (row.effect === "no_change") {
    return markApplied(client, row, { code: "NO_MASTERY_CHANGE", now });
  }
  return row.effect === "award"
    ? applyAward(client, row, now)
    : applyRevoke(client, row, now);
}

export async function processAssessmentMasteryProjectionRepairBatch(input: {
  readonly limit?: number;
  readonly now?: Date;
} = {}) {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Mastery projection repair batch limit must be from 1 to 100.");
  }
  const reports: MasteryProjectionRepairReport[] = [];
  for (let index = 0; index < limit; index += 1) {
    const client = await pool.connect();
    const now = input.now ?? new Date();
    try {
      await client.query("begin");
      const candidate = await client.query<{ id: string }>(
        `select id from assessment_mastery_projection_repair
          where status in ('pending','unresolved') and next_attempt_at <= $1
          order by next_attempt_at, created_at, id
          for update skip locked
          limit 1`,
        [now],
      );
      if (!candidate.rows[0]) {
        await client.query("commit");
        break;
      }
      const report = await applyAssessmentMasteryProjectionRepair(client, candidate.rows[0].id, now);
      const correction = await client.query<{ correction_id: string }>(
        `select o.correction_id
           from assessment_mastery_projection_repair p
           join assessment_regrade_outcome o on o.id = p.outcome_id
          where p.id = $1`,
        [candidate.rows[0].id],
      );
      if (correction.rows[0]) {
        await reconcileAssessmentCorrectionCompletion(client, correction.rows[0].correction_id, now);
      }
      await client.query("commit");
      reports.push(report);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    processed: reports.length,
    applied: reports.filter((report) => report.status === "applied").length,
    unresolved: reports.filter((report) => report.status === "unresolved").length,
    reports,
  };
}
