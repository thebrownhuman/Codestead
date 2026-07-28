import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool as PgPool, type Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { validatedDisposableOwnerDatabaseTarget } from
  "../scripts/lib/disposable-integration-environment";
import { pool } from "@/lib/db/client";
import { resetDisposableIntegrationDatabase } from
  "./support/reset-disposable-database";
import {
  readValidatedIntegrationMigrationJournal,
  withValidatedOwnerFaultInjection,
} from "./support/with-validated-owner-fault-injection";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKSPACE_MIGRATIONS_FOLDER = path.resolve(WORKSPACE_ROOT, "drizzle");
const SEEDED_USER_ID = "disposable-reset-proof-user";
const SEEDED_USER_EMAIL = "disposable-reset-proof@integration.invalid";
const ADVISORY_LOCK_SQL =
  "SELECT pg_catalog.pg_advisory_xact_lock(1129272147, 1381254228)";
const RESET_ACTIVITY_SQL = `
  WITH expected(pid) AS (
    SELECT pg_catalog.unnest($1::pg_catalog.int4[])
  )
  SELECT pg_catalog.count(activity.pid)::integer AS observed_count,
         pg_catalog.count(*) FILTER (
           WHERE activity.state = 'active'
             AND pg_catalog.btrim(activity.query)
                   = 'select codestead_disposable_test.reset_database()'
         )::integer AS active_reset_count,
         NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_locks AS caller_lock
            WHERE caller_lock.pid = ANY($1::pg_catalog.int4[])
              AND caller_lock.locktype = 'advisory'
              AND caller_lock.classid = 1129272147::pg_catalog.oid
              AND caller_lock.objid = 1381254228::pg_catalog.oid
              AND caller_lock.granted
         ) AS callers_do_not_hold_reset_lock,
         EXISTS (
           SELECT 1
             FROM pg_catalog.pg_locks AS blocker_lock
            WHERE blocker_lock.pid = pg_catalog.pg_backend_pid()
              AND blocker_lock.locktype = 'advisory'
              AND blocker_lock.classid = 1129272147::pg_catalog.oid
              AND blocker_lock.objid = 1381254228::pg_catalog.oid
              AND blocker_lock.granted
         ) AS blocker_holds_reset_lock
    FROM expected
    LEFT JOIN pg_catalog.pg_stat_activity AS activity
      ON activity.pid = expected.pid
     AND activity.datname = current_database()
     AND activity.usename = session_user
`;
const RESET_ACTIVITY_DEADLINE_MS = 5_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`reset integration proof requires ${name}`);
  return value;
}

function rolePool(environmentName: string, applicationName: string): Pool {
  return new PgPool({
    application_name: applicationName,
    connectionString: requiredEnvironment(environmentName),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    max: 2,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  });
}

const migratorPool = rolePool(
  "DATABASE_MIGRATOR_URL",
  "codestead.integration-reset-proof-migrator",
);
const workerPool = rolePool(
  "DATABASE_WORKER_URL",
  "codestead.integration-reset-proof-worker",
);
const opsPool = rolePool(
  "DATABASE_OPS_URL",
  "codestead.integration-reset-proof-ops",
);
const backupReporterPool = rolePool(
  "DATABASE_BACKUP_REPORTER_URL",
  "codestead.integration-reset-proof-backup-reporter",
);


async function seedPublicRow(): Promise<void> {
  await pool.query(`
    INSERT INTO public."user" (id, name, email, status)
    VALUES ($1, 'Disposable reset proof', $2, 'active')
  `, [SEEDED_USER_ID, SEEDED_USER_EMAIL]);
}

async function seededPublicRowCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(`
    SELECT pg_catalog.count(*)::text AS count
      FROM public."user"
     WHERE id = $1
  `, [SEEDED_USER_ID]);
  return Number(result.rows[0]?.count ?? "-1");
}

async function migrationJournalCount(): Promise<number> {
  return readValidatedIntegrationMigrationJournal({
    databaseTarget: validatedDisposableOwnerDatabaseTarget(process.env),
    migrationsFolder: WORKSPACE_MIGRATIONS_FOLDER,
  });
}

async function waitForActiveResetCallers(
  client: PoolClient,
  expectedPids: readonly [number, number],
): Promise<void> {
  const deadline = Date.now() + RESET_ACTIVITY_DEADLINE_MS;
  while (Date.now() < deadline) {
    const result = await client.query<{
      observed_count: number;
      active_reset_count: number;
      callers_do_not_hold_reset_lock: boolean;
      blocker_holds_reset_lock: boolean;
    }>(
      RESET_ACTIVITY_SQL,
      [[...expectedPids]],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1
      || !Number.isSafeInteger(row?.observed_count)
      || !Number.isSafeInteger(row.active_reset_count)
      || typeof row.callers_do_not_hold_reset_lock !== "boolean"
      || typeof row.blocker_holds_reset_lock !== "boolean"
    ) {
      throw new Error("reset integration activity observation was malformed");
    }
    if (
      row.observed_count === expectedPids.length
      && row.active_reset_count === expectedPids.length
      && row.callers_do_not_hold_reset_lock
      && row.blocker_holds_reset_lock
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("reset integration callers were not observed before deadline");
}

type TriggerSnapshot = Readonly<{
  trigger_modes: Record<string, string>;
}>;

async function triggerSnapshot(): Promise<TriggerSnapshot> {
  const result = await pool.query<TriggerSnapshot>(`
    SELECT pg_catalog.jsonb_object_agg(
             trigger_row.tgname,
             trigger_row.tgenabled::pg_catalog.text
             ORDER BY trigger_row.tgname
           ) AS trigger_modes
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE (trigger_row.tgrelid, trigger_row.tgname) IN (
       (
         'public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_no_truncate'
       ),
       (
         'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
         'email_outbox_idempotency_no_truncate'
       ),
       (
         'public.mail_delivery_release_receipt'::pg_catalog.regclass,
         'mail_delivery_release_receipt_no_truncate'
       )
     )
  `);
  const row = result.rows[0];
  if (!row) throw new Error("reset integration trigger snapshot is missing");
  return row;
}

async function expectPrivilegeDenied(operation: Promise<unknown>) {
  let thrown: unknown;
  try {
    await operation;
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { code?: unknown } | undefined)?.code).toBe("42501");
}

async function closePool(selectedPool: Pool): Promise<void> {
  await selectedPool.end();
}

beforeAll(async () => {
  const version = await pool.query<{ server_version_num: string }>(
    "SHOW server_version_num",
  );
  const versionNumber = Number(version.rows[0]?.server_version_num);
  expect(Number.isSafeInteger(versionNumber)).toBe(true);
  expect(Math.floor(versionNumber / 10_000)).toBe(17);
});

beforeEach(async () => {
  await resetDisposableIntegrationDatabase(pool);
});

afterAll(async () => {
  await Promise.all([
    closePool(migratorPool),
    closePool(workerPool),
    closePool(opsPool),
    closePool(backupReporterPool),
    closePool(pool),
  ]);
});

describe.sequential("disposable integration reset authority", () => {
  it("clears public application data without changing the migration ledger", async () => {
    const journalBefore = await migrationJournalCount();
    expect(journalBefore).toBeGreaterThan(0);
    await seedPublicRow();
    expect(await seededPublicRowCount()).toBe(1);

    await resetDisposableIntegrationDatabase(pool);

    expect(await seededPublicRowCount()).toBe(0);
    expect(await migrationJournalCount()).toBe(journalBefore);
    expect(await triggerSnapshot()).toEqual({
      trigger_modes: {
        backup_status_mail_authority_no_truncate: "O",
        email_outbox_idempotency_no_truncate: "A",
        mail_delivery_release_receipt_no_truncate: "A",
      },
    });
  });

  it("denies reset access to every reviewed non-app login role", async () => {
    for (const deniedPool of [
      migratorPool,
      workerPool,
      opsPool,
      backupReporterPool,

    ]) {
      await expect(
        resetDisposableIntegrationDatabase(deniedPool),
      ).rejects.toThrow(
        "disposable integration reset caller identity mismatch",
      );
      await expectPrivilegeDenied(deniedPool.query(
        "SELECT codestead_disposable_test.reset_database()",
      ));
    }
  });

  it("rejects a hostile extra reset-namespace object before truncation", async () => {
    await seedPublicRow();

    await withValidatedOwnerFaultInjection({
      databaseTarget: validatedDisposableOwnerDatabaseTarget(process.env),
      context: "disposable reset namespace closed world",
      installSql: [
        "CREATE COLLATION codestead_disposable_test.hostile_reset_collation (provider = libc, locale = 'C')",
      ],
      cleanupSql: [
        "DROP COLLATION IF EXISTS codestead_disposable_test.hostile_reset_collation",
      ],
      run: async () => {
        await expect(
          resetDisposableIntegrationDatabase(pool),
        ).rejects.toThrow(
          "disposable integration reset guard contract mismatch",
        );
        expect(await seededPublicRowCount()).toBe(1);
      },
    });

    await resetDisposableIntegrationDatabase(pool);
    expect(await seededPublicRowCount()).toBe(0);
  });

  it("rejects a hostile outgoing reset-function dependency before truncation", async () => {
    const journalBefore = await migrationJournalCount();
    await seedPublicRow();

    await withValidatedOwnerFaultInjection({
      databaseTarget: validatedDisposableOwnerDatabaseTarget(process.env),
      context: "disposable reset outgoing dependency closed world",
      installSql: [
        "ALTER FUNCTION codestead_disposable_test.reset_database() DEPENDS ON EXTENSION plpgsql",
      ],
      cleanupSql: [
        "ALTER FUNCTION codestead_disposable_test.reset_database() NO DEPENDS ON EXTENSION plpgsql",
      ],
      run: async () => {
        let thrown: unknown;
        try {
          await resetDisposableIntegrationDatabase(pool);
        } catch (error) {
          thrown = error;
        }
        expect((thrown as { code?: unknown } | undefined)?.code).toBe("23514");
        expect((thrown as { message?: unknown } | undefined)?.message).toContain(
          "disposable integration reset guard contract mismatch",
        );
        expect(await seededPublicRowCount()).toBe(1);
        expect(await migrationJournalCount()).toBe(journalBefore);
      },
    });

    await resetDisposableIntegrationDatabase(pool);
    expect(await seededPublicRowCount()).toBe(0);
    expect(await migrationJournalCount()).toBe(journalBefore);
  });

  it("serializes concurrent app resets behind the bounded advisory lock", async () => {
    const journalBefore = await migrationJournalCount();
    await seedPublicRow();
    const blocker = await pool.connect();
    const firstCallerPool = rolePool(
      "DATABASE_APP_URL",
      "codestead.integration-reset-concurrency-first",
    );
    const secondCallerPool = rolePool(
      "DATABASE_APP_URL",
      "codestead.integration-reset-concurrency-second",
    );
    const firstClient = await firstCallerPool.connect();
    const secondClient = await secondCallerPool.connect();
    let firstHandedOff = false;
    let secondHandedOff = false;
    let blockerFinished = false;
    let firstSettled = false;
    let secondSettled = false;
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    let primaryFailure: { error: unknown } | undefined;
    const cleanupFailures: unknown[] = [];
    try {
      const firstPidResult = await firstClient.query<{ pid: number }>(
        "SELECT pg_catalog.pg_backend_pid()::integer AS pid",
      );
      const secondPidResult = await secondClient.query<{ pid: number }>(
        "SELECT pg_catalog.pg_backend_pid()::integer AS pid",
      );
      const firstPid = firstPidResult.rows[0]?.pid;
      const secondPid = secondPidResult.rows[0]?.pid;
      if (
        firstPidResult.rows.length !== 1
        || secondPidResult.rows.length !== 1
        || !Number.isSafeInteger(firstPid)
        || !Number.isSafeInteger(secondPid)
        || firstPid === secondPid
      ) {
        throw new Error("reset integration caller PIDs were not exact");
      }

      await blocker.query("BEGIN");
      await blocker.query(ADVISORY_LOCK_SQL);

      firstHandedOff = true;
      first = resetDisposableIntegrationDatabase({
        connect: async () => firstClient,
      }).finally(() => {
        firstSettled = true;
      });
      secondHandedOff = true;
      second = resetDisposableIntegrationDatabase({
        connect: async () => secondClient,
      }).finally(() => {
        secondSettled = true;
      });
      void first.catch(() => undefined);
      void second.catch(() => undefined);

      await waitForActiveResetCallers(blocker, [firstPid, secondPid]);
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      await blocker.query("COMMIT");
      blockerFinished = true;
      await Promise.all([first, second]);
    } catch (error) {
      primaryFailure = { error };
    } finally {
      let destroyBlocker = false;
      if (!blockerFinished) {
        try {
          await blocker.query("ROLLBACK");
          blockerFinished = true;
        } catch (error) {
          cleanupFailures.push(error);
          destroyBlocker = true;
        }
      }
      try {
        blocker.release(destroyBlocker);
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (!firstHandedOff) {
        try {
          firstClient.release();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      if (!secondHandedOff) {
        try {
          secondClient.release();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      const resetResults = await Promise.allSettled(
        [first, second].filter(
          (operation): operation is Promise<void> => operation !== undefined,
        ),
      );
      for (const resetResult of resetResults) {
        if (
          resetResult.status === "rejected"
          && !Object.is(resetResult.reason, primaryFailure?.error)
        ) {
          cleanupFailures.push(resetResult.reason);
        }
      }
      for (const callerPool of [firstCallerPool, secondCallerPool]) {
        try {
          await callerPool.end();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }

    if (primaryFailure !== undefined && cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure.error, ...cleanupFailures],
        "reset concurrency proof and cleanup failed",
        { cause: primaryFailure.error },
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure.error;
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(
        cleanupFailures,
        "reset concurrency proof cleanup failed",
      );
    }

    expect(await seededPublicRowCount()).toBe(0);
    expect(await migrationJournalCount()).toBe(journalBefore);
  });
  it("rolls back a faulted TRUNCATE, restores guards, and accepts a clean retry", async () => {
    const before = await triggerSnapshot();
    await seedPublicRow();

    await withValidatedOwnerFaultInjection({
      databaseTarget: validatedDisposableOwnerDatabaseTarget(process.env),
      context: "disposable reset truncate rollback",
      installSql: [
        `CREATE FUNCTION public.fail_reset_truncate()
         RETURNS pg_catalog.trigger
         LANGUAGE plpgsql
         SECURITY INVOKER
         SET search_path = pg_catalog
         AS $fault$
         BEGIN
           RAISE EXCEPTION 'injected disposable reset truncate failure'
             USING ERRCODE = '55000';
         END
         $fault$`,
        `CREATE TRIGGER disposable_reset_truncate_failure
         BEFORE TRUNCATE ON public."user"
         FOR EACH STATEMENT
         EXECUTE FUNCTION public.fail_reset_truncate()`,
      ],
      cleanupSql: [
        `DROP TRIGGER IF EXISTS disposable_reset_truncate_failure
           ON public."user"`,
        "DROP FUNCTION IF EXISTS public.fail_reset_truncate()",
      ],
      run: async () => {
        await expect(
          resetDisposableIntegrationDatabase(pool),
        ).rejects.toThrow("injected disposable reset truncate failure");
        expect(await seededPublicRowCount()).toBe(1);
        expect(await triggerSnapshot()).toEqual(before);
      },
    });

    await resetDisposableIntegrationDatabase(pool);
    expect(await seededPublicRowCount()).toBe(0);
    expect(await triggerSnapshot()).toEqual(before);
  });
});