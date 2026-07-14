import type { PoolClient } from "pg";

import { hashCurriculumValue } from "@/lib/curriculum-publication/hash";
import { pool } from "@/lib/db/client";
import { evaluateAuthoredActivity } from "@/lib/learning-service/evidence-engine";
import { reviewedAuthoredActivitySpecification } from "@/lib/learning-service/publication-binding";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCORING_VERSION = "battle-score-v1";
const MAX_ANSWER_BYTES = 64 * 1_024;

export type BattleErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "NOT_OPEN"
  | "NOT_PARTICIPANT"
  | "ALREADY_SUBMITTED"
  | "IDEMPOTENCY_CONFLICT"
  | "ACTIVITY_NOT_ELIGIBLE"
  | "ATTEMPT_NOT_ELIGIBLE"
  | "INTEGRITY_FAILURE";

export class BattleError extends Error {
  constructor(public readonly code: BattleErrorCode) {
    super(code);
  }
}

type Actor = { id: string; role: "admin" | "learner" };
type JsonRecord = Record<string, unknown>;

type ActivitySnapshotRow = {
  id: string;
  slug: string;
  type: string;
  instructions: string;
  specification: JsonRecord;
  max_points: number;
  skill_key: string;
  skill_title: string;
  language: string | null;
  course_version_id: string;
  course_version: string;
  course_content_hash: string;
  artifact_content_hash: string;
  artifact_content: JsonRecord;
  review_event_id: string;
};

type BattleRow = {
  id: string;
  creator_user_id: string | null;
  create_request_id: string;
  create_input_hash: string;
  activity_id: string;
  scope: "invite" | "cohort" | "weekly" | "monthly";
  competition_key: string | null;
  title: string;
  language: string;
  skill_key: string;
  challenge_kind: "authored_answer" | "verified_attempt";
  immutable_snapshot: JsonRecord;
  snapshot_hash: string;
  scoring_version: string;
  max_points: number;
  status: "active" | "cancelled";
  starts_at: Date;
  ends_at: Date;
  reveal_at: Date;
  created_at: Date;
  participant: boolean;
  submitted: boolean;
  participant_count: string;
  submission_count: string;
};

async function activeActor(client: PoolClient, userId: string): Promise<Actor> {
  const row = (await client.query<{ id: string; role: string | null }>(
    `select id,role from "user" where id=$1 and status='active' and role in ('admin','learner')`,
    [userId],
  )).rows[0];
  if (!row || (row.role !== "admin" && row.role !== "learner")) throw new BattleError("NOT_FOUND");
  return { id: row.id, role: row.role };
}

function cleanDate(value: Date | undefined, fallback: Date) {
  const date = value ?? fallback;
  if (!Number.isFinite(date.getTime())) throw new BattleError("INVALID_INPUT");
  return date;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function withoutAnswerMaterial(specification: JsonRecord): JsonRecord {
  const privateKeys = new Set([
    "grading", "feedback", "solutionReveal", "hints", "workedExample",
    "alternateExplanation", "remediation",
  ]);
  const publicSpecification = Object.fromEntries(
    Object.entries(specification).filter(([key]) => !privateKeys.has(key)),
  );
  return publicSpecification;
}

function stateAt(row: Pick<BattleRow, "status" | "starts_at" | "ends_at" | "reveal_at">, now: Date) {
  if (row.status === "cancelled") return "cancelled" as const;
  if (now < row.starts_at) return "scheduled" as const;
  if (now < row.ends_at) return "open" as const;
  if (now < row.reveal_at) return "closed" as const;
  return "revealed" as const;
}

function publicBattle(row: BattleRow, now: Date, actorRole: Actor["role"]) {
  const snapshot = row.immutable_snapshot;
  const specification = record(snapshot.specification) ?? {};
  const state = stateAt(row, now);
  return {
    id: row.id,
    scope: row.scope,
    competitionKey: row.competition_key,
    title: row.title,
    language: row.language,
    skillKey: row.skill_key,
    challengeKind: row.challenge_kind,
    scoringVersion: row.scoring_version,
    maxPoints: row.max_points,
    status: state,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    revealAt: row.reveal_at.toISOString(),
    participantCount: Number(row.participant_count),
    submissionCount: Number(row.submission_count),
    participant: row.participant,
    submitted: row.submitted,
    canJoin: actorRole === "learner" && row.status === "active" && row.scope !== "invite"
      && !row.participant && now < row.ends_at,
    prompt: state === "scheduled" ? null : {
      instructions: String(snapshot.instructions ?? ""),
      specification: withoutAnswerMaterial(specification),
    },
    limitations: row.challenge_kind === "verified_attempt"
      ? "Complete the frozen reviewed activity in the normal lesson workspace, then submit its independently graded attempt ID here. Source code and hidden tests are not copied into the battle."
      : "This asynchronous challenge uses a frozen human-reviewed deterministic grader. AI answers and live multiplayer are unavailable.",
  };
}

async function eligibleActivityIds(client: PoolClient, userId: string, activityIds: readonly string[]) {
  if (!activityIds.length) return new Set<string>();
  const rows = await client.query<{ id: string }>(
    `select distinct candidate.id
       from activity candidate
       join concept candidate_concept on candidate_concept.id=candidate.concept_id
       join lesson candidate_lesson on candidate_lesson.id=candidate.lesson_id
       join course_module candidate_module on candidate_module.id=candidate_lesson.module_id
       join enrollment candidate_enrollment
         on candidate_enrollment.course_version_id=candidate_module.course_version_id
        and candidate_enrollment.user_id=$1
        and candidate_enrollment.status in ('active','completed')
      where candidate.id=any($2::uuid[])
        and (
          candidate_enrollment.status='completed'
          or exists (
            select 1
              from plan_revision current_plan
              cross join lateral jsonb_array_elements(current_plan.plan) plan_item(item)
             where current_plan.enrollment_id=candidate_enrollment.id
               and current_plan.id=(
                 select latest_plan.id from plan_revision latest_plan
                  where latest_plan.enrollment_id=candidate_enrollment.id
                  order by latest_plan.revision desc limit 1
               )
               and plan_item.item->>'skillId'=candidate_concept.slug
               and not exists (
                 select 1
                   from jsonb_array_elements_text(
                     coalesce(plan_item.item->'prerequisites','[]'::jsonb)
                   ) prerequisite(skill_id)
                  where not exists (
                    select 1
                      from concept prerequisite_concept
                      join concept_mastery prerequisite_mastery
                        on prerequisite_mastery.concept_id=prerequisite_concept.id
                       and prerequisite_mastery.user_id=candidate_enrollment.user_id
                       and prerequisite_mastery.enrollment_id=candidate_enrollment.id
                       and prerequisite_mastery.status in ('proficient','mastered','needs_review')
                     where prerequisite_concept.slug=prerequisite.skill_id
                  )
               )
          )
        )`,
    [userId, [...new Set(activityIds)]],
  );
  return new Set(rows.rows.map((row) => row.id));
}

async function reviewedActivity(client: PoolClient, activityId: string, actor: Actor): Promise<ActivitySnapshotRow> {
  if (!UUID.test(activityId)) throw new BattleError("ACTIVITY_NOT_ELIGIBLE");
  const row = (await client.query<ActivitySnapshotRow>(
    `select a.id,a.slug,a.type,a.instructions,a.specification,a.max_points,
            concept.slug as skill_key,concept.title as skill_title,
            nullif(a.specification->>'language','') as language,
            version.id as course_version_id,version.version as course_version,
            version.content_hash as course_content_hash,
            artifact.content_hash as artifact_content_hash,artifact.content as artifact_content,
            review_event.id as review_event_id
       from activity a
       join concept on concept.id=a.concept_id
       join lesson on lesson.id=a.lesson_id
       join course_module module on module.id=lesson.module_id
       join course_version version on version.id=module.course_version_id
       join curriculum_publication_pointer pointer
         on pointer.course_id=version.course_id and pointer.current_course_version_id=version.id
       join curriculum_artifact artifact
         on artifact.course_version_id=version.id
        and artifact.artifact_type='assessment_bank'
        and artifact.skill_key=concept.slug
        and artifact.review_status='approved'
        and artifact.publication_stage in ('approved','published')
       join lateral (
         select event.id from curriculum_review_event event
          where event.artifact_id=artifact.id
            and event.reviewer_kind='human'
            and event.decision='approved'
            and event.content_hash=artifact.content_hash
            and event.reviewed_item_ids ? (a.specification->>'authoredItemId')
          order by event.occurred_at desc,event.id desc limit 1
       ) review_event on true
      where a.id=$1 and version.stage in ('beta','verified')
        and lesson.content_status in ('beta','verified')
      limit 1`,
    [activityId],
  )).rows[0];
  if (!row) throw new BattleError("ACTIVITY_NOT_ELIGIBLE");
  if (actor.role === "learner"
    && !(await eligibleActivityIds(client, actor.id, [row.id])).has(row.id)) {
    throw new BattleError("ACTIVITY_NOT_ELIGIBLE");
  }
  if (hashCurriculumValue(row.artifact_content) !== row.artifact_content_hash) {
    throw new BattleError("ACTIVITY_NOT_ELIGIBLE");
  }
  const reviewedSpecification = reviewedAuthoredActivitySpecification(
    row.specification,
    row.artifact_content,
    row.skill_key,
  );
  if (!reviewedSpecification) throw new BattleError("ACTIVITY_NOT_ELIGIBLE");
  row.specification = { ...reviewedSpecification };
  row.language = typeof reviewedSpecification.language === "string"
    ? reviewedSpecification.language
    : null;
  const grading = record(row.specification.grading);
  if (!grading || typeof grading.kind !== "string") throw new BattleError("ACTIVITY_NOT_ELIGIBLE");
  const supported = ["exact", "choice", "set", "gaps", "runner"].includes(grading.kind);
  if (!supported || ["ai", "llm", "model"].includes(grading.kind)) throw new BattleError("ACTIVITY_NOT_ELIGIBLE");
  return row;
}

function createFingerprint(input: {
  actorUserId: string; requestId: string; activityId: string; scope: string;
  invitedPublicIds: readonly string[]; startsAt: Date; endsAt: Date; revealAt: Date; competitionKey: string | null;
}) {
  return hashCurriculumValue({
    version: 1,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    activityId: input.activityId,
    scope: input.scope,
    invitedPublicIds: [...new Set(input.invitedPublicIds)].sort(),
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
    revealAt: input.revealAt.toISOString(),
    competitionKey: input.competitionKey,
  });
}

function competitionWindow(scope: "weekly" | "monthly", key: string) {
  if (scope === "weekly") {
    const match = /^(\d{4})-W(\d{2})(?:-[a-z0-9-]{1,20})?$/.exec(key);
    if (!match) throw new BattleError("INVALID_INPUT");
    const year = Number(match[1]);
    const week = Number(match[2]);
    if (week < 1 || week > 53) throw new BattleError("INVALID_INPUT");
    const januaryFourth = new Date(Date.UTC(year, 0, 4));
    const mondayOffset = (januaryFourth.getUTCDay() + 6) % 7;
    const startsAt = new Date(januaryFourth.getTime() - mondayOffset * 86_400_000 + (week - 1) * 7 * 86_400_000);
    const endsAt = new Date(startsAt.getTime() + 7 * 86_400_000);
    return { startsAt, endsAt, revealAt: new Date(endsAt.getTime() + 60 * 60_000) };
  }
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-[a-z0-9-]{1,20})?$/.exec(key);
  if (!match) throw new BattleError("INVALID_INPUT");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startsAt = new Date(Date.UTC(year, month - 1, 1));
  const endsAt = new Date(Date.UTC(year, month, 1));
  return { startsAt, endsAt, revealAt: new Date(endsAt.getTime() + 60 * 60_000) };
}

export async function createBattle(input: {
  actorUserId: string;
  requestId: string;
  activityId: string;
  scope: "invite" | "cohort" | "weekly" | "monthly";
  invitedPublicIds?: readonly string[];
  startsAt?: Date;
  durationMinutes?: number;
  revealDelayMinutes?: number;
  competitionKey?: string | null;
  now?: Date;
}) {
  const competition = input.scope === "weekly" || input.scope === "monthly";
  if (!UUID.test(input.requestId) || (!competition && (!Number.isSafeInteger(input.durationMinutes)
    || input.durationMinutes! < 5 || input.durationMinutes! > 1_440))) throw new BattleError("INVALID_INPUT");
  const revealDelay = input.revealDelayMinutes ?? 0;
  if (!Number.isSafeInteger(revealDelay) || revealDelay < 0 || revealDelay > 10_080) throw new BattleError("INVALID_INPUT");
  const now = cleanDate(input.now, new Date());
  const competitionKey = competition ? input.competitionKey?.trim() ?? null : null;
  if ((competition && !competitionKey) || (!competition && input.competitionKey)) throw new BattleError("INVALID_INPUT");
  const fixedWindow = competition ? competitionWindow(input.scope as "weekly" | "monthly", competitionKey!) : null;
  const startsAt = fixedWindow?.startsAt ?? cleanDate(input.startsAt, now);
  const endsAt = fixedWindow?.endsAt ?? new Date(startsAt.getTime() + input.durationMinutes! * 60_000);
  const revealAt = fixedWindow?.revealAt ?? new Date(endsAt.getTime() + revealDelay * 60_000);
  if ((!competition && (startsAt.getTime() < now.getTime() - 5 * 60_000 || startsAt.getTime() > now.getTime() + 30 * 86_400_000))
    || (competition && endsAt <= now)) {
    throw new BattleError("INVALID_INPUT");
  }
  const invitedPublicIds = [...new Set(input.invitedPublicIds ?? [])];
  if (invitedPublicIds.length > 20 || invitedPublicIds.some((id) => !UUID.test(id))) throw new BattleError("INVALID_INPUT");
  if (input.scope === "invite" && invitedPublicIds.length < 1) throw new BattleError("INVALID_INPUT");
  if (input.scope !== "invite" && invitedPublicIds.length) throw new BattleError("INVALID_INPUT");
  const fingerprint = createFingerprint({ ...input, invitedPublicIds, startsAt, endsAt, revealAt, competitionKey });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const actor = await activeActor(client, input.actorUserId);
    if (competition && actor.role !== "admin") throw new BattleError("NOT_FOUND");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`battle-create:${actor.id}:${input.requestId}`]);
    const replay = (await client.query<{ id: string; create_input_hash: string }>(
      `select id,create_input_hash from coding_battle where creator_user_id=$1 and create_request_id=$2`,
      [actor.id, input.requestId],
    )).rows[0];
    if (replay) {
      if (replay.create_input_hash !== fingerprint) throw new BattleError("IDEMPOTENCY_CONFLICT");
      await client.query("commit");
      return { id: replay.id, replayed: true };
    }
    const activity = await reviewedActivity(client, input.activityId, actor);
    const grading = record(activity.specification.grading)!;
    const challengeKind = grading.kind === "runner" ? "verified_attempt" : "authored_answer";
    const snapshot: JsonRecord = {
      version: 1,
      activityId: activity.id,
      activitySlug: activity.slug,
      activityType: activity.type,
      instructions: typeof activity.specification.prompt === "string"
        ? activity.specification.prompt
        : activity.instructions,
      specification: activity.specification,
      skillKey: activity.skill_key,
      language: activity.language ?? "Language-neutral",
      provenance: {
        courseVersionId: activity.course_version_id,
        courseVersion: activity.course_version,
        courseContentHash: activity.course_content_hash,
        assessmentArtifactHash: activity.artifact_content_hash,
        humanReviewEventId: activity.review_event_id,
      },
    };
    const snapshotHash = hashCurriculumValue(snapshot);
    const battle = (await client.query<{ id: string }>(
      `insert into coding_battle
        (creator_user_id,create_request_id,create_input_hash,activity_id,scope,competition_key,title,language,
         skill_key,challenge_kind,immutable_snapshot,snapshot_hash,scoring_version,max_points,status,
         starts_at,ends_at,reveal_at,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,'active',$15,$16,$17,$18,$18)
       returning id`,
      [actor.id, input.requestId, fingerprint, activity.id, input.scope, competitionKey,
        `${typeof activity.specification.title === "string" ? activity.specification.title : activity.skill_title} challenge`,
        activity.language ?? "Language-neutral", activity.skill_key,
        challengeKind, JSON.stringify(snapshot), snapshotHash, SCORING_VERSION,
        Math.min(1_000, Math.max(1, activity.max_points)), startsAt, endsAt, revealAt, now],
    )).rows[0];
    if (!battle) throw new BattleError("INTEGRITY_FAILURE");
    if (actor.role === "learner") {
      await client.query(
        `insert into coding_battle_participant (battle_id,user_id,role,joined_at)
         values ($1,$2,'creator',$3)`, [battle.id, actor.id, now],
      );
    }
    if (input.scope === "invite") {
      const invited = await client.query<{ id: string }>(
        `select u.id from "user" u
          join cohort_profile profile on profile.user_id=u.id and profile.is_published
          join lateral (
            select decision,policy_version from consent_record consent
             where consent.user_id=u.id and consent.purpose='cohort_profile'
             order by consent.occurred_at desc,consent.created_at desc,consent.id desc limit 1
          ) consent on consent.decision='accepted' and consent.policy_version=$2
         where u.public_id=any($1::uuid[]) and u.status='active' and u.role='learner' and u.id<>$3`,
        [invitedPublicIds, ENROLLMENT_DISCLOSURE_VERSION, actor.id],
      );
      if (invited.rows.length !== invitedPublicIds.length) throw new BattleError("NOT_FOUND");
      for (const invitee of invited.rows) {
        if (!(await eligibleActivityIds(client, invitee.id, [activity.id])).has(activity.id)) {
          throw new BattleError("NOT_FOUND");
        }
        await client.query(
          `insert into coding_battle_participant (battle_id,user_id,role,joined_at)
           values ($1,$2,'invited',$3)`, [battle.id, invitee.id, now],
        );
      }
    }
    await client.query("commit");
    return { id: battle.id, replayed: false };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if ((error as { code?: string; constraint?: string }).code === "23505"
      && (error as { constraint?: string }).constraint === "coding_battle_competition_key_unique") {
      throw new BattleError("IDEMPOTENCY_CONFLICT");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadAccessibleBattle(client: PoolClient, actor: Actor, battleId: string, lock = false): Promise<BattleRow> {
  if (!UUID.test(battleId)) throw new BattleError("NOT_FOUND");
  const row = (await client.query<BattleRow>(
    `select battle.*,
            participant.user_id is not null as participant,
            submission.id is not null as submitted,
            (select count(*)::text from coding_battle_participant p where p.battle_id=battle.id) participant_count,
            (select count(*)::text from coding_battle_submission s where s.battle_id=battle.id) submission_count
       from coding_battle battle
       left join coding_battle_participant participant on participant.battle_id=battle.id and participant.user_id=$2
       left join coding_battle_submission submission on submission.battle_id=battle.id and submission.user_id=$2
      where battle.id=$1 and ($3='admin' or battle.scope in ('cohort','weekly','monthly') or participant.user_id is not null)
      ${lock ? "for update of battle" : ""}`,
    [battleId, actor.id, actor.role],
  )).rows[0];
  if (!row) throw new BattleError("NOT_FOUND");
  if (actor.role === "learner" && !row.participant
    && !(await eligibleActivityIds(client, actor.id, [row.activity_id])).has(row.activity_id)) {
    throw new BattleError("NOT_FOUND");
  }
  if (hashCurriculumValue(row.immutable_snapshot) !== row.snapshot_hash) throw new BattleError("INTEGRITY_FAILURE");
  return row;
}

export async function listBattles(input: { actorUserId: string; now?: Date; limit?: number }) {
  const now = cleanDate(input.now, new Date());
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 30)));
  const client = await pool.connect();
  try {
    const actor = await activeActor(client, input.actorUserId);
    const rows = await client.query<BattleRow>(
      `select battle.*,
              participant.user_id is not null as participant,
              submission.id is not null as submitted,
              (select count(*)::text from coding_battle_participant p where p.battle_id=battle.id) participant_count,
              (select count(*)::text from coding_battle_submission s where s.battle_id=battle.id) submission_count
         from coding_battle battle
         left join coding_battle_participant participant on participant.battle_id=battle.id and participant.user_id=$1
         left join coding_battle_submission submission on submission.battle_id=battle.id and submission.user_id=$1
        where ($2='admin' or battle.scope in ('cohort','weekly','monthly') or participant.user_id is not null)
        order by case when battle.status='active' and battle.ends_at>$3 then 0 else 1 end,
                 battle.starts_at desc,battle.id desc limit $4`,
      [actor.id, actor.role, now, limit],
    );
    const eligible = actor.role === "learner"
      ? await eligibleActivityIds(client, actor.id, rows.rows.map((row) => row.activity_id))
      : null;
    const visibleRows = actor.role === "admin"
      ? rows.rows
      : rows.rows.filter((row) => row.participant || eligible!.has(row.activity_id));
    const sources = await client.query<{
      id: string; skill_key: string; skill_title: string; language: string | null;
      activity_type: string; specification: JsonRecord; artifact_content: JsonRecord;
      artifact_content_hash: string;
    }>(
      `select distinct on (a.id) a.id,concept.slug skill_key,concept.title skill_title,
              nullif(a.specification->>'language','') language,a.type activity_type,
              a.specification,artifact.content artifact_content,
              artifact.content_hash artifact_content_hash
         from activity a
         join concept on concept.id=a.concept_id
         join lesson on lesson.id=a.lesson_id
         join course_module module on module.id=lesson.module_id
         join course_version version on version.id=module.course_version_id
         join curriculum_publication_pointer pointer
           on pointer.course_id=version.course_id and pointer.current_course_version_id=version.id
         join curriculum_artifact artifact
           on artifact.course_version_id=version.id and artifact.artifact_type='assessment_bank'
          and artifact.skill_key=concept.slug and artifact.review_status='approved'
          and artifact.publication_stage in ('approved','published')
         join curriculum_review_event review_event on review_event.artifact_id=artifact.id
          and review_event.reviewer_kind='human' and review_event.decision='approved'
          and review_event.content_hash=artifact.content_hash
          and review_event.reviewed_item_ids ? (a.specification->>'authoredItemId')
        where version.stage in ('beta','verified') and lesson.content_status in ('beta','verified')
          and nullif(a.specification->>'authoredItemId','') is not null
        order by a.id,review_event.occurred_at desc
        limit 100`,
    );
    const eligibleSources = actor.role === "learner"
      ? await eligibleActivityIds(client, actor.id, sources.rows.map((source) => source.id))
      : null;
    return {
      battles: visibleRows.map((row) => publicBattle(row, now, actor.role)),
      sources: sources.rows.flatMap((source) => {
        if (eligibleSources && !eligibleSources.has(source.id)) return [];
        if (hashCurriculumValue(source.artifact_content) !== source.artifact_content_hash) return [];
        const specification = reviewedAuthoredActivitySpecification(
          source.specification,
          source.artifact_content,
          source.skill_key,
        );
        if (!specification) return [];
        const grading = record(specification.grading);
        if (!grading || typeof grading.kind !== "string"
          || !["exact", "choice", "set", "gaps", "runner"].includes(grading.kind)) return [];
        return [{
          activityId: source.id,
          skillKey: source.skill_key,
          title: typeof specification.title === "string" ? specification.title : source.skill_title,
          language: typeof specification.language === "string"
            ? specification.language
            : "Language-neutral",
          kind: source.activity_type,
        }];
      }),
      scoring: {
        version: SCORING_VERSION,
        rule: "The server grades against the frozen reviewed activity. Equal scores share rank; stable participant order is only a display tie-break and awards no extra points.",
        reveal: "Participant results and scores remain hidden from every learner until the server reveal time.",
      },
    };
  } finally {
    client.release();
  }
}

export async function getBattle(input: { actorUserId: string; battleId: string; now?: Date }) {
  const now = cleanDate(input.now, new Date());
  const client = await pool.connect();
  try {
    const actor = await activeActor(client, input.actorUserId);
    const battle = await loadAccessibleBattle(client, actor, input.battleId);
    const revealed = stateAt(battle, now) === "revealed";
    const results = revealed
      ? await client.query<{
          user_id: string; score: number; passed: boolean; public_id: string; alias: string | null; shared_rank: string;
        }>(
          `select submission.user_id,submission.score,submission.passed,u.public_id::text,
                  case when profile.is_published and consent.decision='accepted' and consent.policy_version=$2 then profile.alias else null end alias,
                  rank() over (order by submission.score desc)::text shared_rank
             from coding_battle_submission submission
             join "user" u on u.id=submission.user_id
             left join cohort_profile profile on profile.user_id=u.id
             left join lateral (
               select decision,policy_version from consent_record c
                where c.user_id=u.id and c.purpose='cohort_profile'
                order by c.occurred_at desc,c.created_at desc,c.id desc limit 1
             ) consent on true
            where submission.battle_id=$1
            order by submission.score desc,u.public_id asc`,
          [battle.id, ENROLLMENT_DISCLOSURE_VERSION],
        )
      : { rows: [] as Array<{ user_id: string; score: number; passed: boolean; public_id: string; alias: string | null; shared_rank: string }> };
    return {
      battle: publicBattle(battle, now, actor.role),
      resultsRevealed: revealed,
      results: results.rows.map((result, index) => ({
        rank: Number(result.shared_rank),
        alias: result.user_id === actor.id ? "You" : result.alias ?? `Participant ${index + 1}`,
        score: result.score,
        passed: result.passed,
      })),
    };
  } finally {
    client.release();
  }
}

export async function joinBattle(input: { actorUserId: string; battleId: string; now?: Date }) {
  const now = cleanDate(input.now, new Date());
  const client = await pool.connect();
  try {
    await client.query("begin");
    const actor = await activeActor(client, input.actorUserId);
    if (actor.role !== "learner") throw new BattleError("NOT_FOUND");
    const battle = await loadAccessibleBattle(client, actor, input.battleId, true);
    if (battle.scope === "invite" && !battle.participant) throw new BattleError("NOT_FOUND");
    if (battle.status !== "active" || now >= battle.ends_at) throw new BattleError("NOT_OPEN");
    await client.query(
      `insert into coding_battle_participant (battle_id,user_id,role,joined_at)
       values ($1,$2,'joined',$3) on conflict (battle_id,user_id) do nothing`,
      [battle.id, actor.id, now],
    );
    await client.query("commit");
    return { joined: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function submitBattle(input: {
  actorUserId: string; battleId: string; requestId: string;
  answer?: JsonRecord; attemptId?: string | null; now?: Date;
}) {
  if (!UUID.test(input.requestId)) throw new BattleError("INVALID_INPUT");
  const now = cleanDate(input.now, new Date());
  const answerInput: JsonRecord = input.attemptId ? { attemptId: input.attemptId } : input.answer ?? {};
  const encoded = JSON.stringify(answerInput);
  if (Buffer.byteLength(encoded, "utf8") > MAX_ANSWER_BYTES) throw new BattleError("INVALID_INPUT");
  const inputHash = hashCurriculumValue({ version: 1, battleId: input.battleId, answer: answerInput });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const actor = await activeActor(client, input.actorUserId);
    if (actor.role !== "learner") throw new BattleError("NOT_FOUND");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`battle-submit:${actor.id}:${input.battleId}`]);
    const replay = (await client.query<{ battle_id: string; input_hash: string; score: number; passed: boolean }>(
      `select battle_id,input_hash,score,passed from coding_battle_submission where user_id=$1 and request_id=$2`,
      [actor.id, input.requestId],
    )).rows[0];
    if (replay) {
      if (replay.battle_id !== input.battleId || replay.input_hash !== inputHash) throw new BattleError("IDEMPOTENCY_CONFLICT");
      await client.query("commit");
      return { replayed: true, accepted: true };
    }
    const battle = await loadAccessibleBattle(client, actor, input.battleId, true);
    if (!battle.participant) throw new BattleError("NOT_PARTICIPANT");
    if (battle.submitted) throw new BattleError("ALREADY_SUBMITTED");
    if (battle.status !== "active" || now < battle.starts_at || now >= battle.ends_at) throw new BattleError("NOT_OPEN");
    const snapshot = battle.immutable_snapshot;
    const specification = record(snapshot.specification);
    if (!specification) throw new BattleError("INTEGRITY_FAILURE");
    let score: number;
    let passed: boolean;
    let sourceAttemptId: string | null = null;
    let resultEvidence: JsonRecord;
    if (battle.challenge_kind === "authored_answer") {
      if (input.attemptId || !input.answer) throw new BattleError("INVALID_INPUT");
      const evaluation = evaluateAuthoredActivity({ specification }, input.answer);
      if (evaluation.state !== "graded") throw new BattleError("INTEGRITY_FAILURE");
      score = Math.round(evaluation.score * battle.max_points);
      passed = evaluation.passed;
      resultEvidence = {
        origin: evaluation.origin,
        scoreFraction: evaluation.score,
        gradingSnapshotHash: battle.snapshot_hash,
        assistance: "none",
        aiAnswerUsed: false,
      };
    } else {
      if (!input.attemptId || !UUID.test(input.attemptId) || input.answer) throw new BattleError("INVALID_INPUT");
      const attempt = (await client.query<{
        id: string; score: number; passed: boolean; graded_at: Date;
      }>(
        `select id,score,passed,graded_at from attempt
          where id=$1 and user_id=$2 and activity_id=$3 and status='graded'
            and infrastructure_failure=false and assistance_level='A0' and solution_revealed=false
            and score is not null and passed is not null
            and started_at >= $4 and submitted_at <= $5 and graded_at is not null`,
        [input.attemptId, actor.id, battle.activity_id, battle.starts_at, battle.ends_at],
      )).rows[0];
      if (!attempt) throw new BattleError("ATTEMPT_NOT_ELIGIBLE");
      score = Math.round(Math.min(1, Math.max(0, attempt.score)) * battle.max_points);
      passed = attempt.passed;
      sourceAttemptId = attempt.id;
      resultEvidence = {
        origin: "verified_attempt",
        attemptId: attempt.id,
        gradedAt: attempt.graded_at.toISOString(),
        scoreFraction: attempt.score,
        gradingSnapshotHash: battle.snapshot_hash,
        assistance: "A0",
        aiAnswerUsed: false,
      };
    }
    await client.query(
      `insert into coding_battle_submission
        (battle_id,user_id,request_id,input_hash,answer,answer_hash,source_attempt_id,score,passed,result_evidence,submitted_at,created_at)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$11)`,
      [battle.id, actor.id, input.requestId, inputHash, encoded, hashCurriculumValue(answerInput),
        sourceAttemptId, score, passed, JSON.stringify(resultEvidence), now],
    );
    await client.query("commit");
    // Scores intentionally remain undisclosed until getBattle observes reveal_at.
    return { replayed: false, accepted: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if ((error as { code?: string; constraint?: string }).code === "23505"
      && (error as { constraint?: string }).constraint === "coding_battle_submission_participant_unique") {
      throw new BattleError("ALREADY_SUBMITTED");
    }
    throw error;
  } finally {
    client.release();
  }
}

export const battleFairnessPolicy = Object.freeze({
  scoringVersion: SCORING_VERSION,
  source: "current human-reviewed curriculum activity frozen at creation",
  scoresAcceptedFromClient: false,
  aiAnswers: false,
  synchronousMultiplayer: false,
  tieRule: "equal scores share rank; stable public-id order is display-only",
});
