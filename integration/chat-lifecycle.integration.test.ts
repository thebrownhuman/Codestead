import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  listOwnedChatThreads,
  readOwnedChatThread,
  setOwnedChatThreadStatus,
} from "@/lib/ai/chat-lifecycle";
import { pool } from "@/lib/db/client";

const LEARNER = "chat-lifecycle-learner";
const OTHER = "chat-lifecycle-other";
const ACTIVE = "41000000-0000-4000-8000-000000000001";
const ARCHIVED = "41000000-0000-4000-8000-000000000002";
const DELETED = "41000000-0000-4000-8000-000000000003";
const OTHER_THREAD = "41000000-0000-4000-8000-000000000004";
const BASE = new Date("2026-07-12T08:00:00.000Z");
const ACTIVE_UPDATED = new Date("2026-07-12T11:00:00.000Z");
const ARCHIVED_UPDATED = new Date("2026-07-12T10:00:00.000Z");

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Chat lifecycle integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const tables = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const names = tables.rows.map((row) => `"${row.table_name.replaceAll('"', '""')}"`).join(",");
  if (names) await pool.query(`truncate table ${names} restart identity cascade`);
}

async function seed() {
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status,email_verified,two_factor_enabled,created_at,updated_at)
     values
       ($1,'40000000-0000-4000-8000-000000000001','Asha','asha-chat@integration.invalid','learner','active',true,true,$3,$3),
       ($2,'40000000-0000-4000-8000-000000000002','Other','other-chat@integration.invalid','learner','active',true,true,$3,$3)`,
    [LEARNER, OTHER, BASE],
  );
  await pool.query(
    `insert into chat_thread (id,user_id,title,status,created_at,updated_at)
     values
       ($1,$5,'Active arrays','active',$9,$6),
       ($2,$5,'Archived loops','archived',$9,$7),
       ($3,$5,'Deleted legacy','deleted',$9,$8),
       ($4,$10,'Other private thread','active',$9,$6)`,
    [ACTIVE, ARCHIVED, DELETED, OTHER_THREAD, LEARNER, ACTIVE_UPDATED, ARCHIVED_UPDATED, BASE, BASE, OTHER],
  );
  await pool.query(
    `insert into model_call
      (id,user_id,provider,model,operation,prompt_version,context_manifest,status,request_hash,response_hash,created_at)
     values
      ('42000000-0000-4000-8000-000000000001',$1,'openrouter','open/test','tutor','buddy-v1',
       '{"credentialSource":"admin_fallback"}'::jsonb,'succeeded',$2,$3,$4)`,
    [LEARNER, "a".repeat(64), "b".repeat(64), ARCHIVED_UPDATED],
  );
  await pool.query(
    `insert into chat_message
      (id,thread_id,role,content,model_call_id,curriculum_refs,safety_labels,created_at)
     values
      ('43000000-0000-4000-8000-000000000001',$1,'user','How do loop bounds work?',null,'["python.loops"]'::jsonb,'[]'::jsonb,$3),
      ('43000000-0000-4000-8000-000000000002',$1,'assistant','Trace the exclusive stop.','42000000-0000-4000-8000-000000000001','["python.loops"]'::jsonb,'[]'::jsonb,$4),
      ('43000000-0000-4000-8000-000000000003',$2,'assistant','OTHER-PRIVATE-SENTINEL',null,'[]'::jsonb,'[]'::jsonb,$4)`,
    [ARCHIVED, OTHER_THREAD, BASE, ARCHIVED_UPDATED],
  );
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL chat lifecycle", () => {
  it("lists only the owner and excludes deleted threads while paginating active/archive history", async () => {
    const activeOnly = await listOwnedChatThreads({ userId: LEARNER, limit: 20 });
    expect(activeOnly.threads.map((thread) => thread.id)).toEqual([ACTIVE]);

    const first = await listOwnedChatThreads({ userId: LEARNER, includeArchived: true, limit: 1 });
    expect(first.threads.map((thread) => thread.id)).toEqual([ACTIVE]);
    expect(first.nextCursor).toBeTruthy();
    const second = await listOwnedChatThreads({
      userId: LEARNER,
      includeArchived: true,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.threads.map((thread) => thread.id)).toEqual([ARCHIVED]);
    expect(second.threads[0]).toMatchObject({
      messageCount: 2,
      provider: "openrouter",
      model: "open/test",
      credentialSource: "admin_fallback",
    });
    expect(JSON.stringify([...first.threads, ...second.threads])).not.toContain(DELETED);
    expect(JSON.stringify([...first.threads, ...second.threads])).not.toContain(OTHER_THREAD);
  });

  it("reads archived owned messages with safe provenance and never crosses ownership", async () => {
    const result = await readOwnedChatThread({ userId: LEARNER, threadId: ARCHIVED, limit: 100 });
    expect(result.thread.status).toBe("archived");
    expect(result.messages.map((message) => message.content)).toEqual([
      "How do loop bounds work?",
      "Trace the exclusive stop.",
    ]);
    expect(result.messages[1]).toMatchObject({
      provider: "openrouter",
      model: "open/test",
      promptVersion: "buddy-v1",
      credentialSource: "admin_fallback",
    });
    await expect(readOwnedChatThread({ userId: LEARNER, threadId: OTHER_THREAD }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOwnedChatThread({ userId: LEARNER, threadId: DELETED }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serializes archive/reopen, replays a lost response, and reports a real stale-version conflict", async () => {
    const archivedAt = new Date("2026-07-12T12:00:00.000Z");
    const archived = await setOwnedChatThreadStatus({
      userId: LEARNER,
      threadId: ACTIVE,
      status: "archived",
      expectedUpdatedAt: ACTIVE_UPDATED.toISOString(),
      now: archivedAt,
    });
    expect(archived).toEqual({ status: "archived", updatedAt: archivedAt.toISOString(), replayed: false });

    await expect(setOwnedChatThreadStatus({
      userId: LEARNER,
      threadId: ACTIVE,
      status: "archived",
      expectedUpdatedAt: ACTIVE_UPDATED.toISOString(),
    })).resolves.toEqual({ status: "archived", updatedAt: archivedAt.toISOString(), replayed: true });

    await expect(setOwnedChatThreadStatus({
      userId: LEARNER,
      threadId: ACTIVE,
      status: "active",
      expectedUpdatedAt: ACTIVE_UPDATED.toISOString(),
    })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      current: { status: "archived", updatedAt: archivedAt.toISOString() },
    });

    const reopenedAt = new Date("2026-07-12T13:00:00.000Z");
    await expect(setOwnedChatThreadStatus({
      userId: LEARNER,
      threadId: ACTIVE,
      status: "active",
      expectedUpdatedAt: archivedAt.toISOString(),
      now: reopenedAt,
    })).resolves.toEqual({ status: "active", updatedAt: reopenedAt.toISOString(), replayed: false });
  });
});
