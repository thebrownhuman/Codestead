import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { progressFromMasteryBundle } from "@/lib/learning-service/evidence-engine";
import { deterministicUuid } from "@/lib/learning-service/ids";
import {
  toLearnerAttemptCreationPayload,
  toLearnerPracticeActivity,
  type LearnerAttemptCreationPayload,
} from "@/lib/learning-service/learner-activity";
import type {
  ActivityContext,
  AttemptCreationResult,
  StoredEvidence,
  StoredMastery,
  SupportedAttemptKind,
} from "@/lib/learning-service/types";
import { LearningServiceError } from "@/lib/learning-service/types";
import { isReviewedAuthoredActivity } from "@/lib/learning-service/publication-binding";
import { learningService } from "@/lib/learning-service/runtime";
import { pool as defaultPool } from "@/lib/db/client";

import { selectDailyReviewCandidates } from "./selector";
import {
  DAILY_REVIEW_SIZE,
  type DailyReviewCandidate,
  type DailyReviewItemPayload,
  type DailyReviewPayload,
  type DailyReviewPriorityReason,
  type DailyReviewSessionPayload,
} from "./types";

type JsonRecord = Readonly<Record<string, unknown>>;

interface CandidateRow {
  activity_id: string;
  activity_slug: string;
  activity_type: string;
  specification: JsonRecord;
  assessment_bank: JsonRecord;
  skill_id: string;
  skill_title: string;
  concept_id: string;
  enrollment_id: string;
  course_version: string;
  course_slug: string;
  course_title: string;
  implementation_language: string | null;
  language_context: string;
  mastery_user_id: string | null;
  mastery_score: number | null;
  mastery_confidence: number | null;
  mastery_status: string | null;
  critical_requirements_met: boolean | null;
  last_evidence_at: Date | null;
  last_practiced_at: Date | null;
  next_review_at: Date | null;
  mastery_row_version: string | number | null;
  overdue_at: Date | null;
}

interface EvidenceRow {
  id: string;
  skill_id: string;
  enrollment_id: string;
  concept_id: string;
  language_context: string;
  source_type: string;
  source_id: string;
  evidence_type: string;
  score: number;
  weight: number;
  critical_criterion: string | null;
  validity: string;
  recorded_by: string | null;
  recorded_at: Date;
}

interface SessionRow {
  id: string;
  local_date: string;
  timezone: string;
  status: "ready" | "completed" | "unavailable";
  available_item_count: number;
  question_count: 0 | 5;
  completed_count: number;
}

interface SessionItemRow {
  item_id: string;
  position: number;
  skill_id: string;
  skill_title: string;
  course_slug: string;
  course_title: string;
  priority_reason: DailyReviewPriorityReason;
  confidence: number;
  item_status: "pending" | "answered";
  item_score: number | null;
  item_passed: boolean | null;
  attempt_id: string | null;
  attempt_kind: SupportedAttemptKind | null;
  attempt_number: number | null;
  attempt_status: string | null;
  policy_version: string | null;
  content_version: string | null;
  attempt_score: number | null;
  attempt_passed: boolean | null;
  mastery_awarded: boolean | null;
  infrastructure_failure: boolean | null;
  assistance_level: "A0" | "A1" | "A2" | "A3" | "A4" | null;
  solution_revealed: boolean | null;
  help_step: number | null;
  started_at: Date | null;
  submitted_at: Date | null;
  graded_at: Date | null;
  activity_id: string | null;
  activity_slug: string | null;
  activity_type: string | null;
  specification: JsonRecord | null;
  concept_id: string;
  enrollment_id: string;
  course_version: string | null;
  implementation_language: string | null;
}

interface AttemptStarter {
  createAttempt(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly skillId: string;
    readonly kind: SupportedAttemptKind;
  }): Promise<AttemptCreationResult>;
}

interface EligibleCandidatePool {
  readonly candidates: readonly DailyReviewCandidate[];
  readonly rowsBySkill: ReadonlyMap<string, readonly CandidateRow[]>;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeTimezone(value: unknown): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return "UTC";
  }
}

export function learnerLocalDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function evidenceKey(enrollmentId: string, conceptId: string, languageContext: string): string {
  return `${enrollmentId}\u0000${conceptId}\u0000${languageContext}`;
}

function contextFromCandidate(row: CandidateRow): ActivityContext {
  return {
    activityId: row.activity_id,
    activitySlug: row.activity_slug,
    activityType: row.activity_type,
    specification: row.specification,
    skillId: row.skill_id,
    conceptId: row.concept_id,
    enrollmentId: row.enrollment_id,
    courseVersion: row.course_version,
    trackId: row.course_slug,
    implementationLanguage: row.implementation_language,
    languageContext: row.language_context,
  };
}

function storedMastery(row: CandidateRow): StoredMastery | null {
  if (!row.mastery_user_id) return null;
  return {
    userId: row.mastery_user_id,
    enrollmentId: row.enrollment_id,
    conceptId: row.concept_id,
    skillId: row.skill_id,
    languageContext: row.language_context,
    score: finiteNumber(row.mastery_score),
    confidence: finiteNumber(row.mastery_confidence),
    status: row.mastery_status ?? "unseen",
    criticalRequirementsMet: Boolean(row.critical_requirements_met),
    lastEvidenceAt: row.last_evidence_at,
    lastPracticedAt: row.last_practiced_at,
    nextReviewAt: row.next_review_at,
    rowVersion: finiteNumber(row.mastery_row_version, 1),
  };
}

function storedEvidence(row: EvidenceRow): StoredEvidence {
  return {
    id: row.id,
    skillId: row.skill_id,
    enrollmentId: row.enrollment_id,
    conceptId: row.concept_id,
    languageContext: row.language_context,
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidenceType: row.evidence_type,
    score: finiteNumber(row.score),
    weight: finiteNumber(row.weight),
    criticalCriterion: row.critical_criterion,
    validity: row.validity,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

async function learnerDay(client: PoolClient, userId: string, now: Date): Promise<{ timezone: string; localDate: string }> {
  const result = await client.query<{ timezone: string }>(
    `select timezone from "user" where id = $1 and status = 'active' limit 1`,
    [userId],
  );
  if (!result.rows[0]) throw new LearningServiceError("LEARNER_NOT_FOUND", "Active learner account was not found.", 404);
  const timezone = safeTimezone(result.rows[0].timezone);
  return { timezone, localDate: learnerLocalDate(now, timezone) };
}

async function candidateRows(client: PoolClient, userId: string, now: Date): Promise<readonly CandidateRow[]> {
  const result = await client.query<CandidateRow>(
    `select a.id as activity_id,
            a.slug as activity_slug,
            a.type as activity_type,
            a.specification,
            artifact.content as assessment_bank,
            c.slug as skill_id,
            c.title as skill_title,
            c.id as concept_id,
            e.id as enrollment_id,
            cv.version as course_version,
            course.slug as course_slug,
            course.title as course_title,
            e.implementation_language,
            case when course.slug = 'dsa'
              then 'dsa:' || lower(coalesce(e.implementation_language, 'unselected'))
              else 'conceptual'
            end as language_context,
            cm.user_id as mastery_user_id,
            cm.score as mastery_score,
            cm.confidence as mastery_confidence,
            cm.status as mastery_status,
            cm.critical_requirements_met,
            cm.last_evidence_at,
            cm.last_practiced_at,
            cm.next_review_at,
            cm.row_version as mastery_row_version,
            due.due_at as overdue_at
       from activity a
       join concept c on c.id = a.concept_id
       join lesson l on l.id = a.lesson_id
       join course_module module on module.id = l.module_id
       join course_version cv on cv.id = module.course_version_id
       join course on course.id = cv.course_id
       join curriculum_publication_pointer pointer
         on pointer.course_id = course.id and pointer.current_course_version_id = cv.id
       join enrollment e
         on e.course_version_id = cv.id and e.user_id = $1 and e.status in ('planned', 'active')
       join curriculum_artifact artifact
         on artifact.course_version_id = cv.id
        and artifact.artifact_type = 'assessment_bank'
        and artifact.skill_key = c.slug
        and artifact.review_status = 'approved'
        and artifact.publication_stage in ('approved', 'published')
       left join concept_mastery cm
         on cm.user_id = $1
        and cm.enrollment_id = e.id
        and cm.concept_id = c.id
        and cm.language_context = case when course.slug = 'dsa'
          then 'dsa:' || lower(coalesce(e.implementation_language, 'unselected'))
          else 'conceptual'
        end
       left join lateral (
         select min(schedule.due_at) as due_at
           from review_schedule schedule
          where schedule.user_id = $1
            and schedule.enrollment_id = e.id
            and schedule.concept_id = c.id
            and schedule.status = 'scheduled'
            and schedule.due_at <= $2
       ) due on true
      where cv.stage in ('beta', 'verified')
        and l.content_status in ('beta', 'verified')
        and nullif(a.specification->>'authoredItemId', '') is not null
        and exists (
          select 1
            from curriculum_review_event review_event
           where review_event.artifact_id = artifact.id
             and review_event.reviewer_kind = 'human'
             and review_event.decision = 'approved'
             and review_event.content_hash = artifact.content_hash
             and review_event.reviewed_item_ids ? (a.specification->>'authoredItemId')
        )
        and (
          cm.user_id is not null
          or due.due_at is not null
          or exists (
            select 1 from mastery_evidence prior
             where prior.user_id = $1
               and prior.enrollment_id = e.id
               and prior.concept_id = c.id
               and prior.validity = 'valid'
          )
        )
      order by c.slug asc, e.updated_at desc, e.id asc, a.created_at asc`,
    [userId, now],
  );
  return result.rows;
}

async function recentEvidence(client: PoolClient, userId: string): Promise<readonly EvidenceRow[]> {
  const result = await client.query<EvidenceRow>(
    `select id, skill_id, enrollment_id, concept_id, language_context,
            source_type, source_id, evidence_type, score, weight,
            critical_criterion, validity, recorded_by, recorded_at
       from (
         select evidence.id,
                c.slug as skill_id,
                evidence.enrollment_id,
                evidence.concept_id,
                evidence.language_context,
                evidence.source_type,
                evidence.source_id,
                evidence.evidence_type,
                evidence.score,
                evidence.weight,
                evidence.critical_criterion,
                evidence.validity,
                evidence.recorded_by,
                evidence.recorded_at,
                row_number() over (
                  partition by evidence.enrollment_id, evidence.concept_id, evidence.language_context
                  order by evidence.recorded_at desc, evidence.id desc
                ) as evidence_rank
           from mastery_evidence evidence
           join concept c on c.id = evidence.concept_id
          where evidence.user_id = $1 and evidence.validity = 'valid'
       ) recent
      where evidence_rank <= 100
      order by recorded_at asc, id asc`,
    [userId],
  );
  return result.rows;
}

async function eligibleCandidates(client: PoolClient, userId: string, now: Date): Promise<EligibleCandidatePool> {
  const [rows, evidenceRows] = await Promise.all([
    candidateRows(client, userId, now),
    recentEvidence(client, userId),
  ]);
  const evidenceByScope = new Map<string, StoredEvidence[]>();
  for (const evidenceRow of evidenceRows) {
    const key = evidenceKey(evidenceRow.enrollment_id, evidenceRow.concept_id, evidenceRow.language_context);
    const values = evidenceByScope.get(key) ?? [];
    values.push(storedEvidence(evidenceRow));
    evidenceByScope.set(key, values);
  }

  const rowsBySkill = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    if (!isReviewedAuthoredActivity(row.specification, row.assessment_bank)) continue;
    const activity = contextFromCandidate(row);
    if (!toLearnerPracticeActivity(activity)) continue;
    const skillRows = rowsBySkill.get(row.skill_id) ?? [];
    skillRows.push(row);
    rowsBySkill.set(row.skill_id, skillRows);
  }

  const candidates: DailyReviewCandidate[] = [];
  for (const [skillId, skillRows] of rowsBySkill) {
    const row = skillRows[0];
    if (!row) continue;
    const mastery = storedMastery(row);
    const evidence = evidenceByScope.get(evidenceKey(row.enrollment_id, row.concept_id, row.language_context)) ?? [];
    const progress = progressFromMasteryBundle(skillId, { mastery, evidence, activeReview: null });
    const overdueAt = row.overdue_at
      ?? (mastery?.nextReviewAt && mastery.nextReviewAt.getTime() <= now.getTime() ? mastery.nextReviewAt : null)
      ?? (mastery?.status === "needs_review" ? mastery.lastEvidenceAt ?? now : null);
    candidates.push({
      skillId,
      skillTitle: row.skill_title,
      courseSlug: row.course_slug,
      courseTitle: row.course_title,
      conceptId: row.concept_id,
      enrollmentId: row.enrollment_id,
      confidence: mastery?.confidence ?? 0,
      hasConfirmedMisconception: progress.activeMisconceptions.some((item) => item.blocking),
      overdueAt,
    });
  }
  return { candidates, rowsBySkill };
}

function reservedActivityRow(
  rows: readonly CandidateRow[],
  enrollmentId: string,
  idempotencyKey: string,
): CandidateRow | null {
  const enrollmentRows = rows.filter((row) => row.enrollment_id === enrollmentId);
  const quizRows = enrollmentRows.filter((row) =>
    row.activity_type.toLocaleLowerCase("en-US").includes("quiz") || enrollmentRows.length === 1
  );
  const candidates = quizRows.length ? quizRows : enrollmentRows;
  if (!candidates.length) return null;
  const selector = Number.parseInt(
    deterministicUuid("activity-variant", idempotencyKey).replaceAll("-", "").slice(0, 8),
    16,
  );
  return candidates[selector % candidates.length] ?? null;
}

async function synchronizeSession(client: PoolClient, userId: string, sessionId: string, now: Date): Promise<void> {
  await client.query(
    `update daily_review_item item
        set status = 'answered',
            score = attempt.score,
            passed = attempt.passed,
            answered_at = coalesce(attempt.graded_at, $3),
            updated_at = $3
       from attempt
      where item.session_id = $1
        and item.user_id = $2
        and attempt.id = item.attempt_id
        and attempt.user_id = $2
        and attempt.status = 'graded'
        and attempt.score is not null
        and attempt.passed is not null
        and item.status = 'pending'`,
    [sessionId, userId, now],
  );
  await client.query(
    `with completed as (
       select count(*)::integer as count
         from daily_review_item
        where session_id = $1 and user_id = $2 and status = 'answered'
     )
     update daily_review_session session
        set completed_count = completed.count,
            status = case when completed.count = 5 then 'completed' else 'ready' end,
            completed_at = case when completed.count = 5 then coalesce(session.completed_at, $3) else null end,
            row_version = case when session.completed_count <> completed.count then session.row_version + 1 else session.row_version end,
            updated_at = case when session.completed_count <> completed.count then $3 else session.updated_at end
       from completed
      where session.id = $1 and session.user_id = $2 and session.status <> 'unavailable'`,
    [sessionId, userId, now],
  );
}

function attemptPayload(row: SessionItemRow, courseSlug: string): LearnerAttemptCreationPayload | null {
  if (
    !row.attempt_id
    || !row.attempt_kind
    || !row.attempt_number
    || !row.attempt_status
    || !row.policy_version
    || !row.content_version
    || !row.activity_id
    || !row.activity_slug
    || !row.activity_type
    || !row.specification
    || !row.course_version
  ) return null;
  return toLearnerAttemptCreationPayload({
    state: "ready",
    idempotent: true,
    attempt: {
      id: row.attempt_id,
      userId: "redacted-owner",
      activityId: row.activity_id,
      enrollmentId: row.enrollment_id,
      kind: row.attempt_kind,
      attemptNumber: row.attempt_number,
      status: row.attempt_status,
      policyVersion: row.policy_version,
      contentVersion: row.content_version,
      score: row.attempt_score,
      passed: row.attempt_passed,
      masteryAwarded: Boolean(row.mastery_awarded),
      infrastructureFailure: Boolean(row.infrastructure_failure),
      assistanceLevel: row.assistance_level ?? "A0",
      solutionRevealed: Boolean(row.solution_revealed),
      helpStep: row.help_step ?? 0,
      startedAt: row.started_at,
      submittedAt: row.submitted_at,
      gradedAt: row.graded_at,
    },
    activity: {
      activityId: row.activity_id,
      activitySlug: row.activity_slug,
      activityType: row.activity_type,
      specification: row.specification,
      skillId: row.skill_id,
      conceptId: row.concept_id,
      enrollmentId: row.enrollment_id,
      courseVersion: row.course_version,
      trackId: courseSlug,
      implementationLanguage: row.implementation_language,
      languageContext: courseSlug === "dsa"
        ? `dsa:${(row.implementation_language ?? "unselected").toLocaleLowerCase("en-US")}`
        : "conceptual",
    },
  });
}

async function loadSession(
  client: PoolClient,
  userId: string,
  localDate: string,
  now: Date,
): Promise<DailyReviewSessionPayload | null> {
  const sessionResult = await client.query<SessionRow>(
    `select id, local_date, timezone, status, available_item_count, question_count, completed_count
       from daily_review_session where user_id = $1 and local_date = $2 limit 1`,
    [userId, localDate],
  );
  const initial = sessionResult.rows[0];
  if (!initial) return null;
  await synchronizeSession(client, userId, initial.id, now);
  const refreshed = await client.query<SessionRow>(
    `select id, local_date, timezone, status, available_item_count, question_count, completed_count
       from daily_review_session where id = $1 and user_id = $2 limit 1`,
    [initial.id, userId],
  );
  const session = refreshed.rows[0];
  if (!session) return null;
  const rows = await client.query<SessionItemRow>(
    `select item.id as item_id,
            item.position,
            item.skill_id,
            item.skill_title,
            item.course_slug,
            item.course_title,
            item.priority_reason,
            item.confidence,
            item.status as item_status,
            item.score as item_score,
            item.passed as item_passed,
            attempt.id as attempt_id,
            attempt.kind as attempt_kind,
            attempt.attempt_number,
            attempt.status as attempt_status,
            attempt.policy_version,
            attempt.content_version,
            attempt.score as attempt_score,
            attempt.passed as attempt_passed,
            attempt.mastery_awarded,
            attempt.infrastructure_failure,
            attempt.assistance_level,
            attempt.solution_revealed,
            attempt.help_step,
            attempt.started_at,
            attempt.submitted_at,
            attempt.graded_at,
            activity.id as activity_id,
            activity.slug as activity_slug,
            activity.type as activity_type,
            activity.specification,
            item.concept_id,
            item.enrollment_id,
            cv.version as course_version,
            enrollment.implementation_language
       from daily_review_item item
       left join attempt on attempt.id = item.attempt_id and attempt.user_id = item.user_id
       left join activity on activity.id = item.activity_id and activity.id = attempt.activity_id
       left join enrollment on enrollment.id = item.enrollment_id and enrollment.user_id = item.user_id
       left join course_version cv on cv.id = enrollment.course_version_id
      where item.session_id = $1 and item.user_id = $2
      order by item.position asc`,
    [session.id, userId],
  );
  const items: DailyReviewItemPayload[] = rows.rows.map((row) => ({
    id: row.item_id,
    position: row.position,
    skillId: row.skill_id,
    skillTitle: row.skill_title,
    courseTitle: row.course_title,
    priorityReason: row.priority_reason,
    confidencePercent: Math.round(Math.min(1, Math.max(0, finiteNumber(row.confidence))) * 100),
    status: row.item_status,
    score: row.item_score,
    passed: row.item_passed,
    href: `/courses/${encodeURIComponent(row.course_slug)}/skills/${encodeURIComponent(row.skill_id)}`,
    attempt: attemptPayload(row, row.course_slug),
  }));
  return {
    id: session.id,
    localDate: session.local_date,
    timezone: session.timezone,
    status: session.status,
    availableItemCount: session.available_item_count,
    questionCount: session.question_count,
    completedCount: session.completed_count,
    items,
  };
}

export class DailyReviewService {
  constructor(
    private readonly databasePool: Pool = defaultPool,
    private readonly attempts: AttemptStarter = learningService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(userId: string): Promise<DailyReviewPayload> {
    const client = await this.databasePool.connect();
    const now = this.now();
    try {
      await client.query("begin");
      const day = await learnerDay(client, userId, now);
      const session = await loadSession(client, userId, day.localDate, now);
      await client.query("commit");
      if (!session) return { state: "not_started", ...day, session: null };
      return { state: session.status, ...day, session };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async initialize(userId: string): Promise<DailyReviewPayload> {
    const client = await this.databasePool.connect();
    const now = this.now();
    try {
      await client.query("begin");
      const day = await learnerDay(client, userId, now);
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`daily-review:${userId}:${day.localDate}`]);
      const existing = await loadSession(client, userId, day.localDate, now);
      if (existing && existing.status !== "unavailable") {
        await client.query("commit");
        return { state: existing.status, ...day, session: existing };
      }
      const pool = await eligibleCandidates(client, userId, now);
      const uniqueCandidateCount = new Set(pool.candidates.map((candidate) => candidate.skillId)).size;
      const selected = selectDailyReviewCandidates(pool.candidates, DAILY_REVIEW_SIZE);
      // A zero-question unavailable session is a truthful snapshot, not a
      // permanent decision. Re-evaluate it under the same per-day lock so a
      // learner who gains a fifth reviewed activity later today can unlock the
      // fixed set without creating a second daily session.
      const sessionId = existing?.id ?? randomUUID();
      const ready = selected.length === DAILY_REVIEW_SIZE;
      const allocations = ready ? selected.map((candidate) => {
        const itemId = randomUUID();
        const key = `daily:${sessionId}:${itemId}`;
        const reserved = reservedActivityRow(pool.rowsBySkill.get(candidate.skillId) ?? [], candidate.enrollmentId, key);
        if (!reserved) {
          throw new LearningServiceError("DAILY_REVIEW_RESERVATION_FAILED", "A reviewed daily question could not be reserved.", 503);
        }
        return { candidate, itemId, reserved };
      }) : [];
      if (existing) {
        await client.query(
          `update daily_review_session
              set timezone = $3,
                  status = $4,
                  available_item_count = $5,
                  question_count = $6,
                  completed_count = 0,
                  completed_at = null,
                  row_version = row_version + 1,
                  updated_at = $7
            where id = $1 and user_id = $2 and status = 'unavailable'`,
          [sessionId, userId, day.timezone, ready ? "ready" : "unavailable", uniqueCandidateCount, ready ? 5 : 0, now],
        );
      } else {
        await client.query(
          `insert into daily_review_session
            (id, user_id, local_date, timezone, status, available_item_count, question_count, completed_count, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8)`,
          [sessionId, userId, day.localDate, day.timezone, ready ? "ready" : "unavailable", uniqueCandidateCount, ready ? 5 : 0, now],
        );
      }
      if (ready) {
        for (const [index, allocation] of allocations.entries()) {
          const { candidate, itemId, reserved } = allocation;
          await client.query(
            `insert into daily_review_item
              (id, session_id, user_id, position, skill_id, skill_title, course_slug, course_title,
               concept_id, enrollment_id, priority_reason, confidence, status, activity_id, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14, $14)`,
            [
              itemId, sessionId, userId, index + 1, candidate.skillId, reserved.skill_title,
              reserved.course_slug, reserved.course_title, reserved.concept_id, reserved.enrollment_id,
              candidate.priorityReason, candidate.confidence, reserved.activity_id, now,
            ],
          );
        }
      }
      const session = await loadSession(client, userId, day.localDate, now);
      await client.query("commit");
      if (!session) throw new LearningServiceError("DAILY_REVIEW_NOT_CREATED", "Daily review could not be created.", 503);
      return { state: session.status, ...day, session };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async startItem(userId: string, sessionId: string, itemId: string): Promise<LearnerAttemptCreationPayload> {
    const client = await this.databasePool.connect();
    const now = this.now();
    let skillId: string;
    let reservedActivityId: string;
    try {
      const day = await learnerDay(client, userId, now);
      const result = await client.query<{
        skill_id: string;
        item_status: string;
        session_status: string;
        local_date: string;
        activity_id: string;
      }>(
        `select item.skill_id, item.status as item_status, session.status as session_status, session.local_date, item.activity_id
           from daily_review_item item
           join daily_review_session session on session.id = item.session_id and session.user_id = item.user_id
          where item.id = $1 and item.session_id = $2 and item.user_id = $3
          limit 1`,
        [itemId, sessionId, userId],
      );
      const item = result.rows[0];
      if (!item) throw new LearningServiceError("DAILY_REVIEW_ITEM_NOT_FOUND", "Daily review item was not found.", 404);
      if (item.local_date !== day.localDate) {
        throw new LearningServiceError("DAILY_REVIEW_DAY_ENDED", "This daily review belongs to an earlier learner-local day.", 409);
      }
      if (item.item_status !== "pending") {
        throw new LearningServiceError("DAILY_REVIEW_ITEM_COMPLETE", "This daily review item is already complete.", 409);
      }
      if (item.session_status !== "ready") {
        throw new LearningServiceError("DAILY_REVIEW_NOT_OPEN", "This daily review session is not open.", 409);
      }
      skillId = item.skill_id;
      reservedActivityId = item.activity_id;
    } finally {
      client.release();
    }

    const internal = await this.attempts.createAttempt({
      userId,
      idempotencyKey: `daily:${sessionId}:${itemId}`,
      skillId,
      kind: "quiz",
    });
    const payload = toLearnerAttemptCreationPayload(internal);
    if (payload.state !== "ready" || !payload.attempt || !payload.activity || !internal.attempt || !internal.activity) {
      return payload;
    }
    if (payload.activity.skillId !== skillId) {
      throw new LearningServiceError("DAILY_REVIEW_SKILL_MISMATCH", "Resolved attempt did not match the reserved review skill.", 409);
    }
    if (internal.activity.activityId !== reservedActivityId) {
      throw new LearningServiceError("DAILY_REVIEW_ACTIVITY_MISMATCH", "The reserved reviewed question is no longer the active published variant.", 409);
    }

    const bindingClient = await this.databasePool.connect();
    try {
      const result = await bindingClient.query(
        `update daily_review_item
            set attempt_id = $1, updated_at = $6
          where id = $3 and session_id = $4 and user_id = $5
            and status = 'pending'
            and (attempt_id is null or attempt_id = $1)
            and activity_id = $2`,
        [internal.attempt.id, internal.activity.activityId, itemId, sessionId, userId, now],
      );
      if (result.rowCount !== 1) {
        throw new LearningServiceError("DAILY_REVIEW_BINDING_CONFLICT", "Daily review question changed in another request.", 409);
      }
    } finally {
      bindingClient.release();
    }
    return payload;
  }
}
