import { createHash } from "node:crypto";

import { pool } from "@/lib/db/client";
import type {
  DraftKey,
  LearnerDraftRecord,
  SaveLearnerDraftInput,
  SaveLearnerDraftResult,
} from "./types";
import {
  DRAFT_ACCOUNT_MAX_BYTES,
  DRAFT_ACCOUNT_MAX_RECORDS,
} from "./types";

type QueryResult<Row extends Record<string, unknown>> = Promise<{ rows: Row[]; rowCount?: number | null }>;

export type DraftQueryClient = Readonly<{
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): QueryResult<Row>;
  release(): void;
}>;

export type DraftDatabase = Readonly<{
  connect(): Promise<DraftQueryClient>;
}>;

type DraftRow = {
  id: string;
  user_id: string;
  kind: string;
  course_id: string;
  skill_id: string;
  language: string | null;
  content: string;
  row_version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type ReplayRow = DraftRow & {
  input_hash: string;
  resulting_row_version: number | string;
};

function iso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Draft database returned an invalid timestamp.");
  return date.toISOString();
}

function mapDraft(row: DraftRow): LearnerDraftRecord {
  const rowVersion = Number(row.row_version);
  if (!Number.isSafeInteger(rowVersion) || rowVersion < 1) {
    throw new Error("Draft database returned an invalid row version.");
  }
  return {
    id: row.id,
    kind: row.kind as LearnerDraftRecord["kind"],
    courseId: row.course_id,
    skillId: row.skill_id,
    language: row.language,
    content: row.content,
    rowVersion,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mutationHash(input: SaveLearnerDraftInput) {
  return createHash("sha256")
    .update("learncoding-draft-mutation-v1\0")
    .update(JSON.stringify({
      userId: input.userId,
      kind: input.kind,
      courseId: input.courseId,
      skillId: input.skillId,
      language: input.language,
      content: input.content,
      expectedRowVersion: input.expectedRowVersion,
    }))
    .digest("hex");
}

function scopeLockKey(userId: string, key: DraftKey) {
  return `draft:${userId}:${key.kind}:${key.courseId}:${key.skillId}:${key.language ?? "none"}`;
}

export class DraftVersionConflictError extends Error {
  readonly code = "DRAFT_VERSION_CONFLICT";

  constructor(readonly current: LearnerDraftRecord | null) {
    super("The server draft changed after this editor loaded.");
    this.name = "DraftVersionConflictError";
  }
}

export class DraftIdempotencyMismatchError extends Error {
  readonly code = "DRAFT_IDEMPOTENCY_MISMATCH";

  constructor() {
    super("This mutation identifier was already used for different draft input.");
    this.name = "DraftIdempotencyMismatchError";
  }
}

export class DraftScopeUnavailableError extends Error {
  readonly code = "DRAFT_SCOPE_UNAVAILABLE";

  constructor() {
    super("This published course skill is not available in the learner's active plan.");
    this.name = "DraftScopeUnavailableError";
  }
}

export class DraftQuotaExceededError extends Error {
  readonly code = "DRAFT_QUOTA_EXCEEDED";

  constructor(readonly limit: "records" | "bytes") {
    super("The learner draft quota has been reached.");
    this.name = "DraftQuotaExceededError";
  }
}

function postgresDraftQuota(error: unknown): DraftQuotaExceededError | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code !== "23514" || typeof candidate.message !== "string") return null;
  if (/draft record quota exceeded/i.test(candidate.message)) return new DraftQuotaExceededError("records");
  if (/draft byte quota exceeded/i.test(candidate.message)) return new DraftQuotaExceededError("bytes");
  return null;
}

const DRAFT_COLUMNS = `
  id, user_id, kind, course_id, skill_id, language, content,
  row_version, created_at, updated_at`;
const ALIASED_DRAFT_COLUMNS = `
  d.id, d.user_id, d.kind, d.course_id, d.skill_id, d.language, d.content,
  d.row_version, d.created_at, d.updated_at`;

const PLATFORM_PLAYGROUND_SCOPES = new Set([
  "c\u0000c",
  "cpp\u0000cpp",
  "java\u0000java",
  "javascript\u0000javascript",
  "python\u0000python",
]);

function isPlatformPlaygroundScope(key: DraftKey) {
  return key.kind === "code"
    && key.skillId === "free-playground"
    && key.language !== null
    && PLATFORM_PLAYGROUND_SCOPES.has(`${key.courseId}\u0000${key.language}`);
}

async function assertAccessiblePublishedScope(
  client: DraftQueryClient,
  userId: string,
  key: DraftKey,
) {
  // The authenticated free-playground scratchpad is not curriculum evidence
  // and awards no mastery. Its exact server-owned scopes remain owner-bound,
  // quota-bound, exam-gated, and versioned like every other durable draft.
  if (isPlatformPlaygroundScope(key)) return;
  const result = await client.query<{ allowed: boolean }>(
    `select true as allowed
       from enrollment e
       join course_version cv on cv.id = e.course_version_id
       join course co on co.id = cv.course_id
       join course_module cm on cm.course_version_id = cv.id
       join lesson l on l.module_id = cm.id
       join lesson_concept lc on lc.lesson_id = l.id
       join concept c on c.id = lc.concept_id
       left join learner_profile lp on lp.user_id = e.user_id
      where e.user_id = $1
        and e.status in ('active','completed')
        and co.slug = $2 and c.slug = $3
        and cv.stage in ('beta','verified')
        and l.content_status in ('beta','verified')
        and (($4 = 'lesson' and $5::text is null)
          or ($4 = 'code' and $5::text is not null
            and (co.slug <> 'dsa' or
              case lower(trim(coalesce(nullif(trim(e.implementation_language), ''), lp.dsa_language, '')))
                when 'c++' then 'cpp'
                when 'py' then 'python'
                else lower(trim(coalesce(nullif(trim(e.implementation_language), ''), lp.dsa_language, '')))
              end =
              case lower(trim(coalesce($5::text, '')))
                when 'c++' then 'cpp'
                when 'py' then 'python'
                else lower(trim(coalesce($5::text, '')))
              end)))
      limit 1`,
    [userId, key.courseId, key.skillId, key.kind, key.language],
  );
  if (!result.rows[0]?.allowed) throw new DraftScopeUnavailableError();
}

export class PostgresLearnerDraftRepository {
  constructor(
    private readonly database: DraftDatabase = pool as unknown as DraftDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(userId: string, key: DraftKey): Promise<LearnerDraftRecord | null> {
    const client = await this.database.connect();
    try {
      await assertAccessiblePublishedScope(client, userId, key);
      const result = await client.query<DraftRow>(
        `select ${DRAFT_COLUMNS}
         from learner_draft
         where user_id = $1 and kind = $2 and course_id = $3 and skill_id = $4
           and language is not distinct from $5`,
        [userId, key.kind, key.courseId, key.skillId, key.language],
      );
      return result.rows[0] ? mapDraft(result.rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async save(input: SaveLearnerDraftInput): Promise<SaveLearnerDraftResult> {
    const client = await this.database.connect();
    const inputHash = mutationHash(input);
    try {
      await client.query("begin");
      // The request lock makes simultaneous delivery of the same retry wait
      // for the first receipt instead of incorrectly returning a version clash.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `draft-request:${input.requestId}`,
      ]);
      const replay = await client.query<ReplayRow>(
        `select ${ALIASED_DRAFT_COLUMNS},
                m.input_hash, m.resulting_row_version
         from learner_draft_mutation m
         join learner_draft d on d.id = m.draft_id
         where m.request_id = $1`,
        [input.requestId],
      );
      if (replay.rows[0]) {
        const receipt = replay.rows[0];
        const ownsReceipt = receipt.user_id === input.userId
          && receipt.kind === input.kind
          && receipt.course_id === input.courseId
          && receipt.skill_id === input.skillId
          && receipt.language === input.language;
        if (!ownsReceipt || receipt.input_hash !== inputHash) {
          throw new DraftIdempotencyMismatchError();
        }
        const draft = mapDraft(receipt);
        await client.query("commit");
        return {
          draft,
          replayed: true,
          committedRowVersion: Number(receipt.resulting_row_version),
        };
      }

      // Serialize aggregate quota accounting across every draft scope owned by
      // this learner. The database trigger mirrors these limits for direct SQL
      // writes, while this check provides a stable application error.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `draft-account-quota:${input.userId}`,
      ]);
      await assertAccessiblePublishedScope(client, input.userId, input);

      // This lock covers the no-row-yet create case as well as normal updates.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        scopeLockKey(input.userId, input),
      ]);
      const currentResult = await client.query<DraftRow>(
        `select ${DRAFT_COLUMNS}
         from learner_draft
         where user_id = $1 and kind = $2 and course_id = $3 and skill_id = $4
           and language is not distinct from $5
         for update`,
        [input.userId, input.kind, input.courseId, input.skillId, input.language],
      );
      const current = currentResult.rows[0] ? mapDraft(currentResult.rows[0]) : null;
      if ((current?.rowVersion ?? 0) !== input.expectedRowVersion) {
        throw new DraftVersionConflictError(current);
      }

      const quota = await client.query<{ record_count: number | string; total_bytes: number | string }>(
        `select count(*)::int as record_count,
                coalesce(sum(octet_length(content)), 0)::bigint as total_bytes
           from learner_draft where user_id = $1`,
        [input.userId],
      );
      const recordCount = Number(quota.rows[0]?.record_count ?? 0);
      const totalBytes = Number(quota.rows[0]?.total_bytes ?? 0);
      const currentBytes = current ? Buffer.byteLength(current.content, "utf8") : 0;
      const projectedBytes = totalBytes - currentBytes + Buffer.byteLength(input.content, "utf8");
      if (!current && recordCount >= DRAFT_ACCOUNT_MAX_RECORDS) {
        throw new DraftQuotaExceededError("records");
      }
      if (!Number.isSafeInteger(projectedBytes) || projectedBytes > DRAFT_ACCOUNT_MAX_BYTES) {
        throw new DraftQuotaExceededError("bytes");
      }

      const timestamp = this.now();
      const changed = current
        ? await client.query<DraftRow>(
            `update learner_draft
             set language = $1, content = $2, row_version = row_version + 1, updated_at = $3
             where id = $4 and user_id = $5 and row_version = $6
             returning ${DRAFT_COLUMNS}`,
            [input.language, input.content, timestamp, current.id, input.userId, current.rowVersion],
          )
        : await client.query<DraftRow>(
            `insert into learner_draft
               (user_id, kind, course_id, skill_id, language, content, row_version, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, 1, $7, $7)
             returning ${DRAFT_COLUMNS}`,
            [
              input.userId,
              input.kind,
              input.courseId,
              input.skillId,
              input.language,
              input.content,
              timestamp,
            ],
          );
      const saved = changed.rows[0];
      if (!saved) throw new DraftVersionConflictError(current);
      const draft = mapDraft(saved);
      await client.query(
        `insert into learner_draft_mutation
           (request_id, draft_id, input_hash, expected_row_version,
            resulting_row_version, resulting_updated_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $6)`,
        [
          input.requestId,
          draft.id,
          inputHash,
          input.expectedRowVersion,
          draft.rowVersion,
          timestamp,
        ],
      );
      await client.query("commit");
      return { draft, replayed: false, committedRowVersion: draft.rowVersion };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      const quotaError = postgresDraftQuota(error);
      if (quotaError) throw quotaError;
      throw error;
    } finally {
      client.release();
    }
  }
}

export const learnerDraftRepository = new PostgresLearnerDraftRepository();
