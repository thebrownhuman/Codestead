import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  autosaveExamAnswer,
  ExamServiceError,
} from "@/app/api/exams/_lib/service";
import { db, pool } from "@/lib/db/client";
import {
  attempt,
  examAutosaveMutation,
  examSession,
  response,
  user,
} from "@/lib/db/schema";
import {
  BLUEPRINT_RESPONSE_KEY,
  EXAM_POLICY_VERSION,
  type ExamFormSnapshot,
} from "@/lib/exams/contracts";

const OWNER_ID = "exam-autosave-owner";
const OTHER_ID = "exam-autosave-other";
const ATTEMPT_ID = "32000000-0000-4000-8000-000000000001";
const SESSION_ID = "32000000-0000-4000-8000-000000000002";
const FIRST_MUTATION_ID = "32000000-0000-4000-8000-000000000011";
const SECOND_MUTATION_ID = "32000000-0000-4000-8000-000000000012";
const THIRD_MUTATION_ID = "32000000-0000-4000-8000-000000000013";
const FIXED_NOW = new Date("2026-07-15T10:00:00.000Z");
const DEADLINE = new Date("2026-07-15T11:00:00.000Z");
const RECEIPT_SCHEMA = "public";
const RECEIPT_TABLE = "exam_autosave_mutation";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Exam autosave integration requires the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

const form: ExamFormSnapshot = {
  schemaVersion: 1,
  formId: "exam-autosave-idempotency-form",
  seed: "exam-autosave-idempotency-seed",
  courseId: "integration-course",
  courseTitle: "Integration Course",
  moduleId: "integration-module",
  moduleTitle: "Integration Module",
  contentVersion: "integration-v1",
  policyVersion: EXAM_POLICY_VERSION,
  durationMinutes: 60,
  generatedAt: FIXED_NOW.toISOString(),
  instructions: ["Disposable integration form."],
  integrityDisclosure: {
    version: "v1",
    summary: "Disposable integration disclosure.",
    capturedEvents: ["visibility"],
    notCaptured: ["screen contents"],
  },
  items: [
    {
      id: "item-1",
      skillId: "integration.skill.one",
      clusterId: "integration-cluster",
      title: "First item",
      prompt: "Type the first value.",
      kind: "short-answer",
      points: 5,
      critical: false,
      gradingEvidence: { kind: "exact-answer", acceptedAnswers: ["first"], caseSensitive: false },
    },
    {
      id: "item-2",
      skillId: "integration.skill.two",
      clusterId: "integration-cluster",
      title: "Second item",
      prompt: "Type the second value.",
      kind: "short-answer",
      points: 5,
      critical: false,
      gradingEvidence: { kind: "exact-answer", acceptedAnswers: ["second"], caseSensitive: false },
    },
  ],
};

async function seedActiveExam() {
  await db.insert(user).values([
    {
      id: OWNER_ID,
      publicId: "32000000-0000-4000-8000-000000000101",
      name: "Exam Autosave Owner",
      email: "exam-autosave-owner@integration.invalid",
      role: "learner",
      status: "active",
    },
    {
      id: OTHER_ID,
      publicId: "32000000-0000-4000-8000-000000000102",
      name: "Other Exam Learner",
      email: "exam-autosave-other@integration.invalid",
      role: "learner",
      status: "active",
    },
  ]);
  await db.insert(attempt).values({
    id: ATTEMPT_ID,
    userId: OWNER_ID,
    kind: "exam",
    status: "in_progress",
    policyVersion: EXAM_POLICY_VERSION,
    contentVersion: "integration-v1",
    startedAt: FIXED_NOW,
  });
  await db.insert(examSession).values({
    id: SESSION_ID,
    attemptId: ATTEMPT_ID,
    userId: OWNER_ID,
    status: "active",
    serverStartedAt: FIXED_NOW,
    serverDeadlineAt: DEADLINE,
    lastHeartbeatAt: FIXED_NOW,
  });
  await db.insert(response).values({
    attemptId: ATTEMPT_ID,
    itemKey: BLUEPRINT_RESPONSE_KEY,
    revision: 1,
    answer: { snapshot: form } as unknown as Record<string, unknown>,
    source: "server",
    savedAt: FIXED_NOW,
  });
}

function save(input: {
  readonly clientMutationId?: string;
  readonly itemId?: string;
  readonly baseRevision?: number;
  readonly text?: string;
  readonly userId?: string;
  readonly now?: Date;
} = {}) {
  return autosaveExamAnswer({
    userId: input.userId ?? OWNER_ID,
    sessionId: SESSION_ID,
    clientMutationId: input.clientMutationId ?? FIRST_MUTATION_ID,
    itemId: input.itemId ?? "item-1",
    baseRevision: input.baseRevision ?? 0,
    answer: { text: input.text ?? "accepted value" },
    now: input.now ?? FIXED_NOW,
  });
}

async function countItemAnswers(itemId = "item-1") {
  const rows = await db
    .select({ revision: response.revision, answer: response.answer, savedAt: response.savedAt })
    .from(response)
    .where(and(eq(response.attemptId, ATTEMPT_ID), eq(response.itemKey, itemId)));
  return rows;
}

async function readAutosavePersistenceState() {
  const responses = await db
    .select()
    .from(response)
    .where(and(
      eq(response.attemptId, ATTEMPT_ID),
      ne(response.itemKey, BLUEPRINT_RESPONSE_KEY),
    ))
    .orderBy(response.itemKey, response.revision, response.id);
  const receipts = await db
    .select()
    .from(examAutosaveMutation)
    .where(eq(examAutosaveMutation.examSessionId, SESSION_ID))
    .orderBy(examAutosaveMutation.clientMutationId);
  return { responses, receipts };
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seedActiveExam();
});

afterAll(async () => {
  await pool.end();
});

describe("exam autosave exact-once PostgreSQL contract", () => {
  it("accepts once, replays the original receipt, and never stores answer content in the receipt", async () => {
    const first = await save();
    const replay = await save();

    expect([first.replayed, replay.replayed]).toEqual([false, true]);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first).toEqual({
      revision: 1,
      answer: { text: "accepted value" },
      savedAt: FIXED_NOW.toISOString(),
      clientMutationId: FIRST_MUTATION_ID,
      replayed: false,
    });
    expect(await countItemAnswers()).toHaveLength(1);

    const receipts = await db.select().from(examAutosaveMutation);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      examSessionId: SESSION_ID,
      clientMutationId: FIRST_MUTATION_ID,
      itemKey: "item-1",
      inputHash: "75939acf4d6e33e2378ebb8dc609d97ce74cc1b3d92bd40c68ab2a4a32eefd1c",
      expectedRevision: 0,
      resultingRevision: 1,
      resultingSavedAt: FIXED_NOW,
    });
    expect(Object.keys(receipts[0] ?? {})).not.toContain("answer");
    expect(JSON.stringify(receipts[0])).not.toContain("accepted value");
  });

  it.each([
    ["item", { itemId: "item-2" }],
    ["base revision", { baseRevision: 1 }],
    ["answer", { text: "changed value" }],
  ])("rejects same-ID reuse with a changed %s and leaves accepted state unchanged", async (_label, changed) => {
    await save();
    const acceptedState = await readAutosavePersistenceState();

    expect(acceptedState.responses).toHaveLength(1);
    expect(acceptedState.receipts).toHaveLength(1);

    await expect(save(changed)).rejects.toMatchObject({
      status: 409,
      code: "AUTOSAVE_IDEMPOTENCY_MISMATCH",
      message: "This autosave mutation identifier was already used for different input.",
    });
    expect(await readAutosavePersistenceState()).toEqual(acceptedState);
  });

  it("serializes concurrent exact delivery into one original and one replay", async () => {
    const results = await Promise.all([save(), save()]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.revision).toBe(1);
    expect(results[1]?.revision).toBe(1);
    expect(results[0]?.savedAt).toBe(results[1]?.savedAt);
    expect(await countItemAnswers()).toHaveLength(1);
    expect(await db.select().from(examAutosaveMutation)).toHaveLength(1);
  });

  it("replays an old receipt after a newer answer without overwriting current state", async () => {
    const first = await save();
    const second = await save({
      clientMutationId: SECOND_MUTATION_ID,
      baseRevision: 1,
      text: "newer value",
      now: new Date(FIXED_NOW.getTime() + 1_000),
    });

    const oldReplay = await save();

    expect(first.revision).toBe(1);
    expect(second).toMatchObject({ revision: 2, replayed: false, answer: { text: "newer value" } });
    expect(oldReplay).toEqual({ ...first, replayed: true });
    const currentRows = await countItemAnswers();
    expect(currentRows.map((row) => row.revision).sort()).toEqual([1, 2]);
    expect(currentRows.find((row) => row.revision === 2)?.answer).toEqual({ text: "newer value" });
  });

  it("replays after terminal/deadline state but rejects a new mutation and hides receipts from other owners", async () => {
    const first = await save();
    await db.update(examSession).set({ status: "graded" }).where(eq(examSession.id, SESSION_ID));
    const afterDeadline = new Date(DEADLINE.getTime() + 60_000);

    await expect(save({ now: afterDeadline })).resolves.toEqual({ ...first, replayed: true });
    await expect(save({ clientMutationId: SECOND_MUTATION_ID, now: afterDeadline }))
      .rejects.toMatchObject({ status: 409, code: "EXAM_NOT_ACTIVE" });
    await expect(save({ userId: OTHER_ID, now: afterDeadline }))
      .rejects.toMatchObject({ status: 404, code: "EXAM_NOT_FOUND" });
    expect(await countItemAnswers()).toHaveLength(1);
    expect(await db.select().from(examAutosaveMutation)).toHaveLength(1);
  });

  it("keeps different mutation IDs on optimistic CAS so exactly one same-base writer wins", async () => {
    const results = await Promise.allSettled([
      save({ clientMutationId: FIRST_MUTATION_ID, text: "candidate a" }),
      save({ clientMutationId: SECOND_MUTATION_ID, text: "candidate b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ExamServiceError);
    expect(rejected?.reason).toMatchObject({ status: 409, code: "AUTOSAVE_REVISION_CONFLICT" });
    expect(await countItemAnswers()).toHaveLength(1);
    expect(await db.select().from(examAutosaveMutation)).toHaveLength(1);
  });

  it("rolls back the response when receipt insertion fails inside the transaction", async () => {
    await pool.query(`
      create function integration_fail_exam_autosave_receipt()
      returns trigger language plpgsql as $$
      begin
        raise exception 'integration receipt failure' using errcode = 'P0001';
      end;
      $$;
      create trigger integration_fail_exam_autosave_receipt
      before insert on exam_autosave_mutation
      for each row execute function integration_fail_exam_autosave_receipt();
    `);
    let failure: unknown;
    try {
      await save();
    } catch (error) {
      failure = error;
    } finally {
      await pool.query(`
        drop trigger if exists integration_fail_exam_autosave_receipt on exam_autosave_mutation;
        drop function if exists integration_fail_exam_autosave_receipt();
      `);
    }

    expect(failure).toMatchObject({ code: "P0001" });
    expect(await countItemAnswers()).toHaveLength(0);
    expect(await db.select().from(examAutosaveMutation)).toHaveLength(0);
  });

  it("enforces the generated receipt shape, checks, index, and cascading session ownership", async () => {
    await save();
    const constraints = await pool.query<{ constraint_name: string }>(`
      select constraint_row.conname as constraint_name
      from pg_constraint as constraint_row
      join pg_class as source_table on source_table.oid = constraint_row.conrelid
      join pg_namespace as source_namespace on source_namespace.oid = source_table.relnamespace
      where source_namespace.nspname = $1 and source_table.relname = $2
      order by constraint_row.conname
    `, [RECEIPT_SCHEMA, RECEIPT_TABLE]);
    expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
      "exam_autosave_mutation_exam_session_id_exam_session_id_fk",
      "exam_autosave_mutation_expected_revision_nonnegative",
      "exam_autosave_mutation_input_hash_check",
      "exam_autosave_mutation_pk",
      "exam_autosave_mutation_resulting_revision_nonnegative",
      "exam_autosave_mutation_revision_transition",
    ]);

    const primaryKey = await pool.query<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      source_columns: string[];
    }>(`
      select
        constraint_row.conname as constraint_name,
        source_namespace.nspname as source_schema,
        source_table.relname as source_table,
        array_agg(source_column.attname::text order by source_key.ordinality) as source_columns
      from pg_constraint as constraint_row
      join pg_class as source_table on source_table.oid = constraint_row.conrelid
      join pg_namespace as source_namespace on source_namespace.oid = source_table.relnamespace
      cross join lateral unnest(constraint_row.conkey)
        with ordinality as source_key(attnum, ordinality)
      join pg_attribute as source_column
        on source_column.attrelid = source_table.oid
        and source_column.attnum = source_key.attnum
      where source_namespace.nspname = $1
        and source_table.relname = $2
        and constraint_row.contype = 'p'
      group by constraint_row.oid, constraint_row.conname,
        source_namespace.nspname, source_table.relname
    `, [RECEIPT_SCHEMA, RECEIPT_TABLE]);
    expect(primaryKey.rows).toEqual([{
      constraint_name: "exam_autosave_mutation_pk",
      source_schema: RECEIPT_SCHEMA,
      source_table: RECEIPT_TABLE,
      source_columns: ["exam_session_id", "client_mutation_id"],
    }]);

    const foreignKey = await pool.query<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      source_columns: string[];
      target_schema: string;
      target_table: string;
      target_columns: string[];
      on_delete_cascade: boolean;
    }>(`
      select
        constraint_row.conname as constraint_name,
        source_namespace.nspname as source_schema,
        source_table.relname as source_table,
        array_agg(source_column.attname::text order by column_key.ordinality) as source_columns,
        target_namespace.nspname as target_schema,
        target_table.relname as target_table,
        array_agg(target_column.attname::text order by column_key.ordinality) as target_columns,
        constraint_row.confdeltype = 'c' as on_delete_cascade
      from pg_constraint as constraint_row
      join pg_class as source_table on source_table.oid = constraint_row.conrelid
      join pg_namespace as source_namespace on source_namespace.oid = source_table.relnamespace
      join pg_class as target_table on target_table.oid = constraint_row.confrelid
      join pg_namespace as target_namespace on target_namespace.oid = target_table.relnamespace
      cross join lateral unnest(constraint_row.conkey, constraint_row.confkey)
        with ordinality as column_key(source_attnum, target_attnum, ordinality)
      join pg_attribute as source_column
        on source_column.attrelid = source_table.oid
        and source_column.attnum = column_key.source_attnum
      join pg_attribute as target_column
        on target_column.attrelid = target_table.oid
        and target_column.attnum = column_key.target_attnum
      where source_namespace.nspname = $1
        and source_table.relname = $2
        and constraint_row.contype = 'f'
      group by constraint_row.oid, constraint_row.conname,
        source_namespace.nspname, source_table.relname,
        target_namespace.nspname, target_table.relname, constraint_row.confdeltype
    `, [RECEIPT_SCHEMA, RECEIPT_TABLE]);
    expect(foreignKey.rows).toEqual([{
      constraint_name: "exam_autosave_mutation_exam_session_id_exam_session_id_fk",
      source_schema: RECEIPT_SCHEMA,
      source_table: RECEIPT_TABLE,
      source_columns: ["exam_session_id"],
      target_schema: "public",
      target_table: "exam_session",
      target_columns: ["id"],
      on_delete_cascade: true,
    }]);

    const indexes = await pool.query<{
      index_name: string;
      source_schema: string;
      source_table: string;
      key_columns: string[];
      key_column_count: number;
      total_column_count: number;
      is_unique: boolean;
      is_primary: boolean;
    }>(`
      select
        index_table.relname as index_name,
        source_namespace.nspname as source_schema,
        source_table.relname as source_table,
        array_agg(source_column.attname::text order by index_key.ordinality)
          filter (where index_key.ordinality <= index_row.indnkeyatts) as key_columns,
        index_row.indnkeyatts as key_column_count,
        index_row.indnatts as total_column_count,
        index_row.indisunique as is_unique,
        index_row.indisprimary as is_primary
      from pg_index as index_row
      join pg_class as source_table on source_table.oid = index_row.indrelid
      join pg_namespace as source_namespace on source_namespace.oid = source_table.relnamespace
      join pg_class as index_table on index_table.oid = index_row.indexrelid
      cross join lateral unnest(index_row.indkey)
        with ordinality as index_key(attnum, ordinality)
      join pg_attribute as source_column
        on source_column.attrelid = source_table.oid
        and source_column.attnum = index_key.attnum
      where source_namespace.nspname = $1
        and source_table.relname = $2
        and index_table.relname = $3
      group by index_row.indexrelid, index_table.relname,
        source_namespace.nspname, source_table.relname,
        index_row.indisunique, index_row.indisprimary,
        index_row.indnkeyatts, index_row.indnatts
    `, [
      RECEIPT_SCHEMA,
      RECEIPT_TABLE,
      "exam_autosave_mutation_session_item_created_idx",
    ]);
    expect(indexes.rows).toEqual([{
      index_name: "exam_autosave_mutation_session_item_created_idx",
      source_schema: RECEIPT_SCHEMA,
      source_table: RECEIPT_TABLE,
      key_columns: ["exam_session_id", "item_key", "created_at"],
      key_column_count: 3,
      total_column_count: 3,
      is_unique: false,
      is_primary: false,
    }]);

    const columns = await pool.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2
      order by ordinal_position
    `, [RECEIPT_SCHEMA, RECEIPT_TABLE]);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "exam_session_id",
      "client_mutation_id",
      "item_key",
      "input_hash",
      "expected_revision",
      "resulting_revision",
      "resulting_saved_at",
      "created_at",
    ]);

    await expect(pool.query(
      `insert into exam_autosave_mutation
        (exam_session_id, client_mutation_id, item_key, input_hash, expected_revision, resulting_revision, resulting_saved_at)
       values ($1, $2, 'item-1', 'NOT_A_LOWERCASE_SHA256', 0, 1, $3)`,
      [SESSION_ID, SECOND_MUTATION_ID, FIXED_NOW],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `insert into exam_autosave_mutation
        (exam_session_id, client_mutation_id, item_key, input_hash, expected_revision, resulting_revision, resulting_saved_at)
       values ($1, $2, 'item-1', $3, 0, 2, $4)`,
      [SESSION_ID, THIRD_MUTATION_ID, "a".repeat(64), FIXED_NOW],
    )).rejects.toMatchObject({ code: "23514" });

    await db.delete(examSession).where(eq(examSession.id, SESSION_ID));
    expect(await db.select().from(examAutosaveMutation)).toHaveLength(0);
  });
});
