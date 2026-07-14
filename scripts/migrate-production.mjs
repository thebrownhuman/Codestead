import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { drizzle as createDrizzle } from "drizzle-orm/node-postgres";
import { migrate as migrateDatabase } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const MIGRATION_LOCK_NAME = "codestead:production-migration:v1";
const TRY_LOCK_SQL = "select pg_try_advisory_lock(hashtextextended($1, 0)) acquired";
const UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended($1, 0)) released";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const monotonicNow = () => performance.now();

class MigrationLockTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for the production migration lock");
    this.name = "MigrationLockTimeoutError";
  }
}

async function queryMigrationLock(client, remainingMs) {
  let timeoutHandle;
  const query = Promise.resolve().then(() =>
    client.query(TRY_LOCK_SQL, [MIGRATION_LOCK_NAME]),
  );
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new MigrationLockTimeoutError()),
      remainingMs,
    );
  });

  try {
    return await Promise.race([query, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export async function acquireMigrationLock(
  client,
  {
    timeoutMs = 120_000,
    pollMs = 500,
    now = monotonicNow,
    sleep = delay,
  } = {},
) {
  const deadline = now() + timeoutMs;

  while (true) {
    const queryTimeMs = deadline - now();
    if (queryTimeMs <= 0) throw new MigrationLockTimeoutError();

    let result;
    try {
      result = await queryMigrationLock(client, queryTimeMs);
    } catch (error) {
      if (!(error instanceof MigrationLockTimeoutError) && now() >= deadline) {
        throw new MigrationLockTimeoutError();
      }
      throw error;
    }
    if (now() >= deadline) throw new MigrationLockTimeoutError();
    if (result.rows[0]?.acquired === true) return;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new MigrationLockTimeoutError();

    await sleep(Math.min(pollMs, remainingMs));
  }
}

export async function runProductionMigration(options) {
  const migrationPool =
    options.pool ?? new Pool({ connectionString: options.connectionString, max: 1 });
  const drizzle = options.drizzle ?? createDrizzle;
  const migrate = options.migrate ?? migrateDatabase;
  const migrationsFolder = options.migrationsFolder ?? "/app/drizzle";
  let client;
  let lockAcquired = false;
  let destroyClient = false;

  try {
    client = await migrationPool.connect();
    try {
      await acquireMigrationLock(client, options.lockOptions);
      lockAcquired = true;
    } catch (error) {
      destroyClient = true;
      throw error;
    }
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    try {
      if (client && lockAcquired) {
        await client.query(UNLOCK_SQL, [MIGRATION_LOCK_NAME]);
      }
    } catch (error) {
      destroyClient = true;
      throw error;
    } finally {
      try {
        if (client) {
          if (destroyClient) client.release(true);
          else client.release();
        }
      } finally {
        await migrationPool.end();
      }
    }
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  await runProductionMigration({ connectionString });
  console.info(JSON.stringify({ event: "database.migrated" }));
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: "database.migration_failed",
        code: error instanceof Error ? error.name : "UNKNOWN",
      }),
    );
    process.exitCode = 1;
  });
}
