import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import { emailOutbox, user } from "@/lib/db/schema";

const SUCCESS_SUMMARY =
  "The nightly encrypted backup completed and passed local verification. No archive is attached to this email.";
const FAILURE_SUMMARY =
  "The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (
    process.env.INTEGRATION_TEST !== "1" ||
    !/\/learncoding_integration(?:\?|$)/.test(connectionString)
  ) {
    throw new Error(
      "Backup-status integration tests require the disposable learncoding_integration database.",
    );
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows
    .map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`)
    .join(", ");
  await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

function productionOutboxSql() {
  const source = readFileSync(
    resolve(process.cwd(), "scripts", "backup", "common.sh"),
    "utf8",
  );
  const match = source.match(/cat <<'SQL'\r?\n(?<sql>[\s\S]*?)\r?\nSQL/);
  if (!match?.groups?.sql) {
    throw new Error("The production backup outbox SQL block could not be found.");
  }
  return match.groups.sql
    .replaceAll(":'report_outcome'", "$1")
    .replaceAll(":'report_key'", "$2");
}

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values({
    id: "backup-status-admin",
    publicId: "f1000000-0000-4000-8000-000000000001",
    name: "Backup Administrator",
    email: "backup-status-admin@integration.invalid",
    emailVerified: true,
    role: "admin",
    status: "active",
    banned: false,
    mustChangePassword: false,
  });
});

afterAll(async () => {
  await pool.end();
});

describe("nightly backup status outbox", () => {
  it("queues generic success/failure reports and replays an exact status idempotently", async () => {
    const sql = productionOutboxSql();
    const successKey = "a".repeat(64);
    const failureKey = "b".repeat(64);

    await expect(pool.query<{ case: string }>(sql, ["success", successKey]))
      .resolves.toMatchObject({ rows: [{ case: "queued" }] });
    await expect(pool.query<{ case: string }>(sql, ["success", successKey]))
      .resolves.toMatchObject({ rows: [{ case: "existing" }] });
    await expect(pool.query<{ case: string }>(sql, ["failure", failureKey]))
      .resolves.toMatchObject({ rows: [{ case: "queued" }] });

    const rows = await db.select().from(emailOutbox);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.idempotencyKey).sort()).toEqual([
      successKey,
      failureKey,
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "backup-status-admin",
          toEmail: "backup-status-admin@integration.invalid",
          template: "backup-status",
          templateVersion: "1",
          status: "pending",
          variables: { name: "administrator", summary: SUCCESS_SUMMARY },
        }),
        expect.objectContaining({
          variables: { name: "administrator", summary: FAILURE_SUMMARY },
        }),
      ]),
    );

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(
      /learncoding-full-|\.tar\.gz|database\.dump|AGE-SECRET-KEY|\/backup|\/srv\//i,
    );
  });

  it("fails closed instead of redirecting an operations report when no active administrator exists", async () => {
    await pool.query(`UPDATE "user" SET status = 'suspended' WHERE id = $1`, [
      "backup-status-admin",
    ]);
    const result = await pool.query<{ case: string }>(productionOutboxSql(), [
      "failure",
      "c".repeat(64),
    ]);
    expect(result.rows).toEqual([{ case: "no-admin" }]);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });
});
