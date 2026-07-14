import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";

export const MAX_PROJECT_REVISION_FILES = 20;
export const MAX_PROJECT_REVISION_PAGE = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProjectRevisionErrorCode =
  | "INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "FILE_NOT_AVAILABLE"
  | "WRITE_CONFLICT";

export class ProjectRevisionError extends Error {
  constructor(
    public readonly code: ProjectRevisionErrorCode,
    message: string,
    public readonly currentLatestRevision?: number,
  ) {
    super(message);
    this.name = "ProjectRevisionError";
  }
}

export type ProjectRevisionFile = Readonly<{
  objectId: string | null;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  available: boolean;
  downloadUrl: string | null;
}>;

export type ProjectRevisionRecord = Readonly<{
  id: string;
  projectId: string;
  sequence: number;
  changeSummary: string;
  reflection: string | null;
  createdAt: string;
  files: readonly ProjectRevisionFile[];
}>;

export type NormalizedRevisionMutation = Readonly<{
  projectId: string;
  clientRequestId: string;
  expectedLatestRevision: number;
  changeSummary: string;
  reflection: string | null;
  fileIds: readonly string[];
}>;

type RevisionRow = {
  id: string;
  project_id: string;
  sequence: number;
  change_summary: string;
  reflection: string | null;
  created_at: Date;
};

type RevisionFileRow = {
  revision_id: string;
  object_id: string | null;
  original_name: string;
  media_type: string;
  size_bytes: string | number;
  sha256: string;
  available: boolean;
};

type SafeObjectRow = {
  id: string;
  original_name: string;
  media_type: string;
  size_bytes: string | number;
  sha256: string;
};

function requireUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new ProjectRevisionError("INVALID_INPUT", `${label} must be a UUID.`);
  }
}

function exactTrimmed(value: string, minimum: number, maximum: number, label: string) {
  const trimmed = value.trim();
  if (trimmed.length < minimum || trimmed.length > maximum || trimmed.includes("\0")) {
    throw new ProjectRevisionError(
      "INVALID_INPUT",
      `${label} must contain ${minimum} to ${maximum} safe characters.`,
    );
  }
  return trimmed;
}

export function normalizeRevisionMutation(input: {
  projectId: string;
  clientRequestId: string;
  expectedLatestRevision: number;
  changeSummary: string;
  reflection?: string | null;
  fileIds?: readonly string[];
}): NormalizedRevisionMutation {
  requireUuid(input.projectId, "Project id");
  requireUuid(input.clientRequestId, "Request id");
  if (
    !Number.isSafeInteger(input.expectedLatestRevision)
    || input.expectedLatestRevision < 0
    || input.expectedLatestRevision > 2_147_483_647
  ) {
    throw new ProjectRevisionError("INVALID_INPUT", "Expected revision must be a non-negative integer.");
  }
  const changeSummary = exactTrimmed(input.changeSummary, 10, 1_000, "Change summary");
  const reflectionInput = input.reflection?.trim() ?? "";
  const reflection = reflectionInput
    ? exactTrimmed(reflectionInput, 1, 4_000, "Reflection")
    : null;
  const fileIds = [...(input.fileIds ?? [])];
  if (fileIds.length > MAX_PROJECT_REVISION_FILES) {
    throw new ProjectRevisionError(
      "INVALID_INPUT",
      `A revision can associate at most ${MAX_PROJECT_REVISION_FILES} files.`,
    );
  }
  for (const id of fileIds) requireUuid(id, "File id");
  const uniqueFileIds = [...new Set(fileIds)].sort();
  if (uniqueFileIds.length !== fileIds.length) {
    throw new ProjectRevisionError("INVALID_INPUT", "A file can be associated only once per revision.");
  }
  return {
    projectId: input.projectId,
    clientRequestId: input.clientRequestId,
    expectedLatestRevision: input.expectedLatestRevision,
    changeSummary,
    reflection,
    fileIds: uniqueFileIds,
  };
}

export function projectRevisionInputHash(input: NormalizedRevisionMutation) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    projectId: input.projectId,
    expectedLatestRevision: input.expectedLatestRevision,
    changeSummary: input.changeSummary,
    reflection: input.reflection,
    fileIds: input.fileIds,
  })).digest("hex");
}

function safeSize(value: string | number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProjectRevisionError("WRITE_CONFLICT", "Stored project file metadata is invalid.");
  }
  return parsed;
}

function record(row: RevisionRow, files: readonly RevisionFileRow[]): ProjectRevisionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    changeSummary: row.change_summary,
    reflection: row.reflection,
    createdAt: row.created_at.toISOString(),
    files: files.map((file) => ({
      objectId: file.available ? file.object_id : null,
      originalName: file.original_name,
      mediaType: file.media_type,
      sizeBytes: safeSize(file.size_bytes),
      sha256: file.sha256,
      available: file.available,
      downloadUrl: file.available && file.object_id
        ? `/api/files/${encodeURIComponent(file.object_id)}`
        : null,
    })),
  };
}

async function loadFiles(
  client: Pick<PoolClient, "query">,
  userId: string,
  revisionIds: readonly string[],
) {
  if (!revisionIds.length) return new Map<string, RevisionFileRow[]>();
  const result = await client.query<RevisionFileRow>(
    `select link.revision_id, link.object_id, link.original_name, link.media_type,
            link.size_bytes, link.sha256,
            (live.id is not null) as available
       from project_revision_object link
       left join stored_object live
         on live.id = link.object_id
        and live.owner_user_id = $1
        and live.deleted_at is null
        and live.scan_status = 'safe'
      where link.revision_id = any($2::uuid[])
      order by link.revision_id, link.ordinal`,
    [userId, revisionIds],
  );
  const byRevision = new Map<string, RevisionFileRow[]>();
  for (const row of result.rows) {
    const entries = byRevision.get(row.revision_id) ?? [];
    entries.push(row);
    byRevision.set(row.revision_id, entries);
  }
  return byRevision;
}

async function loadRevisionInTransaction(
  client: PoolClient,
  userId: string,
  projectId: string,
  revisionId: string,
) {
  const result = await client.query<RevisionRow>(
    `select revision.id, revision.project_id, revision.sequence,
            revision.change_summary, revision.reflection, revision.created_at
       from project_revision revision
       join project p on p.id = revision.project_id
      where revision.id = $1 and revision.project_id = $2 and p.user_id = $3
      limit 1`,
    [revisionId, projectId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new ProjectRevisionError("REVISION_NOT_FOUND", "Project revision was not found.");
  const files = await loadFiles(client, userId, [row.id]);
  return record(row, files.get(row.id) ?? []);
}

async function recordMeaningfulProjectMilestone(
  client: PoolClient,
  input: { readonly userId: string; readonly projectId: string; readonly revisionId: string; readonly now: Date },
) {
  // A project checkpoint is durable learner evidence even when the learner did
  // not explicitly start a timed study session. If an active session exists,
  // append an idempotent meaningful event to it as well. All writes share the
  // revision transaction, so a failed milestone marker cannot leave a
  // half-committed revision (and an exact request replay cannot double-count).
  const activeSession = await client.query<{ id: string }>(
    `select id from learning_session
      where user_id = $1 and status = 'active' and ended_at is null
      order by started_at desc, id desc
      limit 1
      for update`,
    [input.userId],
  );
  const sessionId = activeSession.rows[0]?.id;
  if (sessionId) {
    await client.query(
      `insert into learning_session_event
        (session_id,user_id,client_event_id,type,subject_type,subject_id,metadata,occurred_at)
       values ($1,$2,$3,'project_milestone','project',$4,$5::jsonb,$6)
       on conflict (user_id,client_event_id) do nothing`,
      [
        sessionId,
        input.userId,
        `project-revision:${input.revisionId}`,
        input.projectId,
        JSON.stringify({ meaningful: true, policyVersion: "project-revision-meaningful-v1" }),
        input.now,
      ],
    );
    await client.query(
      `update learning_session
          set last_activity_at = greatest(last_activity_at,$2),
              row_version = row_version + 1
        where id = $1`,
      [sessionId, input.now],
    );
  }
  await client.query(
    `update "user"
        set last_meaningful_activity_at = $2,
            row_version = row_version + 1,
            updated_at = $2
      where id = $1
        and (last_meaningful_activity_at is null or last_meaningful_activity_at < $2)`,
    [input.userId, input.now],
  );
  await client.query(
    `update inactivity_episode
        set closed_at = $2, updated_at = $2
      where user_id = $1 and closed_at is null and last_activity_at < $2`,
    [input.userId, input.now],
  );
}

export async function createProjectRevision(input: {
  userId: string;
  projectId: string;
  clientRequestId: string;
  expectedLatestRevision: number;
  changeSummary: string;
  reflection?: string | null;
  fileIds?: readonly string[];
  now?: Date;
}): Promise<Readonly<{ revision: ProjectRevisionRecord; duplicate: boolean }>> {
  if (!input.userId || input.userId.length > 255) {
    throw new ProjectRevisionError("INVALID_INPUT", "Authenticated owner is invalid.");
  }
  const mutation = normalizeRevisionMutation(input);
  const inputHash = projectRevisionInputHash(mutation);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new ProjectRevisionError("INVALID_INPUT", "Revision timestamp is invalid.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const owned = await client.query<{ id: string }>(
      "select id from project where id = $1 and user_id = $2 for update",
      [mutation.projectId, input.userId],
    );
    if (!owned.rows[0]) {
      throw new ProjectRevisionError("PROJECT_NOT_FOUND", "Project was not found.");
    }

    const prior = await client.query<{ id: string; input_hash: string }>(
      `select id, input_hash from project_revision
        where project_id = $1 and client_request_id = $2 limit 1`,
      [mutation.projectId, mutation.clientRequestId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].input_hash !== inputHash) {
        throw new ProjectRevisionError(
          "IDEMPOTENCY_MISMATCH",
          "This request id was already used with different revision input.",
        );
      }
      const revision = await loadRevisionInTransaction(
        client,
        input.userId,
        mutation.projectId,
        prior.rows[0].id,
      );
      await client.query("commit");
      return { revision, duplicate: true };
    }

    const latestResult = await client.query<{ latest: number }>(
      "select coalesce(max(sequence), 0)::int as latest from project_revision where project_id = $1",
      [mutation.projectId],
    );
    const latest = latestResult.rows[0]?.latest ?? 0;
    if (latest !== mutation.expectedLatestRevision) {
      throw new ProjectRevisionError(
        "VERSION_CONFLICT",
        "Project revision history changed. Reload before saving a new checkpoint.",
        latest,
      );
    }

    const objects = mutation.fileIds.length
      ? await client.query<SafeObjectRow>(
          `select id, original_name, media_type, size_bytes, sha256
             from stored_object
            where owner_user_id = $1
              and id = any($2::uuid[])
              and deleted_at is null
              and scan_status = 'safe'
              and retention_class = 'user_upload'
            order by id
            for share`,
          [input.userId, mutation.fileIds],
        )
      : { rows: [] as SafeObjectRow[] };
    if (objects.rows.length !== mutation.fileIds.length) {
      throw new ProjectRevisionError(
        "FILE_NOT_AVAILABLE",
        "One or more selected files are not owned, safety-approved, or available.",
      );
    }

    const created = await client.query<{ id: string }>(
      `insert into project_revision
        (project_id, sequence, client_request_id, input_hash,
         change_summary, reflection, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        mutation.projectId,
        latest + 1,
        mutation.clientRequestId,
        inputHash,
        mutation.changeSummary,
        mutation.reflection,
        now,
      ],
    );
    const revisionId = created.rows[0]?.id;
    if (!revisionId) {
      throw new ProjectRevisionError("WRITE_CONFLICT", "Project revision could not be recorded.");
    }
    for (const [ordinal, object] of objects.rows.entries()) {
      await client.query(
        `insert into project_revision_object
          (revision_id, ordinal, object_id, original_name, media_type,
           size_bytes, sha256, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          revisionId,
          ordinal,
          object.id,
          object.original_name,
          object.media_type,
          safeSize(object.size_bytes),
          object.sha256,
          now,
        ],
      );
    }
    await client.query("update project set updated_at = $2 where id = $1", [mutation.projectId, now]);
    await recordMeaningfulProjectMilestone(client, {
      userId: input.userId,
      projectId: mutation.projectId,
      revisionId,
      now,
    });
    const revision = await loadRevisionInTransaction(client, input.userId, mutation.projectId, revisionId);
    await client.query("commit");
    return { revision, duplicate: false };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listProjectRevisions(input: {
  userId: string;
  projectId: string;
  limit?: number;
  beforeSequence?: number;
}): Promise<Readonly<{
  latestSequence: number;
  revisions: readonly ProjectRevisionRecord[];
  nextBeforeSequence: number | null;
}>> {
  requireUuid(input.projectId, "Project id");
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PROJECT_REVISION_PAGE) {
    throw new ProjectRevisionError("INVALID_INPUT", `Limit must be from 1 to ${MAX_PROJECT_REVISION_PAGE}.`);
  }
  if (
    input.beforeSequence !== undefined
    && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)
  ) {
    throw new ProjectRevisionError("INVALID_INPUT", "Revision cursor must be a positive integer.");
  }
  const owner = await pool.query<{ latest: number }>(
    `select coalesce(max(revision.sequence), 0)::int as latest
       from project p
       left join project_revision revision on revision.project_id = p.id
      where p.id = $1 and p.user_id = $2
      group by p.id`,
    [input.projectId, input.userId],
  );
  if (!owner.rows[0]) {
    throw new ProjectRevisionError("PROJECT_NOT_FOUND", "Project was not found.");
  }
  const result = await pool.query<RevisionRow>(
    `select id, project_id, sequence, change_summary, reflection, created_at
       from project_revision
      where project_id = $1
        and ($2::int is null or sequence < $2)
      order by sequence desc
      limit $3`,
    [input.projectId, input.beforeSequence ?? null, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const files = await loadFiles(pool, input.userId, rows.map((row) => row.id));
  return {
    latestSequence: owner.rows[0].latest,
    revisions: rows.map((row) => record(row, files.get(row.id) ?? [])),
    nextBeforeSequence: hasMore ? rows.at(-1)?.sequence ?? null : null,
  };
}

export async function getProjectRevision(input: {
  userId: string;
  projectId: string;
  revisionId: string;
}): Promise<ProjectRevisionRecord> {
  requireUuid(input.projectId, "Project id");
  requireUuid(input.revisionId, "Revision id");
  const result = await pool.query<RevisionRow>(
    `select revision.id, revision.project_id, revision.sequence,
            revision.change_summary, revision.reflection, revision.created_at
       from project_revision revision
       join project p on p.id = revision.project_id
      where revision.id = $1 and revision.project_id = $2 and p.user_id = $3
      limit 1`,
    [input.revisionId, input.projectId, input.userId],
  );
  const row = result.rows[0];
  if (!row) throw new ProjectRevisionError("REVISION_NOT_FOUND", "Project revision was not found.");
  const files = await loadFiles(pool, input.userId, [row.id]);
  return record(row, files.get(row.id) ?? []);
}
