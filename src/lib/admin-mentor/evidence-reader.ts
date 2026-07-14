import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { redactSensitiveText as redactBoundaryText } from "@/lib/security/sensitive-text";

import type { MentorEvidenceCategory } from "./contracts";

const MAX_RESPONSE_BYTES = 128 * 1024;
const RESPONSE_ENVELOPE_RESERVE_BYTES = 4 * 1024;
// A single record must always fit in a response by itself. Keeping this well
// below the page budget also leaves room for the response envelope and a
// second ordinary record. Without an item-level bound, a large exam/project
// record could be removed by page sizing before a cursor could be issued.
export const MAX_MENTOR_EVIDENCE_ITEM_BYTES = 48 * 1024;
const MAX_CHAT_CHARS = 8_000;
const MAX_SOURCE_CHARS = 16_000;
const MAX_STRUCTURED_STRING_CHARS = 4_000;
const MAX_STRUCTURED_DEPTH = 6;
const MAX_STRUCTURED_ARRAY = 50;

interface CursorValue {
  readonly at: Date;
  readonly id: string;
}

export interface MentorEvidencePageRow {
  readonly id: string;
  readonly created_at: Date;
}

type PageRow = MentorEvidencePageRow;

type JsonRecord = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY = /(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|credential|authorization|cookie|private[_-]?key|device(?:[_-]?(?:id|hash|fingerprint))?|ip[_-]?address)/i;
export class MentorEvidenceError extends Error {
  constructor(public readonly code: "LEARNER_NOT_FOUND" | "INVALID_CURSOR") {
    super(code);
    this.name = "MentorEvidenceError";
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function redactSensitiveText(value: string, maximum = MAX_STRUCTURED_STRING_CHARS) {
  return redactBoundaryText(value, maximum);
}

export function sanitizeStructuredEvidence(value: unknown, depth = 0): unknown {
  if (depth > MAX_STRUCTURED_DEPTH) return "[depth limit]";
  if (typeof value === "string") return redactSensitiveText(value).text;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_STRUCTURED_ARRAY).map((entry) => sanitizeStructuredEvidence(entry, depth + 1));
  }
  const source = record(value);
  if (!source) return null;
  const result: JsonRecord = {};
  for (const [key, entry] of Object.entries(source).slice(0, 100)) {
    if (SENSITIVE_KEY.test(key)) continue;
    result[key] = sanitizeStructuredEvidence(entry, depth + 1);
  }
  return result;
}

export function sanitizeExamAnswer(value: unknown) {
  const source = record(value);
  if (!source) return {};
  const text = typeof source.text === "string" ? redactSensitiveText(source.text, MAX_CHAT_CHARS) : null;
  const code = typeof source.sourceCode === "string" ? redactSensitiveText(source.sourceCode, MAX_SOURCE_CHARS) : null;
  return {
    ...(text ? { text: text.text, textTruncated: text.truncated } : {}),
    ...(code ? { sourceCode: code.text, sourceCodeTruncated: code.truncated } : {}),
    ...(typeof source.language === "string" ? { language: source.language.slice(0, 40) } : {}),
  };
}

export function sanitizeExamResult(value: unknown) {
  const source = record(value);
  if (!source) return null;
  const stringArray = (candidate: unknown) => Array.isArray(candidate)
    ? candidate.filter((entry): entry is string => typeof entry === "string").slice(0, 50).map((entry) => entry.slice(0, 200))
    : [];
  const remediation = record(source.remediation);
  return {
    schemaVersion: source.schemaVersion === 1 ? 1 : null,
    gradingStatus: typeof source.gradingStatus === "string" ? source.gradingStatus : null,
    outcome: typeof source.outcome === "string" ? source.outcome : null,
    officialScorePercent: typeof source.officialScorePercent === "number" ? source.officialScorePercent : null,
    earnedPoints: typeof source.earnedPoints === "number" ? source.earnedPoints : null,
    possiblePoints: typeof source.possiblePoints === "number" ? source.possiblePoints : null,
    pendingReviewItemIds: stringArray(source.pendingReviewItemIds),
    failedCriticalClusters: stringArray(source.failedCriticalClusters),
    masteryBlockingCodingItems: stringArray(source.masteryBlockingCodingItems),
    compilationGatePassed: typeof source.compilationGatePassed === "boolean" ? source.compilationGatePassed : null,
    infrastructureFailure: source.infrastructureFailure === true,
    finalizedAt: typeof source.finalizedAt === "string" ? source.finalizedAt : null,
    finalizedBy: typeof source.finalizedBy === "string" ? source.finalizedBy : null,
    policyVersion: typeof source.policyVersion === "string" ? source.policyVersion : null,
    remediation: {
      required: remediation?.required === true,
      targets: stringArray(remediation?.targets),
    },
  };
}

export function sanitizeRunnerResult(value: unknown) {
  const source = record(value);
  if (!source) return null;
  const compile = record(source.compile);
  const run = record(source.run);
  const totals = record(source.totals);
  const safeOutput = (candidate: unknown) => typeof candidate === "string"
    ? redactSensitiveText(candidate, 2_000).text
    : "";
  return {
    status: typeof source.status === "string" ? source.status : null,
    compile: compile ? {
      status: typeof compile.status === "string" ? compile.status : null,
      exitCode: typeof compile.exitCode === "number" ? compile.exitCode : null,
      stdout: safeOutput(compile.stdout),
      stderr: safeOutput(compile.stderr),
    } : null,
    run: run ? {
      exitCode: typeof run.exitCode === "number" ? run.exitCode : null,
      stdout: safeOutput(run.stdout),
      stderr: safeOutput(run.stderr),
    } : null,
    totals: totals ? {
      passed: typeof totals.passed === "number" ? totals.passed : null,
      failed: typeof totals.failed === "number" ? totals.failed : null,
      total: typeof totals.total === "number" ? totals.total : null,
    } : null,
    // Individual runner tests, expected outputs, image digests, request hashes,
    // and hidden evidence are deliberately not projected.
  };
}

function decodeCursor(value: string | undefined): CursorValue | null {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator < 1) throw new Error("cursor");
    const at = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (!Number.isFinite(at.getTime()) || !UUID_PATTERN.test(id)) throw new Error("cursor");
    return { at, id };
  } catch {
    throw new MentorEvidenceError("INVALID_CURSOR");
  }
}

function encodeCursor(row: PageRow | undefined): string | null {
  return row
    ? Buffer.from(`${row.created_at.toISOString()}|${row.id}`, "utf8").toString("base64url")
    : null;
}

function cursorParameters(cursor: CursorValue | null) {
  return [cursor?.at ?? null, cursor?.id ?? null] as const;
}

async function readChats(client: PoolClient, learnerId: string, cursor: CursorValue | null, limit: number) {
  const [at, id] = cursorParameters(cursor);
  const result = await client.query<PageRow & {
    thread_id: string;
    thread_title: string;
    role: string;
    content: string;
    curriculum_refs: unknown;
  }>(
    `select m.id, m.created_at, t.id as thread_id, left(t.title, 301) as thread_title,
            m.role, left(m.content, $4) as content, m.curriculum_refs
       from chat_message m
       join chat_thread t on t.id = m.thread_id
      where t.user_id = $1
        and ($2::timestamptz is null or (m.created_at, m.id) < ($2, $3::uuid))
      order by m.created_at desc, m.id desc
      limit $5`,
    [learnerId, at, id, MAX_CHAT_CHARS + 1, limit + 1],
  );
  return result.rows.map((row) => {
    const content = redactSensitiveText(row.content, MAX_CHAT_CHARS);
    return {
      id: row.id,
      threadId: row.thread_id,
      threadTitle: redactSensitiveText(row.thread_title, 300).text,
      role: ["user", "assistant", "system"].includes(row.role) ? row.role : "unknown",
      content: content.text,
      contentTruncated: content.truncated,
      curriculumRefs: Array.isArray(row.curriculum_refs)
        ? row.curriculum_refs.filter((entry): entry is string => typeof entry === "string").slice(0, 10)
        : [],
      createdAt: row.created_at.toISOString(),
      _page: row,
    };
  });
}

async function readCode(client: PoolClient, learnerId: string, cursor: CursorValue | null, limit: number) {
  const [at, id] = cursorParameters(cursor);
  const result = await client.query<PageRow & {
    attempt_id: string | null;
    activity_id: string | null;
    language: string;
    source_code: string;
    request_id: string;
    submission_type: string;
    submission_status: string;
    runner_job_id: string | null;
    runner_status: string | null;
    recovery_state: string | null;
    recovery_attempt_count: number | null;
    recovery_next_attempt_at: Date | null;
    recovery_last_error_code: string | null;
    remote_runner_job_id: string | null;
    runner_result: unknown;
  }>(
    `select s.id, s.created_at, s.attempt_id, s.activity_id, s.language,
            left(s.source_code, $4) as source_code, s.request_id, s.submission_type,
            s.status as submission_status, latest.id as runner_job_id,
            latest.status as runner_status, latest.recovery_state,
            latest.recovery_attempt_count, latest.recovery_next_attempt_at,
            latest.recovery_last_error_code, latest.lease_owner as remote_runner_job_id,
            latest.result as runner_result
       from code_submission s
       left join lateral (
         select r.id, r.status, r.lease_owner, r.recovery_state, r.recovery_attempt_count,
                r.recovery_next_attempt_at, r.recovery_last_error_code,
                case when r.result is null then null else jsonb_build_object(
                  'status', r.result ->> 'status',
                  'compile', jsonb_build_object(
                    'status', r.result #>> '{compile,status}',
                    'exitCode', r.result #> '{compile,exitCode}',
                    'stdout', left(coalesce(r.result #>> '{compile,stdout}', ''), 2001),
                    'stderr', left(coalesce(r.result #>> '{compile,stderr}', ''), 2001)
                  ),
                  'run', case when r.result -> 'run' is null then null else jsonb_build_object(
                    'exitCode', r.result #> '{run,exitCode}',
                    'stdout', left(coalesce(r.result #>> '{run,stdout}', ''), 2001),
                    'stderr', left(coalesce(r.result #>> '{run,stderr}', ''), 2001)
                  ) end,
                  'totals', jsonb_build_object(
                    'passed', r.result #> '{totals,passed}',
                    'failed', r.result #> '{totals,failed}',
                    'total', r.result #> '{totals,total}'
                  )
                ) end as result
           from runner_job r
          where r.submission_id = s.id
          order by r.queued_at desc, r.id desc limit 1
       ) latest on true
      where s.user_id = $1
        and ($2::timestamptz is null or (s.created_at, s.id) < ($2, $3::uuid))
      order by s.created_at desc, s.id desc
      limit $5`,
    [learnerId, at, id, MAX_SOURCE_CHARS + 1, limit + 1],
  );
  return result.rows.map((row) => {
    const source = redactSensitiveText(row.source_code, MAX_SOURCE_CHARS);
    return {
      id: row.id,
      attemptId: row.attempt_id,
      activityId: row.activity_id,
      language: row.language.slice(0, 40),
      sourceCode: source.text,
      sourceCodeTruncated: source.truncated,
      runnerRequestId: row.request_id,
      submissionType: row.submission_type.slice(0, 100),
      submissionStatus: row.submission_status,
      runnerJobId: row.runner_job_id,
      runnerStatus: row.runner_status,
      recoveryState: row.recovery_state,
      recoveryAttemptCount: row.recovery_attempt_count,
      recoveryNextAttemptAt: row.recovery_next_attempt_at?.toISOString() ?? null,
      recoveryLastErrorCode: row.recovery_last_error_code,
      remoteRunnerJobId: row.remote_runner_job_id,
      runnerResult: sanitizeRunnerResult(row.runner_result),
      createdAt: row.created_at.toISOString(),
      _page: row,
    };
  });
}

async function readExams(client: PoolClient, learnerId: string, cursor: CursorValue | null, limit: number) {
  const [at, id] = cursorParameters(cursor);
  const sessions = await client.query<PageRow & {
    attempt_id: string;
    kind: string;
    attempt_number: number;
    attempt_status: string;
    session_status: string;
    integrity_review_state: string;
    server_started_at: Date | null;
    submitted_at: Date | null;
    result: unknown;
    corrected: boolean;
  }>(
    `select es.id, es.created_at, es.attempt_id, a.kind, a.attempt_number,
            a.status as attempt_status, es.status as session_status,
            es.integrity_review_state, es.server_started_at, a.submitted_at,
            coalesce(er.result, original.answer -> 'result') as result,
            (er.attempt_id is not null) as corrected
       from exam_session es
       join attempt a on a.id = es.attempt_id and a.user_id = es.user_id
       left join assessment_attempt_effective_result er on er.attempt_id = a.id and er.user_id = es.user_id
       left join lateral (
         select r.answer from response r
          where r.attempt_id = a.id and r.item_key = '__exam_result_v1__'
          order by r.revision desc, r.id desc limit 1
       ) original on true
      where es.user_id = $1
        and ($2::timestamptz is null or (es.created_at, es.id) < ($2, $3::uuid))
      order by es.created_at desc, es.id desc
      limit $4`,
    [learnerId, at, id, limit + 1],
  );
  const page = sessions.rows.slice(0, limit);
  if (page.length === 0) return [];
  const attemptIds = page.map((row) => row.attempt_id);
  const sessionIds = page.map((row) => row.id);
  const answers = await client.query<{
    attempt_id: string;
    id: string;
    item_key: string;
    revision: number;
    answer: unknown;
    saved_at: Date;
    submitted_at: Date | null;
  }>(
    `with latest as (
       select distinct on (r.attempt_id, r.item_key)
              r.attempt_id, r.id, r.item_key, r.revision,
              jsonb_build_object(
                'text', left(coalesce(r.answer ->> 'text', ''), 8001),
                'sourceCode', left(coalesce(r.answer ->> 'sourceCode', ''), 16001),
                'language', left(coalesce(r.answer ->> 'language', ''), 41)
              ) as answer,
              r.saved_at, r.submitted_at
         from response r
        where r.attempt_id = any($1::uuid[]) and left(r.item_key, 2) <> '__'
        order by r.attempt_id, r.item_key, r.revision desc, r.id desc
     ), bounded as (
       select latest.*, row_number() over (partition by attempt_id order by saved_at desc, id desc) as n
         from latest
     )
     select attempt_id, id, item_key, revision, answer, saved_at, submitted_at
       from bounded where n <= 25
      order by saved_at, id`,
    [attemptIds],
  );
  const events = await client.query<{
    exam_session_id: string;
    id: string;
    type: string;
    occurred_at: Date;
  }>(
    `select exam_session_id, id, type, occurred_at from (
       select e.exam_session_id, e.id, e.type, e.occurred_at,
              row_number() over (partition by e.exam_session_id order by e.occurred_at desc, e.id desc) as n
         from exam_event e where e.exam_session_id = any($1::uuid[])
     ) bounded where n <= 50
      order by occurred_at, id`,
    [sessionIds],
  );
  const answersByAttempt = new Map<string, Array<Record<string, unknown>>>();
  for (const answer of answers.rows) {
    const list = answersByAttempt.get(answer.attempt_id) ?? [];
    list.push({
      id: answer.id,
      itemId: answer.item_key.slice(0, 200),
      revision: answer.revision,
      answer: sanitizeExamAnswer(answer.answer),
      savedAt: answer.saved_at.toISOString(),
      submittedAt: answer.submitted_at?.toISOString() ?? null,
    });
    answersByAttempt.set(answer.attempt_id, list);
  }
  const eventsBySession = new Map<string, Array<Record<string, unknown>>>();
  for (const event of events.rows) {
    const list = eventsBySession.get(event.exam_session_id) ?? [];
    list.push({ id: event.id, type: event.type.slice(0, 100), occurredAt: event.occurred_at.toISOString() });
    eventsBySession.set(event.exam_session_id, list);
  }
  return sessions.rows.map((row) => ({
    id: row.id,
    attemptId: row.attempt_id,
    kind: row.kind,
    attemptNumber: row.attempt_number,
    attemptStatus: row.attempt_status,
    sessionStatus: row.session_status,
    integrityReviewState: row.integrity_review_state,
    startedAt: row.server_started_at?.toISOString() ?? null,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    corrected: row.corrected,
    result: sanitizeExamResult(row.result),
    answers: answersByAttempt.get(row.attempt_id) ?? [],
    integrityEvents: eventsBySession.get(row.id) ?? [],
    createdAt: row.created_at.toISOString(),
    _page: row,
  }));
}

async function readProjects(client: PoolClient, learnerId: string, cursor: CursorValue | null, limit: number) {
  const [at, id] = cursorParameters(cursor);
  const projects = await client.query<PageRow & {
    title: string;
    summary: string;
    status: string;
    prd: unknown;
    updated_at: Date;
  }>(
    `select p.id, p.created_at, left(p.title, 301) as title,
            left(p.summary, 2001) as summary, p.status,
            case
              when p.prd is null then null
              when octet_length(p.prd::text) <= 65536 then p.prd
              else jsonb_build_object('truncated', true, 'originalBytes', octet_length(p.prd::text))
            end as prd,
            p.updated_at
       from project p
      where p.user_id = $1
        and ($2::timestamptz is null or (p.created_at, p.id) < ($2, $3::uuid))
      order by p.created_at desc, p.id desc
      limit $4`,
    [learnerId, at, id, limit + 1],
  );
  const page = projects.rows.slice(0, limit);
  if (page.length === 0) return [];
  const reviews = await client.query<{
    project_id: string;
    id: string;
    analyzer_version: string;
    findings: unknown;
    status: string;
    created_at: Date;
  }>(
    `select project_id, id, analyzer_version, findings, status, created_at from (
       select r.project_id, r.id, left(r.analyzer_version, 101) as analyzer_version,
              case
                when octet_length(r.findings::text) <= 65536 then r.findings
                else jsonb_build_array(jsonb_build_object('truncated', true, 'originalBytes', octet_length(r.findings::text)))
              end as findings,
              r.status, r.created_at,
              row_number() over (partition by r.project_id order by r.created_at desc, r.id desc) as n
         from project_review r where r.project_id = any($1::uuid[])
     ) bounded where n <= 5
      order by created_at desc, id desc`,
    [page.map((row) => row.id)],
  );
  const reviewsByProject = new Map<string, Array<Record<string, unknown>>>();
  for (const review of reviews.rows) {
    const list = reviewsByProject.get(review.project_id) ?? [];
    list.push({
      id: review.id,
      analyzerVersion: review.analyzer_version.slice(0, 100),
      findings: sanitizeStructuredEvidence(review.findings),
      status: review.status,
      createdAt: review.created_at.toISOString(),
    });
    reviewsByProject.set(review.project_id, list);
  }
  return projects.rows.map((row) => ({
    id: row.id,
    title: redactSensitiveText(row.title, 300).text,
    summary: redactSensitiveText(row.summary, 2_000).text,
    status: row.status,
    prd: sanitizeStructuredEvidence(row.prd),
    reviews: reviewsByProject.get(row.id) ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    _page: row,
  }));
}

async function readAiSummaries(client: PoolClient, learnerId: string, cursor: CursorValue | null, limit: number) {
  const [at, id] = cursorParameters(cursor);
  const result = await client.query<PageRow & { summary: string; status: string }>(
    `select e.id, e.created_at, left(e.variables ->> 'summary', 8001) as summary, e.status
       from email_outbox e
      where e.user_id = $1 and e.template = 'weekly-summary'
        and nullif(trim(e.variables ->> 'summary'), '') is not null
        and ($2::timestamptz is null or (e.created_at, e.id) < ($2, $3::uuid))
      order by e.created_at desc, e.id desc
      limit $4`,
    [learnerId, at, id, limit + 1],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: "weekly_learning_summary",
    summary: redactSensitiveText(row.summary, MAX_CHAT_CHARS).text,
    deliveryStatus: row.status,
    createdAt: row.created_at.toISOString(),
    _page: row,
  }));
}

export type MentorEvidencePaginationItem = Record<string, unknown> & { readonly _page: MentorEvidencePageRow };
type InternalItem = MentorEvidencePaginationItem;

function stripPage(item: InternalItem) {
  const result: Record<string, unknown> = { ...item };
  delete result._page;
  return result;
}

interface PayloadReductionProfile {
  readonly maxStringChars: number;
  readonly maxArrayEntries: number;
  readonly maxObjectKeys: number;
  readonly maxDepth: number;
}

const PAYLOAD_REDUCTION_PROFILES: readonly PayloadReductionProfile[] = [
  { maxStringChars: 2_000, maxArrayEntries: 12, maxObjectKeys: 32, maxDepth: 5 },
  { maxStringChars: 1_000, maxArrayEntries: 8, maxObjectKeys: 20, maxDepth: 4 },
  { maxStringChars: 256, maxArrayEntries: 4, maxObjectKeys: 12, maxDepth: 3 },
  { maxStringChars: 64, maxArrayEntries: 2, maxObjectKeys: 8, maxDepth: 2 },
];

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function reducePayload(
  value: unknown,
  profile: PayloadReductionProfile,
  depth = 0,
  topLevel = false,
): unknown {
  if (typeof value === "string") return redactSensitiveText(value, profile.maxStringChars).text;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= profile.maxDepth) return "[payload depth truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, profile.maxArrayEntries)
      .map((entry) => reducePayload(entry, profile, depth + 1));
  }
  const source = record(value);
  if (!source) return null;
  const output: JsonRecord = {};
  // Top-level evidence projections are already small allowlists. Preserve
  // their identity/status fields while bounding nested learner-authored data.
  const maximumKeys = topLevel ? 100 : profile.maxObjectKeys;
  for (const [key, entry] of Object.entries(source).slice(0, maximumKeys)) {
    if (key === "_page" || SENSITIVE_KEY.test(key)) continue;
    output[key] = reducePayload(entry, profile, depth + 1);
  }
  return output;
}

function withPayloadLimitMarker(value: JsonRecord, originalBytes: number) {
  return {
    ...value,
    mentorPayloadTruncated: true,
    mentorOriginalPayloadBytes: originalBytes,
    mentorPayloadByteLimit: MAX_MENTOR_EVIDENCE_ITEM_BYTES,
  } satisfies JsonRecord;
}

/**
 * Applies a hard byte cap after the category allowlist/redaction projection
 * and before response-size pagination. The fallback contains only redacted
 * scalar top-level fields, so it cannot reintroduce hidden nested evidence.
 */
export function boundMentorEvidenceItemPayload(value: JsonRecord) {
  const originalBytes = jsonBytes(value);
  if (originalBytes <= MAX_MENTOR_EVIDENCE_ITEM_BYTES) {
    return { value, truncated: false, originalBytes, bytes: originalBytes } as const;
  }

  for (const profile of PAYLOAD_REDUCTION_PROFILES) {
    const reduced = reducePayload(value, profile, 0, true);
    const candidate = withPayloadLimitMarker(record(reduced) ?? {}, originalBytes);
    const bytes = jsonBytes(candidate);
    if (bytes <= MAX_MENTOR_EVIDENCE_ITEM_BYTES) {
      return { value: candidate, truncated: true, originalBytes, bytes } as const;
    }
  }

  // The deterministic last resort still keeps useful identity/scalar fields.
  // Add each field only if the serialized result remains inside the hard cap.
  const fallback: JsonRecord = withPayloadLimitMarker({}, originalBytes);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "_page" || SENSITIVE_KEY.test(key)) continue;
    if (!(typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null)) continue;
    const safeEntry = typeof entry === "string" ? redactSensitiveText(entry, 256).text : entry;
    const candidate = { ...fallback, [key]: safeEntry };
    if (jsonBytes(candidate) <= MAX_MENTOR_EVIDENCE_ITEM_BYTES) fallback[key] = safeEntry;
  }
  return {
    value: fallback,
    truncated: true,
    originalBytes,
    bytes: jsonBytes(fallback),
  } as const;
}

export function boundMentorEvidenceResponsePage(items: InternalItem[], requestedLimit: number) {
  const fetchedMore = items.length > requestedLimit;
  const boundedItems = items.slice(0, requestedLimit).map((item) => {
    const bounded = boundMentorEvidenceItemPayload(stripPage(item));
    return {
      ...bounded.value,
      _page: item._page,
    } as InternalItem;
  });
  const accepted = [...boundedItems];
  let sizeLimited = false;
  while (accepted.length > 0) {
    const publicItems = accepted.map(stripPage);
    if (Buffer.byteLength(JSON.stringify(publicItems), "utf8") <= MAX_RESPONSE_BYTES - RESPONSE_ENVELOPE_RESERVE_BYTES) break;
    accepted.pop();
    sizeLimited = true;
  }
  const publicItems = accepted.map(stripPage);
  const hasMore = fetchedMore || sizeLimited;
  const nextCursor = hasMore ? encodeCursor(accepted.at(-1)?._page) : null;
  // Every non-empty source page has at least one item after the per-item cap,
  // so a continuation can never be advertised without a usable cursor.
  if (hasMore && !nextCursor) {
    throw new Error("MENTOR_EVIDENCE_PAGINATION_INVARIANT");
  }
  return {
    items: publicItems,
    hasMore,
    nextCursor,
    responseBytes: jsonBytes(publicItems),
    truncatedItemCount: publicItems.filter((item) => item.mentorPayloadTruncated === true).length,
  };
}

export async function resolveMentorLearner(learnerPublicId: string) {
  const result = await pool.query<{ id: string; public_id: string; name: string }>(
    `select id, public_id, name from "user"
      where public_id = $1 and role = 'learner' and status not in ('deletion_pending','deleted')
      limit 1`,
    [learnerPublicId],
  );
  return result.rows[0] ?? null;
}

export async function readMentorEvidence(input: {
  readonly learnerUserId: string;
  readonly category: MentorEvidenceCategory;
  readonly cursor?: string;
  readonly limit: number;
}) {
  const cursor = decodeCursor(input.cursor);
  const client = await pool.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const learner = await client.query<{ id: string }>(
      `select id from "user"
        where id = $1 and role = 'learner' and status not in ('deletion_pending','deleted')`,
      [input.learnerUserId],
    );
    if (!learner.rows[0]) throw new MentorEvidenceError("LEARNER_NOT_FOUND");
    let items: InternalItem[];
    switch (input.category) {
      case "chats": items = await readChats(client, input.learnerUserId, cursor, input.limit) as InternalItem[]; break;
      case "code_submissions": items = await readCode(client, input.learnerUserId, cursor, input.limit) as InternalItem[]; break;
      case "exams": items = await readExams(client, input.learnerUserId, cursor, input.limit) as InternalItem[]; break;
      case "projects": items = await readProjects(client, input.learnerUserId, cursor, input.limit) as InternalItem[]; break;
      case "ai_summaries": items = await readAiSummaries(client, input.learnerUserId, cursor, input.limit) as InternalItem[]; break;
    }
    const page = boundMentorEvidenceResponsePage(items, input.limit);
    await client.query("commit");
    return {
      category: input.category,
      items: page.items,
      page: {
        limit: input.limit,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      },
      safeguards: {
        responseBytes: page.responseBytes,
        responseByteLimit: MAX_RESPONSE_BYTES,
        perItemByteLimit: MAX_MENTOR_EVIDENCE_ITEM_BYTES,
        truncatedItemCount: page.truncatedItemCount,
        hiddenAssessmentEvidenceIncluded: false,
        credentialOrSessionEvidenceIncluded: false,
        deviceOrIpEvidenceIncluded: false,
      },
    } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
