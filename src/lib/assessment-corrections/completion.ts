import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { hashAppealEvidence } from "@/lib/appeals/evidence";

type CorrectionState = {
  id: string;
  source_appeal_id: string | null;
  status: string;
  affected_count: number;
};

type CompletionCounts = {
  succeeded: number;
  failed: number;
  pending: number;
  repair_pending: number;
  repair_unresolved: number;
};

export type CorrectionCompletionReport = Readonly<{
  status: "completed" | "processing" | "partially_failed" | "failed";
  transitioned: boolean;
  counts: Readonly<{
    succeeded: number;
    failed: number;
    pending: number;
    repairPending: number;
    repairUnresolved: number;
  }>;
}>;

async function completionCounts(client: PoolClient, correctionId: string): Promise<CompletionCounts> {
  const result = await client.query<CompletionCounts>(
    `select
       count(distinct j.id) filter (where j.status = 'succeeded')::int as succeeded,
       count(distinct j.id) filter (where j.status in ('failed','timed_out'))::int as failed,
       count(distinct j.id) filter (where j.status in ('queued','leased','running'))::int as pending,
       count(distinct p.id) filter (where p.status = 'pending')::int as repair_pending,
       count(distinct p.id) filter (where p.status = 'unresolved')::int as repair_unresolved
     from assessment_correction c
     left join assessment_regrade_job j on j.correction_id = c.id
     left join assessment_regrade_outcome o on o.correction_id = c.id
     left join assessment_mastery_projection_repair p on p.outcome_id = o.id
     where c.id = $1`,
    [correctionId],
  );
  return result.rows[0] ?? {
    succeeded: 0,
    failed: 0,
    pending: 0,
    repair_pending: 0,
    repair_unresolved: 0,
  };
}

async function closeSourceAppeal(
  client: PoolClient,
  sourceAppealId: string | null,
  correctionId: string,
  now: Date,
) {
  if (!sourceAppealId) return;
  const appeal = await client.query<{ row_version: number | string; status: string }>(
    `select row_version, status from appeal where id = $1 for update`,
    [sourceAppealId],
  );
  if (appeal.rows[0]?.status !== "overturned") return;
  const evidence = {
    correctionId,
    priorVersion: Number(appeal.rows[0].row_version),
    resultAndMasteryProjectionsComplete: true,
  };
  await client.query(
    `insert into appeal_event
      (appeal_id, actor_user_id, actor_role, event, client_request_id, reason, evidence, occurred_at)
     values ($1,null,'system','closed',$2,
       'Corrective deterministic regrading and every required mastery projection completed.',
       $3::jsonb,$4)`,
    [sourceAppealId, randomUUID(), JSON.stringify(evidence), now],
  );
  await client.query(
    `update appeal set status = 'closed', row_version = row_version + 1, updated_at = $2
      where id = $1 and status = 'overturned'`,
    [sourceAppealId, now],
  );
}

/**
 * The sole completion gate for a correction. A superseding result is not the
 * whole correction: every exact mastery repair must also be applied before the
 * correction can be completed and its source appeal closed.
 */
export async function reconcileAssessmentCorrectionCompletion(
  client: PoolClient,
  correctionId: string,
  now: Date,
): Promise<CorrectionCompletionReport> {
  const correctionResult = await client.query<CorrectionState>(
    `select id, source_appeal_id, status, affected_count
       from assessment_correction where id = $1 for update`,
    [correctionId],
  );
  const correction = correctionResult.rows[0];
  if (!correction) throw new Error("ASSESSMENT_CORRECTION_NOT_FOUND");
  const raw = await completionCounts(client, correctionId);
  const counts = {
    succeeded: Number(raw.succeeded),
    failed: Number(raw.failed),
    pending: Number(raw.pending),
    repairPending: Number(raw.repair_pending),
    repairUnresolved: Number(raw.repair_unresolved),
  };

  const allJobsSucceeded = counts.pending === 0
    && counts.failed === 0
    && counts.succeeded === Number(correction.affected_count);
  const allRepairsApplied = counts.repairPending === 0 && counts.repairUnresolved === 0;

  if (allJobsSucceeded && allRepairsApplied) {
    if (correction.status === "completed") {
      return { status: "completed", transitioned: false, counts };
    }
    await client.query(
      `update assessment_correction
          set status = 'completed', completed_at = $2,
              row_version = row_version + 1, updated_at = $2
        where id = $1`,
      [correctionId, now],
    );
    const evidence = { schemaVersion: 1, ...counts, affectedCount: Number(correction.affected_count) };
    await client.query(
      `insert into assessment_correction_event
        (correction_id, actor_role, event, request_id, reason, evidence, evidence_hash, occurred_at)
       values ($1,'system','completed',$2,
         'Every affected attempt and required mastery projection completed.',
         $3::jsonb,$4,$5)`,
      [correctionId, randomUUID(), JSON.stringify(evidence), hashAppealEvidence(evidence), now],
    );
    await closeSourceAppeal(client, correction.source_appeal_id, correctionId, now);
    return { status: "completed", transitioned: true, counts };
  }

  const status: CorrectionCompletionReport["status"] = counts.failed > 0
    ? counts.succeeded > 0 ? "partially_failed" : "failed"
    : counts.repairUnresolved > 0
      ? "partially_failed"
      : "processing";
  const reopeningCompleted = correction.status === "completed";
  if (correction.status !== status || reopeningCompleted) {
    await client.query(
      `update assessment_correction
          set status = $2, completed_at = null,
              row_version = row_version + case when status = 'completed' then 1 else 0 end,
              updated_at = $3
        where id = $1`,
      [correctionId, status, now],
    );
  }
  return { status, transitioned: correction.status !== status, counts };
}
