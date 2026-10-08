import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "@/lib/db/client";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import { keysetExportStatement } from "@/lib/data-lifecycle/export-pagination";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

const learner = "export-snapshot-learner";
const admin = "export-snapshot-admin";
const now = new Date("2026-07-12T00:00:00Z");
const requestId = "81000000-0000-4000-8000-000000000031";

beforeEach(async () => {
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Export snapshot tests require the disposable integration database.");
  }
  await resetDisposableIntegrationDatabase(pool);
  await pool.query(`insert into "user" (id,name,email,role,status) values
    ($1,'Export Learner','export-learner@integration.invalid','learner','active'),
    ($2,'Export Admin','export-admin@integration.invalid','admin','active')`, [learner, admin]);
  await pool.query(`insert into consent_record
    (id,user_id,purpose,policy_version,decision,data_categories,source,idempotency_key,occurred_at)
    select ('82000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
      $1,'cohort_profile','test','accepted','[]'::jsonb,'settings','export-fixture:' || n,
      $2::timestamptz + n * interval '1 second'
    from generate_series(1,1205) n`, [learner, now]);
});

afterAll(async () => { await pool.end(); });

describe("real PostgreSQL data export snapshot", () => {
  it("preserves the previous consent projection and ordering across more than one page", async () => {
    const expected = await pool.query(`select jsonb_build_object(
      'id',c.id,'purpose',c.purpose,'policyVersion',c.policy_version,
      'decision',c.decision,'dataCategories',c.data_categories,'source',c.source,'occurredAt',c.occurred_at
    ) as data from consent_record c where c.user_id=$1 order by c.occurred_at,c.id`, [learner]);
    const exported = await createLearnerExport({ learnerId: learner, actorUserId: admin, requestId, now });
    const records = (await new Response(exported.stream).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((line) => line.category === "consentHistory").map((line) => line.data))
      .toEqual(expected.rows.map((row) => row.data));
    await expect(exported.completion).resolves.toMatchObject({ completed: true, truncated: false });
  });

  it("does not mix committed writes between pages into the established snapshot", async () => {
    const exported = await createLearnerExport({ learnerId: learner, actorUserId: admin, requestId, now });
    const reader = exported.stream.getReader();
    const decoder = new TextDecoder();
    const consent: { id: string; decision: string }[] = [];
    let wrote = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const record = JSON.parse(decoder.decode(chunk.value));
        if (record.category !== "consentHistory") continue;
        consent.push(record.data);
        if (consent.length === 1_000) {
          // The export connection is suspended between its first and second
          // consent pages; the pool supplies a separate writer connection.
          await pool.query(`update consent_record set decision='withdrawn'
            where user_id=$1 and id='82000000-0000-4000-8000-000000001205'`, [learner]);
          await pool.query(`insert into consent_record
            (id,user_id,purpose,policy_version,decision,data_categories,source,idempotency_key,occurred_at)
            values ('82000000-0000-4000-8000-000000002000',$1,'cohort_profile','test','withdrawn',
              '[]'::jsonb,'settings','export-during-snapshot',$2::timestamptz + interval '2000 seconds')`, [learner, now]);
          wrote = true;
        }
      }
      await exported.completion;
      expect(wrote).toBe(true);
      expect(consent).toHaveLength(1_205);
      expect(consent.every((row) => row.decision === "accepted")).toBe(true);
      const current = await pool.query("select count(*)::integer count from consent_record where user_id=$1", [learner]);
      expect(current.rows[0].count).toBe(1_206);
    } finally {
      await reader.cancel();
      await exported.completion.catch(() => undefined);
    }
  });

  it("preserves nullable sort keys and tied timestamps at a page boundary", async () => {
    const original = `select jsonb_build_object('id',sample.id,'createdAt',sample.created_at) as data from (
      select lpad(n::text,5,'0') id,
        case when n > 995 then null else $4::timestamptz end created_at
      from generate_series(1,1005) n where $1::text = 'fixture'
    ) sample order by sample.created_at, sample.id limit $2 offset $3`;
    const expected = await pool.query(original, ["fixture", 1_005, 0, now]);
    const statement = keysetExportStatement(original, "fixture");
    const first = await pool.query(statement, ["fixture", 1_000, null, now]);
    const second = await pool.query(statement, ["fixture", 1_000, JSON.stringify(first.rows.at(-1).export_cursor), now]);
    expect([...first.rows, ...second.rows].map((row) => row.data)).toEqual(expected.rows.map((row) => row.data));
    expect(second.rows).toHaveLength(5);
  });
});
