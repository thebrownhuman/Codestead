import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

import { db, pool } from "@/lib/db/client";
import { emailOutbox, user } from "@/lib/db/schema";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";
import {
  acquireValidatedDisposableRoleClient,
  DISPOSABLE_INTEGRATION_POOL_BOUNDS,
  endDisposableIntegrationPoolWithinDeadline,
  validatedDisposableBackupReporterEnvironment,
} from "../scripts/lib/disposable-integration-environment";

const SUCCESS_SUMMARY =
  "The nightly encrypted backup completed and passed local verification. No archive is attached to this email.";
const FAILURE_SUMMARY =
  "The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.";

async function truncateApplicationTables() {
  await resetDisposableIntegrationDatabase(pool);
}

const backupReporterEnvironment =
  validatedDisposableBackupReporterEnvironment(process.env);
const reporterPool = new Pool({
  ...DISPOSABLE_INTEGRATION_POOL_BOUNDS,
  application_name: "codestead_integration_backup_status_reporter",
  connectionString: backupReporterEnvironment.databaseBackupReporterUrl,
  max: 1,
});
const PRODUCTION_OUTBOX_SQL = `
  SELECT acknowledgement, authority_id::text, outbox_id::text,
         operation_id::text
    FROM public.enqueue_backup_status_mail_authority($1::text, $2::text)
`;

async function queryBackupReporter(values: [string, string]) {
  const reporterClient: PoolClient =
    await acquireValidatedDisposableRoleClient(
      reporterPool,
      "learncoding_backup_reporter",
    );
  try {
    return await reporterClient.query(PRODUCTION_OUTBOX_SQL, values);
  } finally {
    reporterClient.release();
  }
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
  await Promise.all([
    endDisposableIntegrationPoolWithinDeadline(reporterPool),
    endDisposableIntegrationPoolWithinDeadline(pool),
  ]);
});

describe("nightly backup status outbox", () => {
  it("queues generic success/failure reports and replays an exact status idempotently", async () => {
    const successRunKey = "20990101T000000Z";
    const failureRunKey = "20990101T000001Z";

    await expect(queryBackupReporter([
      successRunKey,
      "success",
    ])).resolves.toMatchObject({
      rows: [expect.objectContaining({ acknowledgement: "queued" })],
    });
    await expect(queryBackupReporter([
      successRunKey,
      "success",
    ])).resolves.toMatchObject({
      rows: [expect.objectContaining({ acknowledgement: "existing" })],
    });
    await expect(queryBackupReporter([
      failureRunKey,
      "failure",
    ])).resolves.toMatchObject({
      rows: [expect.objectContaining({ acknowledgement: "queued" })],
    });

    const rows = await db.select().from(emailOutbox);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.idempotencyKey).sort()).toEqual([
      `backup-status:v1:${successRunKey}`,
      `backup-status:v1:${failureRunKey}`,
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "backup-status-admin",
          toEmail: "backup-status-admin@integration.invalid",
          template: "backup-status",
          templateVersion: "1",
          status: "pending",
          variables: { name: "Administrator", summary: SUCCESS_SUMMARY },
        }),
        expect.objectContaining({
          variables: { name: "Administrator", summary: FAILURE_SUMMARY },
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
    await expect(queryBackupReporter([
      "20990101T000002Z",
      "failure",
    ])).rejects.toMatchObject({ code: "23514" });
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });
});
