import { pool } from "@/lib/db/client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_COLUMNS = `id, kind, subject, details, status,
                         decision_reason, created_at, decided_at`;

export const learningRequestKinds = [
  "new-subject",
  "topic-extension",
  "content-defect",
] as const;

export type LearningRequestKind = (typeof learningRequestKinds)[number];
export type LearningRequestStatus = "pending" | "approved" | "rejected" | "expired" | "withdrawn";

export interface LearningRequestRecord {
  readonly id: string;
  readonly kind: LearningRequestKind;
  readonly subject: string;
  readonly details: string;
  readonly status: LearningRequestStatus;
  readonly decisionReason: string | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
}

export interface LearningRequestCreateInput {
  readonly userId: string;
  readonly requestId: string;
  readonly kind: LearningRequestKind;
  readonly subject: string;
  readonly details: string;
}

export interface LearningRequestCreateResult {
  readonly request: LearningRequestRecord;
  readonly replayed: boolean;
}

export type LearningRequestRepositoryErrorCode =
  | "INVALID_REQUEST_ID"
  | "IDEMPOTENCY_MISMATCH"
  | "WRITE_CONFLICT";

export class LearningRequestRepositoryError extends Error {
  constructor(
    public readonly code: LearningRequestRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LearningRequestRepositoryError";
  }
}

type LearningRequestRow = {
  readonly id: string;
  readonly kind: LearningRequestKind;
  readonly subject: string;
  readonly details: string;
  readonly status: LearningRequestStatus;
  readonly decision_reason: string | null;
  readonly created_at: Date | string;
  readonly decided_at: Date | string | null;
};

interface LearningRequestQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
  release(): void;
}

export interface LearningRequestDatabase {
  connect(): Promise<LearningRequestQueryClient>;
}

function mapRequest(row: LearningRequestRow): LearningRequestRecord {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    details: row.details,
    status: row.status,
    decisionReason: row.decision_reason,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    decidedAt: row.decided_at === null
      ? null
      : row.decided_at instanceof Date
        ? row.decided_at
        : new Date(row.decided_at),
  };
}

function normalizeInput(input: LearningRequestCreateInput): LearningRequestCreateInput {
  if (!UUID_PATTERN.test(input.requestId)) {
    throw new LearningRequestRepositoryError(
      "INVALID_REQUEST_ID",
      "Learning request id must be a UUID.",
    );
  }
  return {
    ...input,
    subject: input.subject.trim(),
    details: input.details.trim(),
  };
}

function exactReplay(row: LearningRequestRow, input: LearningRequestCreateInput) {
  return row.kind === input.kind
    && row.subject === input.subject
    && row.details === input.details;
}

async function findByRequestId(
  client: LearningRequestQueryClient,
  userId: string,
  requestId: string,
) {
  const result = await client.query<LearningRequestRow>(
    `select ${REQUEST_COLUMNS}
       from learning_request
      where user_id = $1 and request_id = $2
      limit 1`,
    [userId, requestId],
  );
  return result.rows[0] ?? null;
}

function replayOrThrow(
  row: LearningRequestRow,
  input: LearningRequestCreateInput,
): LearningRequestRecord {
  if (!exactReplay(row, input)) {
    throw new LearningRequestRepositoryError(
      "IDEMPOTENCY_MISMATCH",
      "This learning request id was already used with different input.",
    );
  }
  return mapRequest(row);
}

export class PostgresLearningRequestRepository {
  constructor(
    private readonly database: LearningRequestDatabase = pool as unknown as LearningRequestDatabase,
  ) {}

  async listForUser(userId: string): Promise<readonly LearningRequestRecord[]> {
    const client = await this.database.connect();
    try {
      const result = await client.query<LearningRequestRow>(
        `select ${REQUEST_COLUMNS}
           from learning_request
          where user_id = $1
          order by created_at desc
          limit 100`,
        [userId],
      );
      return result.rows.map(mapRequest);
    } finally {
      client.release();
    }
  }

  /**
   * Checks durable receipts before consuming a rate-limit budget. This makes a
   * retry after a lost HTTP response return the committed row even when the
   * learner has since exhausted their create budget.
   */
  async findReplay(input: LearningRequestCreateInput): Promise<LearningRequestRecord | null> {
    const normalized = normalizeInput(input);
    const client = await this.database.connect();
    try {
      const row = await findByRequestId(client, normalized.userId, normalized.requestId);
      return row ? replayOrThrow(row, normalized) : null;
    } finally {
      client.release();
    }
  }

  async create(input: LearningRequestCreateInput): Promise<LearningRequestCreateResult> {
    const normalized = normalizeInput(input);
    const client = await this.database.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `learning-request:${normalized.userId}:${normalized.requestId}`,
      ]);

      const replay = await findByRequestId(client, normalized.userId, normalized.requestId);
      if (replay) {
        const request = replayOrThrow(replay, normalized);
        await client.query("commit");
        return { request, replayed: true };
      }

      const inserted = await client.query<LearningRequestRow>(
        `insert into learning_request
           (user_id, request_id, kind, subject, details)
         values ($1, $2, $3, $4, $5)
         on conflict (user_id, request_id) do nothing
         returning ${REQUEST_COLUMNS}`,
        [
          normalized.userId,
          normalized.requestId,
          normalized.kind,
          normalized.subject,
          normalized.details,
        ],
      );
      const created = inserted.rows[0];
      if (created) {
        await client.query("commit");
        return { request: mapRequest(created), replayed: false };
      }

      // Defensive race recovery if a direct writer did not take the advisory
      // lock but did honor the scoped uniqueness constraint.
      const raced = await findByRequestId(client, normalized.userId, normalized.requestId);
      if (raced) {
        const request = replayOrThrow(raced, normalized);
        await client.query("commit");
        return { request, replayed: true };
      }
      throw new LearningRequestRepositoryError(
        "WRITE_CONFLICT",
        "Learning request could not be recorded.",
      );
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export const learningRequestRepository = new PostgresLearningRequestRepository();
