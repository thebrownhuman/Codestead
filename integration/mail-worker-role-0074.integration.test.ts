import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool as applicationPool } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { scheduleInactivityReminders } from "@/lib/notifications/inactivity";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";
import { scheduleSmartRemindersWithDatabase } from "@/lib/notifications/smart-reminders";
import { registerMailWorkerResources } from "@/lib/notifications/mail-worker-role";
import { requireMailWorkerRoleRuntime } from "@/lib/notifications/mail-worker-role-runtime";
import { requireMailDeliveryAuthorityRuntime } from "@/lib/notifications/mail-dispatch-runtime-startup";
import { accountMailEventIdempotencyKey, MAIL_IDEMPOTENCY_AUTHORITY_VERSION } from "@/lib/notifications/idempotency-authority";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";
import { validatedDisposableMailWorkerDatabaseUrl, validatedDisposableOwnerDatabaseTarget,
  DISPOSABLE_INTEGRATION_POOL_BOUNDS } from "../scripts/lib/disposable-integration-environment";

let mailPool: Pool;
let mailDatabase: ReturnType<typeof drizzle<typeof schema>>;
const userId = `mail-role-${randomUUID()}`;

beforeAll(async () => {
  const url = validatedDisposableMailWorkerDatabaseUrl(process.env);
  mailPool = new Pool({ connectionString: url, max: 2 });
  mailDatabase = drizzle(mailPool, { schema });
  registerMailWorkerResources(mailPool, mailDatabase, url);
  const transaction = mailDatabase.transaction.bind(mailDatabase);
  mailDatabase.transaction = (async (...args: Parameters<typeof transaction>) => {
    try { return await transaction(...args); }
    catch (error) {
      let cause: unknown = error;
      while (cause && typeof cause === "object" && "cause" in cause && cause.cause) cause = cause.cause;
      if (cause && typeof cause === "object") {
        const fields = cause as Error & { code?: string; table?: string; column?: string; routine?: string };
        console.error(JSON.stringify({ event: "mail.integration.transaction_failed", code: fields.code,
          table: fields.table, column: fields.column, routine: fields.routine }));
      }
      throw error;
    }
  }) as typeof mailDatabase.transaction;
});

afterAll(async () => {
  await mailPool?.end();
  await applicationPool.end();
});

describe("0074 mail worker PostgreSQL role", () => {
  it("reproduces the reviewed runtime inventory from PostgreSQL replay", async () => {
    const owner = new Pool({ ...DISPOSABLE_INTEGRATION_POOL_BOUNDS, max: 1,
      connectionString: validatedDisposableOwnerDatabaseTarget(process.env).databaseOwnerUrl });
    const client = await owner.connect();
    try {
      const modulePath = "../scripts/generate-mail-worker-0074-inventory.mjs";
      const { collectMailWorker0074Inventory } = await import(/* @vite-ignore */ modulePath) as {
        collectMailWorker0074Inventory(client: PoolClient): Promise<{ sha256: string }>;
      };
      expect((await collectMailWorker0074Inventory(client)).sha256)
        .toBe("9a0a41cd2c2bbc9c366a517c69e321f0ec58128bb7cca7f74b36bdad68143912");
    } finally { client.release(); await owner.end(); }
  });

  it("authenticates directly and satisfies the exact runtime capability proof", async () => {
    const client = await mailPool.connect();
    try {
      expect((await client.query("select current_user,session_user")).rows[0]).toEqual({
        current_user: "learncoding_mail_worker", session_user: "learncoding_mail_worker",
      });
      await client.query("begin isolation level repeatable read read only; set local search_path=pg_catalog,pg_temp; set local quote_all_identifiers=false");
      await requireMailWorkerRoleRuntime(client);
      const verdict = await requireMailDeliveryAuthorityRuntime({ query: async text => {
        const names = ["lineage_attestor_catalog", "receipt_relation_catalog", "receipt_columns",
          "receipt_default", "receipt_not_null_constraints", "receipt_constraints", "receipt_triggers",
          "receipt_relation_acl", "receipt_column_acl", "digest_helper_catalog", "issuer_catalog",
          "verifier_catalog", "outbox_runtime_catalog"];
        const fields = names.map(name => `'${name}',to_jsonb(${name})`).join(",");
        const probe = text.replace(") AS delivery_release_capability_exact",
          `) AS delivery_release_capability_exact, jsonb_build_object(${fields}) as proof`);
        const result = await client.query(probe);
        if (result.rows[0]?.delivery_release_capability_exact !== true) {
          console.error(JSON.stringify({ event: "mail.integration.authority_failed", proof: result.rows[0]?.proof }));
        }
        return result;
      } }, true);
      expect(verdict).toEqual({
        holdCatalogExact: true, deliveryReleaseCapabilityExact: true,
      });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("allows the complete column inventory and denies unrelated data and SET ROLE", async () => {
    const client = await mailPool.connect();
    try {
      const modulePath = "../infra/tests/mail-worker-0074-privileges.integration.mjs";
      const { verifyMailWorkerColumnPrivileges } = await import(/* @vite-ignore */ modulePath) as {
        verifyMailWorkerColumnPrivileges(client: PoolClient): Promise<{ assertions: number }>;
      };
      expect((await verifyMailWorkerColumnPrivileges(client)).assertions).toBe(45);
    } finally { client.release(); }
  });

  it("returns NULL for held release markers or any mismatched digest argument", async () => {
    const recipient = `mail-marker-${randomUUID()}`;
    const email = `${recipient}@integration.invalid`;
    await applicationPool.query(`insert into public."user" (id,name,email,role,status,email_verified)
      values ($1,'Marker fixture',$2,'learner','active',true)`, [recipient, email]);
    const client = await mailPool.connect();
    const digestSql = `select public.mail_worker_mail_delivery_release_receipt_sha256
      ($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text) as digest`;
    try {
      await client.query("begin");
      await client.query("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1)::bigint)",
        [userAuthorityLockKey(recipient)]);
      const inserted = await client.query(`insert into public.email_outbox
        (operation_id,user_id,delivery_scope_key,to_email,template,template_version,
          variables,idempotency_key,idempotency_authority_version,status,next_attempt_at)
        values ($1,$2,$3,$4,'weekly-summary','1',$5::jsonb,$6,$7,'pending',now())
        returning id,operation_id,idempotency_authority_version,idempotency_authority_sha256,
          idempotency_original_payload_sha256,delivery_hold_version`,
      [randomUUID(), recipient, `a:${recipient}`, email, JSON.stringify({ name: "Marker fixture", summary: "Fixture" }),
        accountMailEventIdempotencyKey({ eventId: randomUUID(), template: "weekly-summary", userId: recipient }),
        MAIL_IDEMPOTENCY_AUTHORITY_VERSION]);
      const row = inserted.rows[0];
      const args: unknown[] = [row.id, row.operation_id, row.idempotency_authority_version,
        row.idempotency_authority_sha256, row.idempotency_original_payload_sha256, row.delivery_hold_version];
      // The genuine INSERT triggers set the private markers. Do not disable
      // triggers, alter their guards, or grant the mail principal marker access.
      expect((await client.query(digestSql, args)).rows[0].digest).toBeNull();
      await client.query("savepoint marker_access");
      await expect(client.query(`select delivery_release_insert_xid,
        delivery_release_insert_system_identifier from public.email_outbox where id=$1`, [row.id]))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint marker_access");
      await client.query(`select * from public.mail_worker_release_email_outbox_delivery
        ($1::uuid,$2::uuid,$3::text,$4::text,$5::text)`,
      [row.id, row.operation_id, row.idempotency_authority_sha256,
        row.idempotency_original_payload_sha256, row.delivery_hold_version]);
      expect((await client.query(digestSql, args)).rows[0].digest).toMatch(/^[0-9a-f]{64}$/u);
      const wrong = [randomUUID(), randomUUID(), "wrong-v1", "a".repeat(64), "b".repeat(64), "wrong-v1"];
      for (let index = 0; index < args.length; index++) {
        for (const value of [wrong[index], null]) {
          const mismatch = [...args]; mismatch[index] = value;
          expect((await client.query(digestSql, mismatch)).rows[0].digest).toBeNull();
        }
      }
    } finally { await client.query("rollback"); client.release(); }
  });

  it("runs both reminder schedulers and atomically releases their outbox mail", async () => {
    await applicationPool.query(`insert into public."user"
      (id,name,email,role,status,email_verified,timezone,last_meaningful_activity_at)
      values ($1,'Mail role fixture',$2,'learner','active',true,'UTC',now()-interval '50 days')`,
    [userId, `${userId}@integration.invalid`]);
    await applicationPool.query(`insert into public.learner_profile(user_id,onboarding_completed_at)
      values ($1,now()-interval '50 days')`, [userId]);
    await applicationPool.query(`insert into public.notification_preference
      (user_id,timezone,learning_email_enabled,daily_study_enabled,daily_study_minute,quiet_hours_enabled)
      values ($1,'UTC',true,true,0,false)`, [userId]);
    await applicationPool.query(`insert into public.consent_record
      (user_id,purpose,policy_version,decision,source,idempotency_key)
      values ($1,'inactivity_mentor_notice',$2,'accepted','settings',$3)`,
    [userId, ENROLLMENT_DISCLOSURE_VERSION, randomUUID()]);

    const now = new Date();
    const inactivity = await scheduleInactivityReminders(now, mailPool);
    expect(inactivity.failed).toBe(0);
    expect(inactivity.learnerFirst).toBeGreaterThanOrEqual(1);
    const smart = await scheduleSmartRemindersWithDatabase(mailDatabase, now);
    expect(smart.failed).toBe(0);
    expect(smart.dispatched).toBeGreaterThanOrEqual(1);
    const rows = await mailPool.query(`select outbox.id,outbox.delivery_hold_version,
        receipt.outbox_id as released_id
      from public.email_outbox outbox left join public.mail_delivery_release_receipt receipt
        on receipt.outbox_id=outbox.id and receipt.operation_id=outbox.operation_id
      where outbox.user_id=$1`, [userId]);
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows.rows) {
      expect(row.released_id).toBe(row.id);
      expect(row.delivery_hold_version).toBe("task7-v1");
    }
    await expect(mailPool.query("select delivery_release_insert_xid from public.email_outbox"))
      .rejects.toMatchObject({ code: "42501" });
  });
});
