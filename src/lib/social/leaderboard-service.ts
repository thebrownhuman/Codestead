import type { Pool, PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";

import { hashSocialEvidence } from "./hash";
import {
  LEADERBOARD_FORMULA_PUBLIC,
  LEADERBOARD_FORMULA_VERSION,
  leaderboardPeriod,
  scoreLeaderboardEvidence,
  type LeaderboardEvidenceInput,
  type LeaderboardPeriodKind,
  type XpEvidenceTier,
} from "./scoring";

type SnapshotRow = {
  id: string;
  revision: string | number;
  total_points: number;
  components: Record<string, number>;
  evidence: Record<string, unknown>;
  evidence_hash: string;
  computed_at: Date;
};

type LeaderboardOwner = {
  user_id: string;
  public_id: string;
  alias: string;
};

type LeaderboardPool = Pick<Pool, "connect" | "query">;

type BatchEvidenceRow = {
  user_id: string;
  category: "meaningful_day" | "mastery" | "project" | "comeback" | "xp";
  evidence_key: string;
  evidence_at: Date;
  kind: string | null;
};

type BatchSnapshotRow = SnapshotRow & {
  user_id: string;
  period_kind: LeaderboardPeriodKind;
  period_key: string;
  formula_version: string;
};

type PersistedLeaderboardScore = {
  period: ReturnType<typeof leaderboardPeriod>;
  formulaVersion: typeof LEADERBOARD_FORMULA_VERSION;
  revision: number;
  totalPoints: number;
  components: Record<string, number>;
  counts: Record<string, number>;
  replayed: boolean;
};

const COHORT_SCORE_BATCH_SIZE = 25;

function boundedParams(period: ReturnType<typeof leaderboardPeriod>, now: Date) {
  return [period.start, period.end ?? now] as const;
}

function xpTier(kind: string): XpEvidenceTier {
  if (["practice", "quiz", "game"].includes(kind)) return "easy";
  if (["exam", "project"].includes(kind)) return "challenging";
  return "standard";
}

function snapshotDraft(
  period: ReturnType<typeof leaderboardPeriod>,
  sourceEvidence: LeaderboardEvidenceInput,
) {
  const score = scoreLeaderboardEvidence(period.kind, sourceEvidence);
  const evidence = {
    formulaVersion: LEADERBOARD_FORMULA_VERSION,
    periodKind: period.kind,
    periodKey: period.key,
    acceptedEvidence: score.acceptedEvidence,
    counts: score.counts,
  };
  return { score, evidence, evidenceHash: hashSocialEvidence(evidence) };
}

async function deriveEvidence(
  client: PoolClient,
  userId: string,
  period: ReturnType<typeof leaderboardPeriod>,
  now: Date,
): Promise<LeaderboardEvidenceInput> {
  const [start, end] = boundedParams(period, now);
  const events = await client.query<{ day_key: string }>(
      `select
              to_char(occurred_at at time zone 'UTC','YYYY-MM-DD') day_key
         from learning_session_event
        where user_id = $1 and occurred_at >= $2 and occurred_at < $3
          and metadata->>'meaningful' = 'true'
        order by occurred_at,id`,
      [userId, start, end],
    );
  const mastery = await client.query<{ evidence_key: string }>(
      `select concat(concept_id::text, ':', language_context) evidence_key
         from mastery_evidence where user_id = $1 and validity = 'valid' and score >= 0.8
          and recorded_by in ('verified-runner','adaptive-deterministic-engine')
        group by concept_id,language_context
       having min(recorded_at) >= $2 and min(recorded_at) < $3
        order by evidence_key`,
      [userId, start, end],
    );
  const projects = await client.query<{ evidence_key: string }>(
      `select project_id::text evidence_key from project_review pr
        join project p on p.id = pr.project_id
       where p.user_id = $1
       group by project_id
      having min(pr.created_at) >= $2 and min(pr.created_at) < $3
       order by evidence_key`,
      [userId, start, end],
    );
  const recoveries = await client.query<{ evidence_key: string }>(
      `select rs.id::text evidence_key from review_schedule rs
         join attempt a on a.id = rs.completed_attempt_id
         left join assessment_attempt_effective_result er on er.attempt_id = a.id
        where rs.user_id = $1 and rs.status = 'completed'
          and rs.reason ~ 'lapses=[1-9][0-9]*'
          and a.status = 'graded'
          and case when er.attempt_id is not null
                then er.result ->> 'outcome' = 'MASTERED'
                else a.passed = true and a.mastery_awarded = true
              end
          and case when er.attempt_id is not null
                then coalesce((er.result ->> 'infrastructureFailure')::boolean, false) = false
                else a.infrastructure_failure = false
              end
          and coalesce(er.updated_at, a.graded_at) >= $2
          and coalesce(er.updated_at, a.graded_at) < $3
        order by rs.id`,
      [userId, start, end],
    );
  const xp = await client.query<{ evidence_key: string; kind: string }>(
      `select concat(a.kind::text, ':', coalesce(a.activity_id::text, a.content_version), ':',
                     coalesce(er.result_hash, 'original')) evidence_key,
              a.kind::text kind
         from attempt a
         left join assessment_attempt_effective_result er on er.attempt_id = a.id
        where a.user_id = $1 and a.status = 'graded'
          and case when er.attempt_id is not null
                then er.result ->> 'outcome' = 'MASTERED'
                else a.passed = true and a.mastery_awarded = true
              end
          and case when er.attempt_id is not null
                then coalesce((er.result ->> 'infrastructureFailure')::boolean, false) = false
                else a.infrastructure_failure = false
              end
          and coalesce(er.updated_at, a.graded_at) >= $2
          and coalesce(er.updated_at, a.graded_at) < $3
        group by a.kind,a.activity_id,a.content_version,er.result_hash
        order by evidence_key`,
      [userId, start, end],
    );
  return {
    meaningfulDayKeys: events.rows.map((event) => event.day_key),
    newMasteryEvidenceIds: mastery.rows.map((row) => row.evidence_key),
    projectEvidenceIds: projects.rows.map((row) => row.evidence_key),
    comebackEvidenceIds: recoveries.rows.map((row) => row.evidence_key),
    xpEvents: xp.rows.map((row) => ({ evidenceKey: row.evidence_key, tier: xpTier(row.kind), eligible: true })),
  };
}

export async function computeAndPersistLeaderboardScore(input: {
  readonly userId: string;
  readonly periodKind: LeaderboardPeriodKind;
  readonly now?: Date;
}) {
  const now = input.now ?? new Date();
  const period = leaderboardPeriod(input.periodKind, now);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `leaderboard-score:${input.userId}:${period.kind}:${period.key}:${LEADERBOARD_FORMULA_VERSION}`,
    ]);
    const user = await client.query(`select id from "user" where id = $1 and status = 'active'`, [input.userId]);
    if (!user.rows[0]) throw new Error("LEADERBOARD_USER_NOT_FOUND");
    const sourceEvidence = await deriveEvidence(client, input.userId, period, now);
    const { score, evidence, evidenceHash } = snapshotDraft(period, sourceEvidence);
    const latest = await client.query<SnapshotRow>(
      `select id,revision,total_points,components,evidence,evidence_hash,computed_at
         from leaderboard_score_snapshot
        where user_id = $1 and period_kind = $2 and period_key = $3 and formula_version = $4
        order by revision desc limit 1 for update`,
      [input.userId, period.kind, period.key, LEADERBOARD_FORMULA_VERSION],
    );
    if (latest.rows[0]?.evidence_hash === evidenceHash) {
      await client.query("commit");
      return {
        period,
        formulaVersion: LEADERBOARD_FORMULA_VERSION,
        revision: Number(latest.rows[0].revision),
        totalPoints: latest.rows[0].total_points,
        components: latest.rows[0].components,
        counts: (latest.rows[0].evidence.counts ?? {}) as Record<string, number>,
        replayed: true,
      };
    }
    const revision = Number(latest.rows[0]?.revision ?? 0) + 1;
    await client.query(
      `insert into leaderboard_score_snapshot
        (user_id,period_kind,period_key,period_start,period_end,formula_version,revision,
         total_points,components,evidence,evidence_hash,computed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
      [input.userId, period.kind, period.key, period.start, period.end,
        LEADERBOARD_FORMULA_VERSION, revision, score.totalPoints, JSON.stringify(score.components),
        JSON.stringify(evidence), evidenceHash, now],
    );
    await client.query("commit");
    return {
      period,
      formulaVersion: LEADERBOARD_FORMULA_VERSION,
      revision,
      totalPoints: score.totalPoints,
      components: score.components,
      counts: score.counts,
      replayed: false,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function eligibleLeaderboardOwners(databasePool: LeaderboardPool) {
  const result = await databasePool.query<LeaderboardOwner>(
    `select cp.user_id,u.public_id,cp.alias
       from cohort_profile cp join "user" u on u.id = cp.user_id
       join lateral (
         select id,decision,policy_version from consent_record
          where user_id = cp.user_id and purpose = 'cohort_profile'
          order by occurred_at desc, created_at desc, id desc limit 1
       ) profile_consent on profile_consent.id = cp.published_consent_record_id
       join lateral (
         select decision,policy_version from consent_record
          where user_id = cp.user_id and purpose = 'leaderboard'
          order by occurred_at desc, created_at desc, id desc limit 1
       ) leaderboard_consent on true
      where cp.is_published and u.status = 'active'
        and profile_consent.decision = 'accepted' and profile_consent.policy_version = $1
        and leaderboard_consent.decision = 'accepted' and leaderboard_consent.policy_version = $1`,
    [ENROLLMENT_DISCLOSURE_VERSION],
  );
  return result.rows;
}

function batchKey(userId: string, period: ReturnType<typeof leaderboardPeriod>) {
  return `${userId}\u0000${period.kind}\u0000${period.key}`;
}

function evidenceForPeriod(
  rows: readonly BatchEvidenceRow[],
  period: ReturnType<typeof leaderboardPeriod>,
  now: Date,
): LeaderboardEvidenceInput {
  const [start, end] = boundedParams(period, now);
  const included = rows.filter((row) => row.evidence_at >= start && row.evidence_at < end);
  return {
    meaningfulDayKeys: included.filter((row) => row.category === "meaningful_day").map((row) => row.evidence_key),
    newMasteryEvidenceIds: included.filter((row) => row.category === "mastery").map((row) => row.evidence_key),
    projectEvidenceIds: included.filter((row) => row.category === "project").map((row) => row.evidence_key),
    comebackEvidenceIds: included.filter((row) => row.category === "comeback").map((row) => row.evidence_key),
    xpEvents: included.filter((row) => row.category === "xp").map((row) => ({
      evidenceKey: row.evidence_key,
      tier: xpTier(row.kind ?? ""),
      eligible: true,
    })),
  };
}

async function computeCohortScoreBatch(input: {
  readonly owners: readonly LeaderboardOwner[];
  readonly now: Date;
  readonly databasePool: LeaderboardPool;
}) {
  const weekly = leaderboardPeriod("weekly", input.now);
  const allTime = leaderboardPeriod("all_time", input.now);
  const periods = [weekly, allTime] as const;
  const userIds = input.owners.map((owner) => owner.user_id);
  const client = await input.databasePool.connect();
  try {
    await client.query("begin");
    const lockKeys = userIds.flatMap((userId) => periods.map((period) =>
      `leaderboard-score:${userId}:${period.kind}:${period.key}:${LEADERBOARD_FORMULA_VERSION}`)).sort();
    await client.query(
      `select pg_advisory_xact_lock(hashtext(lock_key))
         from unnest($1::text[]) locks(lock_key)
        order by lock_key`,
      [lockKeys],
    );

    const active = await client.query<{ id: string }>(
      `select id from "user" where id = any($1::text[]) and status = 'active' order by id`,
      [userIds],
    );
    if (active.rows.length !== new Set(userIds).size) throw new Error("LEADERBOARD_USER_NOT_FOUND");

    const [allTimeStart, allTimeEnd] = boundedParams(allTime, input.now);
    const evidenceResult = await client.query<BatchEvidenceRow>(
      `with selected_owner(user_id) as (select unnest($1::text[])),
            meaningful as (
              select e.user_id, 'meaningful_day'::text category,
                     to_char(e.occurred_at at time zone 'UTC','YYYY-MM-DD') evidence_key,
                     e.occurred_at evidence_at, null::text kind
                from learning_session_event e join selected_owner o on o.user_id = e.user_id
               where e.occurred_at >= $2 and e.occurred_at < $3
                 and e.metadata->>'meaningful' = 'true'
            ),
            mastery as (
              select m.user_id, 'mastery'::text category,
                     concat(m.concept_id::text, ':', m.language_context) evidence_key,
                     min(m.recorded_at) evidence_at, null::text kind
                from mastery_evidence m join selected_owner o on o.user_id = m.user_id
               where m.validity = 'valid' and m.score >= 0.8
                 and m.recorded_by in ('verified-runner','adaptive-deterministic-engine')
               group by m.user_id,m.concept_id,m.language_context
              having min(m.recorded_at) >= $2 and min(m.recorded_at) < $3
            ),
            projects as (
              select p.user_id, 'project'::text category, pr.project_id::text evidence_key,
                     min(pr.created_at) evidence_at, null::text kind
                from project_review pr join project p on p.id = pr.project_id
                join selected_owner o on o.user_id = p.user_id
               group by p.user_id,pr.project_id
              having min(pr.created_at) >= $2 and min(pr.created_at) < $3
            ),
            recoveries as (
              select rs.user_id, 'comeback'::text category, rs.id::text evidence_key,
                     coalesce(er.updated_at, a.graded_at) evidence_at, null::text kind
                from review_schedule rs join selected_owner o on o.user_id = rs.user_id
                join attempt a on a.id = rs.completed_attempt_id
                left join assessment_attempt_effective_result er on er.attempt_id = a.id
               where rs.status = 'completed' and rs.reason ~ 'lapses=[1-9][0-9]*'
                 and a.status = 'graded'
                 and case when er.attempt_id is not null
                       then er.result ->> 'outcome' = 'MASTERED'
                       else a.passed = true and a.mastery_awarded = true
                     end
                 and case when er.attempt_id is not null
                       then coalesce((er.result ->> 'infrastructureFailure')::boolean, false) = false
                       else a.infrastructure_failure = false
                     end
                 and coalesce(er.updated_at, a.graded_at) >= $2
                 and coalesce(er.updated_at, a.graded_at) < $3
            ),
            xp as (
              select a.user_id, 'xp'::text category,
                     concat(a.kind::text, ':', coalesce(a.activity_id::text, a.content_version), ':',
                            coalesce(er.result_hash, 'original')) evidence_key,
                     coalesce(er.updated_at, a.graded_at) evidence_at, a.kind::text kind
                from attempt a join selected_owner o on o.user_id = a.user_id
                left join assessment_attempt_effective_result er on er.attempt_id = a.id
               where a.status = 'graded'
                 and case when er.attempt_id is not null
                       then er.result ->> 'outcome' = 'MASTERED'
                       else a.passed = true and a.mastery_awarded = true
                     end
                 and case when er.attempt_id is not null
                       then coalesce((er.result ->> 'infrastructureFailure')::boolean, false) = false
                       else a.infrastructure_failure = false
                     end
                 and coalesce(er.updated_at, a.graded_at) >= $2
                 and coalesce(er.updated_at, a.graded_at) < $3
            )
       select * from meaningful
       union all select * from mastery
       union all select * from projects
       union all select * from recoveries
       union all select * from xp
       order by user_id,category,evidence_key,evidence_at`,
      [userIds, allTimeStart, allTimeEnd],
    );

    const latestResult = await client.query<BatchSnapshotRow>(
      `select distinct on (user_id,period_kind,period_key,formula_version)
              user_id,period_kind,period_key,formula_version,id,revision,total_points,
              components,evidence,evidence_hash,computed_at
         from leaderboard_score_snapshot
        where user_id = any($1::text[])
          and ((period_kind = 'weekly' and period_key = $2)
            or (period_kind = 'all_time' and period_key = $3))
          and formula_version = $4
        order by user_id,period_kind,period_key,formula_version,revision desc`,
      [userIds, weekly.key, allTime.key, LEADERBOARD_FORMULA_VERSION],
    );
    const latestByKey = new Map(latestResult.rows.map((row) => [
      `${row.user_id}\u0000${row.period_kind}\u0000${row.period_key}`,
      row,
    ]));
    const evidenceByUser = new Map<string, BatchEvidenceRow[]>();
    for (const row of evidenceResult.rows) {
      const rows = evidenceByUser.get(row.user_id) ?? [];
      rows.push(row);
      evidenceByUser.set(row.user_id, rows);
    }

    const scores = new Map<string, PersistedLeaderboardScore>();
    const inserts: Array<Record<string, unknown>> = [];
    for (const owner of input.owners) {
      const rows = evidenceByUser.get(owner.user_id) ?? [];
      for (const period of periods) {
        const { score, evidence, evidenceHash } = snapshotDraft(
          period,
          evidenceForPeriod(rows, period, input.now),
        );
        const latest = latestByKey.get(batchKey(owner.user_id, period));
        if (latest?.evidence_hash === evidenceHash) {
          scores.set(batchKey(owner.user_id, period), {
            period,
            formulaVersion: LEADERBOARD_FORMULA_VERSION,
            revision: Number(latest.revision),
            totalPoints: latest.total_points,
            components: latest.components,
            counts: (latest.evidence.counts ?? {}) as Record<string, number>,
            replayed: true,
          });
          continue;
        }
        const revision = Number(latest?.revision ?? 0) + 1;
        scores.set(batchKey(owner.user_id, period), {
          period,
          formulaVersion: LEADERBOARD_FORMULA_VERSION,
          revision,
          totalPoints: score.totalPoints,
          components: score.components,
          counts: score.counts,
          replayed: false,
        });
        inserts.push({
          user_id: owner.user_id,
          period_kind: period.kind,
          period_key: period.key,
          period_start: period.start,
          period_end: period.end,
          formula_version: LEADERBOARD_FORMULA_VERSION,
          revision,
          total_points: score.totalPoints,
          components: score.components,
          evidence,
          evidence_hash: evidenceHash,
          computed_at: input.now,
        });
      }
    }
    if (inserts.length > 0) {
      await client.query(
        `insert into leaderboard_score_snapshot
          (user_id,period_kind,period_key,period_start,period_end,formula_version,revision,
           total_points,components,evidence,evidence_hash,computed_at)
         select user_id,period_kind,period_key,period_start,period_end,formula_version,revision,
                total_points,components,evidence,evidence_hash,computed_at
           from jsonb_to_recordset($1::jsonb) as batch(
             user_id text, period_kind text, period_key text, period_start timestamptz,
             period_end timestamptz, formula_version text, revision bigint, total_points integer,
             components jsonb, evidence jsonb, evidence_hash text, computed_at timestamptz
           )`,
        [JSON.stringify(inserts)],
      );
    }
    await client.query("commit");
    return scores;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function computeCohortScores(input: {
  readonly owners: readonly LeaderboardOwner[];
  readonly now: Date;
  readonly databasePool: LeaderboardPool;
}) {
  const scores = new Map<string, PersistedLeaderboardScore>();
  for (let offset = 0; offset < input.owners.length; offset += COHORT_SCORE_BATCH_SIZE) {
    const batch = await computeCohortScoreBatch({
      ...input,
      owners: input.owners.slice(offset, offset + COHORT_SCORE_BATCH_SIZE),
    });
    for (const [key, score] of batch) scores.set(key, score);
  }
  return scores;
}

export async function loadCohortLeaderboards(now = new Date(), databasePool: LeaderboardPool = pool) {
  const owners = await eligibleLeaderboardOwners(databasePool);
  const scored = await computeCohortScores({ owners, now, databasePool });
  const entries = (kind: LeaderboardPeriodKind) => owners.map((owner, ownerIndex) => {
    const period = leaderboardPeriod(kind, now);
    const score = scored.get(batchKey(owner.user_id, period));
    if (!score) throw new Error(`LEADERBOARD_SCORE_MISSING:${ownerIndex}`);
    return {
      publicId: owner.public_id,
      alias: owner.alias,
      totalPoints: score.totalPoints,
      components: score.components,
      counts: score.counts,
    };
  }).sort((left, right) =>
    right.totalPoints - left.totalPoints
    || left.alias.localeCompare(right.alias, undefined, { sensitivity: "base" })
    || left.publicId.localeCompare(right.publicId))
    .map((entry, index) => ({ rank: index + 1, ...entry }));
  const weekly = entries("weekly");
  const allTime = entries("all_time");
  return {
    formula: LEADERBOARD_FORMULA_PUBLIC,
    weekly: {
      period: leaderboardPeriod("weekly", now),
      entries: weekly,
    },
    allTime: {
      period: leaderboardPeriod("all_time", now),
      entries: allTime,
    },
  };
}
