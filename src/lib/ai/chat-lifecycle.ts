import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { projectTutorContextManifest } from "@/lib/ai/context";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 500;

type Cursor = { readonly at: string; readonly id: string };

export class ChatThreadLifecycleError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_CURSOR" | "VERSION_CONFLICT" | "INVALID_REQUEST",
    public readonly current?: { readonly status: string; readonly updatedAt: string },
  ) {
    super(code);
  }
}

function assertUserId(userId: string) {
  if (!userId || userId.length > 200) throw new ChatThreadLifecycleError("INVALID_REQUEST");
}

export function encodeChatCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeChatCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  if (value.length > MAX_CURSOR_LENGTH) throw new ChatThreadLifecycleError("INVALID_CURSOR");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    const date = typeof parsed.at === "string" ? new Date(parsed.at) : null;
    if (!date || !Number.isFinite(date.getTime()) || typeof parsed.id !== "string" || !UUID_PATTERN.test(parsed.id)) {
      throw new Error("invalid cursor");
    }
    return { at: date.toISOString(), id: parsed.id };
  } catch {
    throw new ChatThreadLifecycleError("INVALID_CURSOR");
  }
}

function boundedLimit(value: number | undefined, maximum: number) {
  if (value === undefined) return Math.min(20, maximum);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ChatThreadLifecycleError("INVALID_REQUEST");
  }
  return value;
}

type ThreadRow = {
  id: string;
  title: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  message_count: string;
  latest_provider: string | null;
  latest_model: string | null;
  latest_source: string | null;
};

export async function listOwnedChatThreads(input: {
  readonly userId: string;
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly includeArchived?: boolean;
}) {
  assertUserId(input.userId);
  const limit = boundedLimit(input.limit, MAX_PAGE_SIZE);
  const cursor = decodeChatCursor(input.cursor);
  const result = await pool.query<ThreadRow>(
    `select t.id, t.title, t.status, t.created_at, t.updated_at,
            (select count(*)::text from chat_message counted where counted.thread_id = t.id) message_count,
            latest.provider::text latest_provider, latest.model latest_model,
            latest.context_manifest->>'credentialSource' latest_source
       from chat_thread t
       left join lateral (
         select mc.provider, mc.model, mc.context_manifest
           from chat_message m join model_call mc on mc.id = m.model_call_id
          where m.thread_id = t.id and m.role = 'assistant'
          order by m.created_at desc, m.id desc limit 1
       ) latest on true
      where t.user_id = $1
        and t.status in ('active', 'archived')
        and ($2::boolean or t.status = 'active')
        and ($3::timestamptz is null or (t.updated_at, t.id) < ($3::timestamptz, $4::uuid))
      order by t.updated_at desc, t.id desc
      limit $5`,
    [input.userId, input.includeArchived === true, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const selected = result.rows.slice(0, limit);
  const last = selected.at(-1);
  return {
    threads: selected.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      messageCount: Number(row.message_count),
      provider: row.latest_provider,
      model: row.latest_model,
      credentialSource: row.latest_source,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })),
    nextCursor: hasMore && last ? encodeChatCursor({ at: last.updated_at.toISOString(), id: last.id }) : null,
  };
}

type MessageRow = {
  id: string;
  role: string;
  content: string;
  curriculum_refs: string[];
  safety_labels: string[];
  created_at: Date;
  call_id: string | null;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  credential_source: string | null;
  context_manifest: unknown;
};

export async function readOwnedChatThread(input: {
  readonly userId: string;
  readonly threadId: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}) {
  assertUserId(input.userId);
  if (!UUID_PATTERN.test(input.threadId)) throw new ChatThreadLifecycleError("INVALID_REQUEST");
  const limit = boundedLimit(input.limit, MAX_MESSAGE_PAGE_SIZE);
  const cursor = decodeChatCursor(input.cursor);
  const thread = await pool.query<{ id: string; title: string; status: string; created_at: Date; updated_at: Date }>(
    `select id,title,status,created_at,updated_at
       from chat_thread
      where id = $1 and user_id = $2 and status in ('active', 'archived')
      limit 1`,
    [input.threadId, input.userId],
  );
  const owned = thread.rows[0];
  if (!owned) throw new ChatThreadLifecycleError("NOT_FOUND");
  const result = await pool.query<MessageRow>(
    `select m.id,m.role,m.content,m.curriculum_refs,m.safety_labels,m.created_at,
            mc.id call_id,mc.provider::text provider,mc.model,mc.prompt_version,
            mc.context_manifest->>'credentialSource' credential_source,
            mc.context_manifest context_manifest
       from chat_message m left join model_call mc on mc.id = m.model_call_id
      where m.thread_id = $1
        and ($2::timestamptz is null or (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
      order by m.created_at desc,m.id desc limit $4`,
    [input.threadId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const descending = result.rows.slice(0, limit);
  const oldest = descending.at(-1);
  return {
    thread: {
      id: owned.id,
      title: owned.title,
      status: owned.status,
      createdAt: owned.created_at.toISOString(),
      updatedAt: owned.updated_at.toISOString(),
    },
    messages: descending.reverse().map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      curriculumRefs: row.curriculum_refs,
      safetyLabels: row.safety_labels,
      createdAt: row.created_at.toISOString(),
      callId: row.call_id,
      provider: row.provider,
      model: row.model,
      promptVersion: row.prompt_version,
      credentialSource: row.credential_source,
      contextManifest: projectTutorContextManifest(row.context_manifest),
    })),
    nextCursor: hasMore && oldest ? encodeChatCursor({ at: oldest.created_at.toISOString(), id: oldest.id }) : null,
  };
}

async function updateStatusWithClient(input: {
  readonly client: PoolClient;
  readonly userId: string;
  readonly threadId: string;
  readonly status: "active" | "archived";
  readonly expectedUpdatedAt: string;
  readonly now: Date;
}) {
  const existing = await input.client.query<{ status: string; updated_at: Date }>(
    `select status,updated_at
       from chat_thread
      where id = $1 and user_id = $2 and status in ('active', 'archived')
      for update`,
    [input.threadId, input.userId],
  );
  const current = existing.rows[0];
  if (!current) throw new ChatThreadLifecycleError("NOT_FOUND");
  // A retried mutation whose target state already holds is safe and
  // idempotent even when the original response was lost. Do this before the
  // version check so a network retry does not become a false conflict.
  if (current.status === input.status) {
    return { status: current.status, updatedAt: current.updated_at.toISOString(), replayed: true };
  }
  if (current.updated_at.toISOString() !== new Date(input.expectedUpdatedAt).toISOString()) {
    throw new ChatThreadLifecycleError("VERSION_CONFLICT", {
      status: current.status,
      updatedAt: current.updated_at.toISOString(),
    });
  }
  const updated = await input.client.query<{ status: string; updated_at: Date }>(
    `update chat_thread set status = $3, updated_at = $4 where id = $1 and user_id = $2 returning status,updated_at`,
    [input.threadId, input.userId, input.status, input.now],
  );
  return {
    status: updated.rows[0]!.status,
    updatedAt: updated.rows[0]!.updated_at.toISOString(),
    replayed: false,
  };
}

export async function setOwnedChatThreadStatus(input: {
  readonly userId: string;
  readonly threadId: string;
  readonly status: "active" | "archived";
  readonly expectedUpdatedAt: string;
  readonly now?: Date;
}) {
  assertUserId(input.userId);
  const expected = new Date(input.expectedUpdatedAt);
  const now = input.now ?? new Date();
  if (!UUID_PATTERN.test(input.threadId) || !Number.isFinite(expected.getTime()) || !Number.isFinite(now.getTime())) {
    throw new ChatThreadLifecycleError("INVALID_REQUEST");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await updateStatusWithClient({ ...input, client, now });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
