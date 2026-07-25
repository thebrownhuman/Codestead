import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import { emailOutbox, user } from "@/lib/db/schema";
import { truncateMutableApplicationTables } from "./helpers/truncate-application-tables";

const { Pool } = pg;
const SUCCESS_SUMMARY =
  "The nightly encrypted backup completed and passed local verification. No archive is attached to this email.";
const FAILURE_SUMMARY =
  "The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type AuthorityAcknowledgement = Readonly<{
  acknowledgement: "queued" | "existing";
  authority_id: string;
  outbox_id: string;
  operation_id: string;
}>;

function assertDisposableDatabase() {
  const ownerConnectionString = process.env.DATABASE_URL ?? "";
  const reporterConnectionString =
    process.env.DATABASE_BACKUP_REPORTER_URL ?? "";
  let ownerUrl: URL;
  let reporterUrl: URL;
  try {
    ownerUrl = new URL(ownerConnectionString);
    reporterUrl = new URL(reporterConnectionString);
  } catch {
    throw new Error(
      "Backup-status integration tests require canonical disposable database URLs.",
    );
  }
  if (
    process.env.INTEGRATION_TEST !== "1" ||
    ownerUrl.protocol !== "postgresql:" ||
    ownerUrl.hostname !== "127.0.0.1" ||
    ownerUrl.pathname !== "/learncoding_integration" ||
    reporterUrl.protocol !== "postgresql:" ||
    reporterUrl.username !== "learncoding_backup_reporter" ||
    reporterUrl.password.length === 0 ||
    reporterUrl.hostname !== ownerUrl.hostname ||
    reporterUrl.port !== ownerUrl.port ||
    reporterUrl.pathname !== ownerUrl.pathname ||
    reporterUrl.search !== "" ||
    reporterUrl.hash !== ""
  ) {
    throw new Error(
      "Backup-status integration tests require the disposable learncoding_integration database.",
    );
  }
  return reporterConnectionString;
}

const backupReporterPool = new Pool({
  connectionString: assertDisposableDatabase(),
  application_name: "codestead-backup-status-integration",
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 1_000,
  max: 1,
  statement_timeout: 5_000,
});

async function truncateApplicationTables() {
  assertDisposableDatabase();
  await truncateMutableApplicationTables(pool);
}

async function enqueueBackupStatus(runKey: string, outcome: string) {
  return backupReporterPool.query<AuthorityAcknowledgement>(
    `select acknowledgement,
            authority_id::text,
            outbox_id::text,
            operation_id::text
       from public.enqueue_backup_status_mail_authority($1::text, $2::text)`,
    [runKey, outcome],
  );
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
    backupReporterPool.end(),
    pool.end(),
  ]);
});

describe("nightly backup status outbox", () => {
  it("queues generic success/failure reports and replays an exact status idempotently", async () => {
    const successKey = "20260725T141500Z";
    const failureKey = "20260725T141501Z";

    const queuedSuccess = await enqueueBackupStatus(successKey, "success");
    const existingSuccess = await enqueueBackupStatus(successKey, "success");
    const queuedFailure = await enqueueBackupStatus(failureKey, "failure");

    expect(queuedSuccess.rows).toHaveLength(1);
    expect(queuedSuccess.rows[0]).toMatchObject({
      acknowledgement: "queued",
      authority_id: expect.stringMatching(UUID),
      outbox_id: expect.stringMatching(UUID),
      operation_id: expect.stringMatching(UUID),
    });
    expect(existingSuccess.rows).toEqual([{
      ...queuedSuccess.rows[0],
      acknowledgement: "existing",
    }]);
    expect(queuedFailure.rows).toEqual([
      expect.objectContaining({
        acknowledgement: "queued",
        authority_id: expect.stringMatching(UUID),
        outbox_id: expect.stringMatching(UUID),
        operation_id: expect.stringMatching(UUID),
      }),
    ]);

    const rows = await db.select().from(emailOutbox);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.idempotencyKey).sort()).toEqual([
      `backup-status:v1:${successKey}`,
      `backup-status:v1:${failureKey}`,
    ].sort());
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
    await expect(
      enqueueBackupStatus("20260725T141502Z", "failure"),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });
});
