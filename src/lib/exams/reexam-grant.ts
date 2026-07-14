import { createHash } from "node:crypto";

import { pool } from "@/lib/db/client";
import {
  BLUEPRINT_RESPONSE_KEY,
  MATERIAL_DISCONNECT_SECONDS,
  RESULT_RESPONSE_KEY,
} from "@/lib/exams/constants";

interface StoredExamForm {
  readonly schemaVersion: 1;
  readonly moduleId: string;
  readonly contentVersion: string;
  readonly policyVersion: string;
  readonly items: readonly unknown[];
}

interface StoredExamResult {
  readonly schemaVersion: 1;
  readonly gradingStatus: "graded" | "pending-review";
  readonly outcome: "NOT_PASSED" | "PASSED" | "MASTERED" | "PENDING_REVIEW";
  readonly finalizedAt: string;
  readonly infrastructureFailure: boolean;
}

interface ReexamSourceRow {
  readonly user_id: string;
  readonly attempt_id: string;
  readonly status: string;
  readonly disconnected_seconds: number;
  readonly integrity_review_state: string;
  readonly passed: boolean | null;
  readonly policy_version: string;
  readonly content_version: string;
  readonly blueprint: unknown;
  readonly official_result: unknown;
}

export class ExamReexamGrantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ExamReexamGrantError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function formFrom(value: unknown): StoredExamForm | null {
  const wrapper = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
  const snapshot = wrapper?.snapshot;
  if (
    typeof snapshot !== "object" || snapshot === null ||
    (snapshot as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (snapshot as { moduleId?: unknown }).moduleId !== "string" ||
    !Array.isArray((snapshot as { items?: unknown }).items)
  ) return null;
  return snapshot as StoredExamForm;
}

function resultFrom(value: unknown): StoredExamResult | null {
  const wrapper = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
  const result = wrapper?.result ?? wrapper;
  if (
    typeof result !== "object" || result === null ||
    (result as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !["graded", "pending-review"].includes(String((result as { gradingStatus?: unknown }).gradingStatus)) ||
    !["NOT_PASSED", "PASSED", "MASTERED", "PENDING_REVIEW"].includes(String((result as { outcome?: unknown }).outcome)) ||
    typeof (result as { finalizedAt?: unknown }).finalizedAt !== "string" ||
    typeof (result as { infrastructureFailure?: unknown }).infrastructureFailure !== "boolean"
  ) return null;
  return result as StoredExamResult;
}

export interface ExamReexamGrantReport {
  readonly id: string;
  readonly userId: string;
  readonly sourceExamSessionId: string;
  readonly moduleId: string;
  readonly evidenceHash: string;
  readonly status: "available" | "consumed" | "revoked";
  readonly replayed: boolean;
}

/**
 * Creates exactly one equivalent re-exam grant only from durable, material
 * server evidence. Client outage claims and raw integrity-event payloads are
 * never accepted as authority or returned to the administrator.
 */
export async function issueExamReexamGrant(input: {
  readonly actorUserId: string;
  readonly sourceExamSessionId: string;
  readonly requestId: string;
  readonly reason: string;
  readonly now?: Date;
}): Promise<ExamReexamGrantReport> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (reason.length < 20 || reason.length > 2_000) throw new ExamReexamGrantError("REASON_REQUIRED");
  const client = await pool.connect();
  try {
    await client.query("begin");
    // A UUID idempotency key is an authority boundary. Serialize it before
    // reading so two concurrent identical requests deterministically replay.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`exam-reexam-request:${input.requestId}`]);
    const replay = await client.query<{
      id: string; user_id: string; source_exam_session_id: string; module_id: string;
      granted_by_user_id: string | null; reason: string; evidence_hash: string; status: string;
    }>(`select id,user_id,source_exam_session_id,module_id,granted_by_user_id,reason,evidence_hash,status
          from exam_reexam_grant where request_id = $1 for update`, [input.requestId]);
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (
        row.source_exam_session_id !== input.sourceExamSessionId ||
        row.granted_by_user_id !== input.actorUserId || row.reason !== reason
      ) throw new ExamReexamGrantError("IDEMPOTENCY_MISMATCH");
      await client.query("commit");
      return {
        id: row.id, userId: row.user_id, sourceExamSessionId: row.source_exam_session_id,
        moduleId: row.module_id, evidenceHash: row.evidence_hash,
        status: row.status as ExamReexamGrantReport["status"], replayed: true,
      };
    }

    const sourceStatement = `select es.user_id,es.attempt_id,es.status,es.disconnected_seconds,
                es.integrity_review_state,a.passed,a.policy_version,a.content_version,
                (select r.answer from response r where r.attempt_id = a.id and r.item_key = $2
                  order by r.revision desc limit 1) as blueprint,
               coalesce(
                 (select er.result from assessment_attempt_effective_result er where er.attempt_id = a.id),
                 (select rr.answer from response rr where rr.attempt_id = a.id and rr.item_key = $3
                   order by rr.revision desc limit 1)
                ) as official_result
           from exam_session es join attempt a on a.id = es.attempt_id
          where es.id = $1`;
    const sourceValues = [input.sourceExamSessionId, BLUEPRINT_RESPONSE_KEY, RESULT_RESPONSE_KEY];
    const preview = await client.query<ReexamSourceRow>(sourceStatement, sourceValues);
    const previewRow = preview.rows[0];
    if (!previewRow) throw new ExamReexamGrantError("EXAM_NOT_FOUND");
    const previewForm = formFrom(previewRow.blueprint);
    if (!previewForm) throw new ExamReexamGrantError("EXAM_FORM_MISSING");

    // Exam admission takes the module advisory lock before it locks the source
    // attempt. Follow the same global order so grant issuance cannot deadlock
    // with a concurrent start that is evaluating this failed attempt.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `exam:${previewRow.user_id}:${previewForm.moduleId}`,
    ]);
    const source = await client.query<ReexamSourceRow>(
      `${sourceStatement} for update of es,a`,
      sourceValues,
    );
    const row = source.rows[0];
    if (!row) throw new ExamReexamGrantError("EXAM_NOT_FOUND");
    const form = formFrom(row.blueprint);
    if (!form) throw new ExamReexamGrantError("EXAM_FORM_MISSING");
    if (row.user_id !== previewRow.user_id || form.moduleId !== previewForm.moduleId) {
      throw new ExamReexamGrantError("REEXAM_SOURCE_NOT_CURRENT");
    }
    if (["active", "scheduled", "paused_by_system"].includes(row.status)) {
      throw new ExamReexamGrantError("EXAM_NOT_FINALIZED");
    }
    const result = resultFrom(row.official_result);
    if (!result) throw new ExamReexamGrantError("EXAM_FINALIZATION_PENDING");
    if (result.outcome === "PASSED" || result.outcome === "MASTERED" || row.passed === true) {
      throw new ExamReexamGrantError("PASS_ALREADY_PROTECTED");
    }
    if (result.outcome === "PENDING_REVIEW" || result.gradingStatus === "pending-review") {
      throw new ExamReexamGrantError("PENDING_REVIEW_CANNOT_BE_BYPASSED");
    }
    if (result.outcome !== "NOT_PASSED" || result.infrastructureFailure) {
      throw new ExamReexamGrantError("REEXAM_GRANT_SOURCE_INELIGIBLE");
    }
    if (form.contentVersion !== row.content_version || form.policyVersion !== row.policy_version) {
      throw new ExamReexamGrantError("FORM_VERSION_MISMATCH");
    }
    const authoritative = await client.query<{ id: string }>(
      `select es.id from exam_session es join attempt a on a.id = es.attempt_id
        where a.user_id = $1 and a.kind in ('exam','retake')
          and exists (
            select 1 from response bp where bp.attempt_id = a.id and bp.item_key = $2
              and bp.answer #>> '{snapshot,moduleId}' = $3
          )
        order by a.created_at desc,a.id desc limit 1`,
      [row.user_id, BLUEPRINT_RESPONSE_KEY, form.moduleId],
    );
    if (authoritative.rows[0]?.id !== input.sourceExamSessionId) {
      throw new ExamReexamGrantError("REEXAM_SOURCE_NOT_CURRENT");
    }
    const events = await client.query<{ material_count: number }>(
      `select count(*)::int as material_count from exam_event
        where exam_session_id = $1 and type = any($2::text[])`,
      [input.sourceExamSessionId, [
        "server_material_disconnect", "server_deadline_disconnect", "runner_infrastructure_failure",
      ]],
    );
    const materialEventCount = events.rows[0]?.material_count ?? 0;
    const material = row.disconnected_seconds >= MATERIAL_DISCONNECT_SECONDS ||
      row.integrity_review_state === "technical_incident" || materialEventCount > 0;
    if (!material) throw new ExamReexamGrantError("MATERIAL_OUTAGE_EVIDENCE_REQUIRED");
    const evidence = {
      schemaVersion: 1,
      sourceExamSessionId: input.sourceExamSessionId,
      sourceAttemptId: row.attempt_id,
      moduleId: form.moduleId,
      contentVersion: form.contentVersion,
      policyVersion: form.policyVersion,
      sourceStatus: row.status,
      disconnectedSeconds: row.disconnected_seconds,
      integrityReviewState: row.integrity_review_state,
      materialEventCount,
      sourceOutcome: result.outcome,
      sourceFinalizedAt: result.finalizedAt,
    };
    const evidenceHash = createHash("sha256").update(canonical(evidence)).digest("hex");
    const existing = await client.query<{ id: string }>(
      "select id from exam_reexam_grant where source_exam_session_id = $1",
      [input.sourceExamSessionId],
    );
    if (existing.rows[0]) throw new ExamReexamGrantError("GRANT_ALREADY_EXISTS");
    const inserted = await client.query<{ id: string }>(
      `insert into exam_reexam_grant
         (request_id,user_id,source_exam_session_id,module_id,granted_by_user_id,reason,evidence,evidence_hash,status,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'available',$9,$9) returning id`,
      [input.requestId, row.user_id, input.sourceExamSessionId, form.moduleId,
        input.actorUserId, reason, JSON.stringify(evidence), evidenceHash, now],
    );
    await client.query(
      `insert into notification (user_id,type,title,body,action_url,created_at)
       values ($1,'exam-reexam-granted','Equivalent re-exam approved',
         'An administrator approved one equivalent form after reviewing durable material-outage evidence. Your prior records remain unchanged.',
         '/exams',$2)`,
      [row.user_id, now],
    );
    await client.query("commit");
    return {
      id: inserted.rows[0]!.id, userId: row.user_id,
      sourceExamSessionId: input.sourceExamSessionId, moduleId: form.moduleId,
      evidenceHash, status: "available", replayed: false,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
