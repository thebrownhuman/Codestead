import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import { learningRequest, user } from "@/lib/db/schema";
import { learningRequestRepository } from "@/lib/learning-requests/repository";

const LEARNER_ID = "learning-request-learner";
const OTHER_LEARNER_ID = "learning-request-other";
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";

const input = {
  userId: LEARNER_ID,
  requestId: REQUEST_ID,
  kind: "new-subject" as const,
  subject: "Distributed systems",
  details: "Consensus, failure models, and evidence-driven projects.",
};

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Learning-request integration tests require the disposable learncoding_integration database.");
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

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values([
    {
      id: LEARNER_ID,
      publicId: "20000000-0000-4000-8000-000000000001",
      name: "Request Learner",
      email: "request-learner@integration.invalid",
      role: "learner",
      status: "active",
    },
    {
      id: OTHER_LEARNER_ID,
      publicId: "20000000-0000-4000-8000-000000000002",
      name: "Other Request Learner",
      email: "request-other@integration.invalid",
      role: "learner",
      status: "active",
    },
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL learner curriculum requests", () => {
  it("recovers a lost response, rejects changed reuse, and scopes the request id per learner", async () => {
    const committedButResponseLost = await learningRequestRepository.create(input);
    expect(committedButResponseLost.replayed).toBe(false);

    const retry = await learningRequestRepository.create(input);
    expect(retry).toMatchObject({
      replayed: true,
      request: { id: committedButResponseLost.request.id },
    });
    expect(await db.select().from(learningRequest).where(and(
      eq(learningRequest.userId, LEARNER_ID),
      eq(learningRequest.requestId, REQUEST_ID),
    ))).toHaveLength(1);

    await expect(learningRequestRepository.create({
      ...input,
      details: "The same id must not authorize different request content.",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    const otherLearner = await learningRequestRepository.create({
      ...input,
      userId: OTHER_LEARNER_ID,
    });
    expect(otherLearner.replayed).toBe(false);
    expect(await db.select().from(learningRequest).where(eq(
      learningRequest.requestId,
      REQUEST_ID,
    ))).toHaveLength(2);
  });

  it("serializes concurrent identical creates and preserves the database default for trusted writers", async () => {
    const concurrentId = "10000000-0000-4000-8000-000000000002";
    const [left, right] = await Promise.all([
      learningRequestRepository.create({ ...input, requestId: concurrentId }),
      learningRequestRepository.create({ ...input, requestId: concurrentId }),
    ]);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(left.request.id).toBe(right.request.id);
    expect(await db.select().from(learningRequest).where(and(
      eq(learningRequest.userId, LEARNER_ID),
      eq(learningRequest.requestId, concurrentId),
    ))).toHaveLength(1);

    const [defaulted] = await db.insert(learningRequest).values({
      userId: LEARNER_ID,
      kind: "content-defect",
      subject: "Existing report writer",
      details: "Trusted server writers still receive a durable database-generated id.",
    }).returning();
    expect(defaulted?.requestId).toMatch(/^[0-9a-f-]{36}$/i);

    const metadata = await pool.query<{
      column_default: string | null;
      is_nullable: string;
      indexdef: string;
    }>(`
      select c.column_default, c.is_nullable, i.indexdef
        from information_schema.columns c
        join pg_indexes i on i.schemaname = 'public'
          and i.tablename = 'learning_request'
          and i.indexname = 'learning_request_user_request_unique'
       where c.table_schema = 'public'
         and c.table_name = 'learning_request'
         and c.column_name = 'request_id'
    `);
    expect(metadata.rows[0]).toMatchObject({ is_nullable: "NO" });
    expect(metadata.rows[0]?.column_default).toContain("gen_random_uuid");
    expect(metadata.rows[0]?.indexdef).toContain("UNIQUE INDEX");
    expect(metadata.rows[0]?.indexdef).toContain("(user_id, request_id)");
  });
});
