import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { pool } from "@/lib/db/client";
import { runRetention } from "@/lib/data-lifecycle/retention";
import { runWithValidatedRetentionOpsEnvironment } from "../scripts/lib/disposable-integration-environment";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

afterAll(async () => { await pool.end(); });

it("A's 11th chat removes only A's oldest with messages and an atomic audit; B is untouched", async () => {
  await runWithValidatedRetentionOpsEnvironment(process.env, async ({ databaseOpsUrl }) => {
    await resetDisposableIntegrationDatabase(pool);
    const ops = new Pool({ connectionString: databaseOpsUrl, max: 1 });
    const now = new Date("2026-10-08T12:00:00.000Z");
    const oldest = "91000000-0000-4000-8000-000000000001";
    try {
      await pool.query(`insert into "user" (id,name,email,email_verified,status) values
        ('cap-a','Learner A','cap-a@example.test',true,'active'),
        ('cap-b','Learner B','cap-b@example.test',true,'active')`);
      for (const owner of ["cap-a", "cap-b"]) {
        for (let index = 1; index <= (owner === "cap-a" ? 11 : 10); index++) {
          const threadId = `${owner === "cap-a" ? "91" : "92"}000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
          const createdAt = new Date(now.getTime() - (12 - index) * 60_000);
          await pool.query(`insert into chat_thread (id,user_id,title,status,created_at,updated_at) values ($1,$2,'Conversation',$3,$4,$4)`,
            [threadId, owner, index === 1 ? "archived" : "active", createdAt]);
          await pool.query(`insert into chat_message (thread_id,role,content,created_at) values ($1,'user','Stored learner message',$2)`, [threadId, createdAt]);
        }
      }
      const counts = async () => (await pool.query(`select t.user_id, count(distinct t.id)::int threads, count(m.id)::int messages
        from chat_thread t left join chat_message m on m.thread_id=t.id group by t.user_id order by t.user_id`)).rows;
      const before = await counts();
      expect(before).toEqual([{ user_id: "cap-a", threads: 11, messages: 11 }, { user_id: "cap-b", threads: 10, messages: 10 }]);
      const dependencies = { acquireClient: () => ops.connect(), processFileErasures: async () => ({ total: 0, removed: 0, alreadyAbsent: 0, failed: 0, pending: 0, complete: true }) };
      const report = await runRetention({ idempotencyKey: "retention:integration:tutor-cap", dryRun: false, now }, dependencies);
      expect(report.categories.tutorConversationCap).toMatchObject({ eligible: 1, deleted: 1, retained: 0 });
      expect(await counts()).toEqual([{ user_id: "cap-a", threads: 10, messages: 10 }, before[1]]);
      expect((await pool.query("select id from chat_thread where id=$1", [oldest])).rows).toEqual([]);
      expect((await pool.query("select id from chat_message where thread_id=$1", [oldest])).rows).toEqual([]);
      const audit = await pool.query(`select subject_user_id,resource_id,metadata,event_hash from audit_event where action='retention.deleted'`);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ subject_user_id: "cap-a", resource_id: oldest,
        metadata: { category: "tutorConversationCap", lifecycleRunId: report.runId, policyVersion: report.policyVersion }, event_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const checkpoint = await pool.query("select report from data_lifecycle_run where id=$1", [report.runId]);
      expect(checkpoint.rows[0]?.report.categories.tutorConversationCap.deleted).toBe(1);
      expect((await runRetention({ idempotencyKey: "retention:integration:tutor-cap", dryRun: false, now }, dependencies)).replayed).toBe(true);
      expect((await pool.query("select id from audit_event where action='retention.deleted'")).rows).toHaveLength(1);
    } finally { await ops.end(); }
  });
});
