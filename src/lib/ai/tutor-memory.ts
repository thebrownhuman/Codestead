import { pool } from "@/lib/db/client";
import {
  MENTOR_POLICY_LIMITS,
  recommendDailyMentorChallenge,
  type MentorAttemptSignal,
  type MentorMasterySignal,
  type MentorRecommendation,
} from "@/lib/ai/mentor-policy";
import { progressFromMasteryBundle } from "@/lib/learning-service/evidence-engine";
import type { StoredEvidence, StoredMastery } from "@/lib/learning-service/types";
import { redactSensitiveText } from "@/lib/security/sensitive-text";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TAG = /^[a-z][a-z0-9_.-]{1,63}$/;

export const TUTOR_MEMORY_LIMITS = Object.freeze({
  evidenceRows: 40,
  misconceptionTags: 8,
  goals: 8,
  goalChars: 240,
  selectedTracks: 12,
  summaryChars: 2_000,
  threadMessages: 6,
  threadMessageChars: 1_200,
  threadTotalChars: 4_800,
} as const);

export function sanitizeTutorMemoryText(value: string, maximum: number) {
  return redactSensitiveText(value, maximum);
}

export function sanitizeTutorMemoryList(value: unknown, limit: number, maximumChars: number) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, limit)
    .map((entry) => sanitizeTutorMemoryText(entry, maximumChars).text);
}

type MasteryRow = {
  concept_id: string;
  slug: string;
  user_id: string | null;
  enrollment_id: string | null;
  language_context: string | null;
  score: number | null;
  confidence: number | null;
  status: string | null;
  critical_requirements_met: boolean | null;
  last_evidence_at: Date | null;
  last_practiced_at: Date | null;
  next_review_at: Date | null;
  row_version: string | number | null;
};

type EvidenceRow = {
  id: string;
  evidence_type: string;
  source_type: string;
  source_id: string;
  score: number;
  weight: number;
  critical_criterion: string | null;
  validity: string;
  policy_version: string;
  recorded_by: string | null;
  recorded_at: Date;
};

type SummaryRow = { summary: string | null; created_at: Date };
type TailRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  content_length: number;
  created_at: Date;
};
type MentorMasteryRow = MasteryRow & { title: string };
type MentorEvidenceRow = EvidenceRow & {
  concept_id: string;
  enrollment_id: string;
  language_context: string;
};
type MentorAttemptRow = {
  user_id: string;
  skill_id: string;
  occurred_at: Date;
  score: number | null;
  passed: boolean | null;
  assistance_level: string;
  solution_revealed: boolean;
  source_type: string;
  validity: string;
};
type MentorPlanRow = { id: string; user_id: string; plan: unknown };

export type TutorStructuredMemory = Readonly<{
  currentConcept: {
    slug: string;
    mastery: number;
    confidence: number;
    status: string;
    languageContext: string;
    criticalRequirementsMet: boolean;
    lastEvidenceAt: string | null;
    persisted: boolean;
  };
  activeMisconceptionTags: readonly string[];
  evidenceRowsConsidered: number;
  evidenceRowsCapped: boolean;
  recentRelevantSummary: null | {
    text: string;
    createdAt: string;
    source: "email_outbox.weekly-summary";
    truncated: boolean;
  };
  selectedThreadTail: null | {
    threadId: string;
    messages: readonly {
      id: string;
      role: "user" | "assistant";
      content: string;
      createdAt: string;
      truncated: boolean;
    }[];
    source: "chat_thread+chat_message.owner-active-tail";
    truncated: boolean;
  };
}>;

function boundedProbability(value: number | null) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : 0;
}

function storedMastery(row: MasteryRow): StoredMastery | null {
  if (!row.user_id || !row.enrollment_id || !row.language_context) return null;
  return {
    userId: row.user_id,
    enrollmentId: row.enrollment_id,
    conceptId: row.concept_id,
    skillId: row.slug,
    languageContext: row.language_context,
    score: boundedProbability(row.score),
    confidence: boundedProbability(row.confidence),
    status: row.status ?? "unseen",
    criticalRequirementsMet: Boolean(row.critical_requirements_met),
    lastEvidenceAt: row.last_evidence_at,
    lastPracticedAt: row.last_practiced_at,
    nextReviewAt: row.next_review_at,
    rowVersion: Number(row.row_version ?? 1),
  };
}

function storedEvidence(row: EvidenceRow, mastery: StoredMastery): StoredEvidence {
  return {
    id: row.id,
    skillId: mastery.skillId,
    enrollmentId: mastery.enrollmentId,
    conceptId: mastery.conceptId,
    languageContext: mastery.languageContext,
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidenceType: row.evidence_type,
    score: row.score,
    weight: row.weight,
    criticalCriterion: row.critical_criterion,
    validity: row.validity,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

function projectTail(threadId: string, rows: readonly TailRow[]) {
  const hasExtraRow = rows.length > TUTOR_MEMORY_LIMITS.threadMessages;
  const selected = rows.slice(0, TUTOR_MEMORY_LIMITS.threadMessages);
  let remaining = TUTOR_MEMORY_LIMITS.threadTotalChars;
  let truncated = hasExtraRow;
  const newestFirst = [] as Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    truncated: boolean;
  }>;
  for (const row of selected) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const maximum = Math.min(TUTOR_MEMORY_LIMITS.threadMessageChars, remaining);
    const safe = sanitizeTutorMemoryText(row.content, maximum);
    const rowTruncated = safe.truncated || row.content_length > maximum;
    truncated ||= rowTruncated;
    newestFirst.push({
      id: row.id,
      role: row.role,
      content: safe.text,
      createdAt: row.created_at.toISOString(),
      truncated: rowTruncated,
    });
    remaining -= Math.min(safe.text.length, maximum);
  }
  return {
    threadId,
    messages: newestFirst.reverse(),
    source: "chat_thread+chat_message.owner-active-tail" as const,
    truncated,
  };
}

export async function loadTutorStructuredMemory(input: {
  readonly userId: string;
  readonly skillId: string;
  readonly preferredLanguage: string;
  readonly selectedThreadId?: string;
}): Promise<TutorStructuredMemory> {
  if (!input.userId || input.userId.length > 200 || input.skillId.length > 180 || input.preferredLanguage.length > 80) {
    throw new Error("Tutor memory request is invalid.");
  }
  if (input.selectedThreadId && !UUID_PATTERN.test(input.selectedThreadId)) {
    throw new Error("Tutor memory thread is invalid.");
  }

  const [masteryResult, summaryResult, tailResult] = await Promise.all([
    pool.query<MasteryRow>(
      `select c.id concept_id,c.slug,
              selected.user_id,selected.enrollment_id,selected.language_context,
              selected.score,selected.confidence,selected.status,
              selected.critical_requirements_met,selected.last_evidence_at,
              selected.last_practiced_at,selected.next_review_at,selected.row_version
         from concept c
         left join lateral (
           select cm.* from concept_mastery cm
            where cm.user_id = $1 and cm.concept_id = c.id
            order by (cm.language_context = $3) desc,
                     cm.last_evidence_at desc nulls last,cm.updated_at desc
            limit 1
         ) selected on true
        where c.slug = $2
        limit 1`,
      [input.userId, input.skillId, input.preferredLanguage],
    ),
    pool.query<SummaryRow>(
      `select variables->>'summary' summary,created_at
         from email_outbox
        where user_id = $1 and template = 'weekly-summary'
          and jsonb_typeof(variables) = 'object'
          and jsonb_typeof(variables->'summary') = 'string'
        order by created_at desc,id desc
        limit 1`,
      [input.userId],
    ),
    input.selectedThreadId
      ? pool.query<TailRow>(
          `select m.id,m.role,left(m.content,$3) content,
                  char_length(m.content)::integer content_length,m.created_at
             from chat_message m
             join chat_thread t on t.id = m.thread_id
            where t.id = $1 and t.user_id = $2 and t.status = 'active'
              and m.role in ('user','assistant')
            order by m.created_at desc,m.id desc
            limit $4`,
          [
            input.selectedThreadId,
            input.userId,
            TUTOR_MEMORY_LIMITS.threadMessageChars + 1,
            TUTOR_MEMORY_LIMITS.threadMessages + 1,
          ],
        )
      : Promise.resolve({ rows: [] as TailRow[] }),
  ]);

  const row = masteryResult.rows[0];
  const mastery = row ? storedMastery(row) : null;
  let evidence: StoredEvidence[] = [];
  let evidenceRowsCapped = false;
  if (mastery) {
    const evidenceResult = await pool.query<EvidenceRow>(
      `select id,evidence_type,source_type,source_id,score,weight,
              critical_criterion,validity,policy_version,recorded_by,recorded_at
         from mastery_evidence
        where user_id = $1 and enrollment_id = $2 and concept_id = $3
          and language_context = $4 and validity = 'valid'
        order by recorded_at desc,id desc
        limit $5`,
      [
        input.userId,
        mastery.enrollmentId,
        mastery.conceptId,
        mastery.languageContext,
        TUTOR_MEMORY_LIMITS.evidenceRows + 1,
      ],
    );
    evidenceRowsCapped = evidenceResult.rows.length > TUTOR_MEMORY_LIMITS.evidenceRows;
    evidence = evidenceResult.rows
      .slice(0, TUTOR_MEMORY_LIMITS.evidenceRows)
      .reverse()
      .map((evidenceRow) => storedEvidence(evidenceRow, mastery));
  }

  const activeMisconceptionTags = mastery
    ? progressFromMasteryBundle(mastery.skillId, { mastery, evidence, activeReview: null })
        .activeMisconceptions
        .map((item) => item.tag)
        .filter((tag) => SAFE_TAG.test(tag))
        .slice(0, TUTOR_MEMORY_LIMITS.misconceptionTags)
    : [];
  const summaryRow = summaryResult.rows[0];
  const summary = summaryRow?.summary
    ? sanitizeTutorMemoryText(summaryRow.summary, TUTOR_MEMORY_LIMITS.summaryChars)
    : null;

  return {
    currentConcept: {
      slug: row?.slug ?? input.skillId,
      mastery: mastery?.score ?? 0,
      confidence: mastery?.confidence ?? 0,
      status: mastery?.status ?? "unseen",
      languageContext: mastery?.languageContext ?? input.preferredLanguage,
      criticalRequirementsMet: mastery?.criticalRequirementsMet ?? false,
      lastEvidenceAt: mastery?.lastEvidenceAt?.toISOString() ?? null,
      persisted: Boolean(mastery),
    },
    activeMisconceptionTags,
    evidenceRowsConsidered: evidence.length,
    evidenceRowsCapped,
    recentRelevantSummary: summary && summaryRow ? {
      text: summary.text,
      createdAt: summaryRow.created_at.toISOString(),
      source: "email_outbox.weekly-summary",
      truncated: summary.truncated,
    } : null,
    selectedThreadTail: input.selectedThreadId && tailResult.rows.length > 0
      ? projectTail(input.selectedThreadId, tailResult.rows)
      : null,
  };
}

function firstPlanSkill(value: unknown) {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.kind !== "diagnostic" && typeof candidate.skillId === "string") return candidate.skillId;
  }
  return null;
}

/**
 * Loads only authenticated-owner, deterministic learning evidence for the
 * pure mentor policy. Provider credentials, chat text, hidden tests, reference
 * answers, and other learners are neither selected nor accepted by the policy.
 */
export async function loadMentorRecommendation(
  userId: string,
  now = new Date(),
): Promise<MentorRecommendation> {
  if (!userId || userId.length > 200) throw new Error("Mentor evidence owner is invalid.");
  const earliest = new Date(now.getTime() - MENTOR_POLICY_LIMITS.lookbackDays * 86_400_000);
  const [masteryResult, evidenceResult, attemptResult, planResult] = await Promise.all([
    pool.query<MentorMasteryRow>(
      `select c.id concept_id,c.slug,c.title,cm.user_id,cm.enrollment_id,
              cm.language_context,cm.score,cm.confidence,cm.status,
              cm.critical_requirements_met,cm.last_evidence_at,
              cm.last_practiced_at,cm.next_review_at,cm.row_version
         from concept_mastery cm
         join concept c on c.id = cm.concept_id
        where cm.user_id = $1
        order by (cm.next_review_at is not null and cm.next_review_at <= $2) desc,
                 cm.confidence asc,cm.last_evidence_at desc nulls last,c.slug asc
        limit $3`,
      [userId, now, MENTOR_POLICY_LIMITS.masteryRows + 1],
    ),
    pool.query<MentorEvidenceRow>(
      `select me.id,me.concept_id,me.enrollment_id,me.language_context,
              me.evidence_type,me.source_type,me.source_id,me.score,me.weight,
              me.critical_criterion,me.validity,me.policy_version,
              me.recorded_by,me.recorded_at
         from mastery_evidence me
        where me.user_id = $1 and me.validity = 'valid'
          and me.source_type in ('deterministic_attempt','verified_runner')
        order by me.recorded_at desc,me.id desc
        limit $2`,
      [userId, MENTOR_POLICY_LIMITS.masteryRows * TUTOR_MEMORY_LIMITS.misconceptionTags + 1],
    ),
    pool.query<MentorAttemptRow>(
      `select a.user_id,c.slug skill_id,coalesce(a.graded_at,a.submitted_at,a.created_at) occurred_at,
              a.score,a.passed,a.assistance_level,a.solution_revealed,
              verified.source_type,verified.validity
         from attempt a
         join activity act on act.id = a.activity_id
         join concept c on c.id = act.concept_id
         join lateral (
           select me.source_type,me.validity
             from mastery_evidence me
            where me.user_id = a.user_id and me.source_id = a.id::text
              and me.validity = 'valid'
              and me.source_type in ('deterministic_attempt','verified_runner')
            order by me.recorded_at desc,me.id desc limit 1
         ) verified on true
        where a.user_id = $1 and a.status = 'graded'
          and a.infrastructure_failure = false
          and coalesce(a.graded_at,a.submitted_at,a.created_at) >= $2
        order by occurred_at desc,a.id desc limit $3`,
      [userId, earliest, MENTOR_POLICY_LIMITS.recentAttempts + 1],
    ),
    pool.query<MentorPlanRow>(
      `select pr.id,e.user_id,pr.plan
         from plan_revision pr
         join enrollment e on e.id = pr.enrollment_id
        where e.user_id = $1
        order by pr.created_at desc,pr.revision desc,pr.id desc limit 1`,
      [userId],
    ),
  ]);

  const evidenceRows = evidenceResult.rows.slice(0, MENTOR_POLICY_LIMITS.masteryRows * TUTOR_MEMORY_LIMITS.misconceptionTags);
  const masterySignals = masteryResult.rows.slice(0, MENTOR_POLICY_LIMITS.masteryRows).flatMap((row): MentorMasterySignal[] => {
    const mastery = storedMastery(row);
    if (!mastery) return [];
    const evidence = evidenceRows
      .filter((item) =>
        item.concept_id === row.concept_id
        && item.enrollment_id === row.enrollment_id
        && item.language_context === row.language_context)
      .reverse()
      .map((item) => storedEvidence(item, mastery));
    if (evidence.length === 0) return [];
    const progress = progressFromMasteryBundle(mastery.skillId, { mastery, evidence, activeReview: null });
    return [{
      ownerUserId: userId,
      skillId: row.slug,
      skillTitle: row.title,
      mastery: mastery.score,
      confidence: mastery.confidence,
      status: mastery.status,
      nextReviewAt: mastery.nextReviewAt?.toISOString() ?? null,
      lastPracticedAt: mastery.lastPracticedAt?.toISOString() ?? null,
      activeMisconceptionTags: progress.activeMisconceptions.map((item) => item.tag),
      verifiedEvidenceCount: evidence.length,
    }];
  });
  const recentAttempts = attemptResult.rows.slice(0, MENTOR_POLICY_LIMITS.recentAttempts).flatMap((row): MentorAttemptSignal[] => {
    if (!["A0", "A1", "A2", "A3", "A4"].includes(row.assistance_level)) return [];
    return [{
      ownerUserId: row.user_id,
      skillId: row.skill_id,
      occurredAt: row.occurred_at.toISOString(),
      score: row.score,
      passed: row.passed,
      assistanceLevel: row.assistance_level as MentorAttemptSignal["assistanceLevel"],
      solutionRevealed: row.solution_revealed,
      sourceType: row.source_type,
      validity: row.validity,
    }];
  });
  const plan = planResult.rows[0];
  return recommendDailyMentorChallenge({
    authenticatedUserId: userId,
    now,
    masterySignals,
    recentAttempts,
    officialPlan: plan ? {
      ownerUserId: plan.user_id,
      revisionId: plan.id,
      nextSkillId: firstPlanSkill(plan.plan),
    } : null,
  });
}
