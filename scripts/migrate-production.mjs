import process from "node:process";
import { pathToFileURL } from "node:url";

import { drizzle as createDrizzle } from "drizzle-orm/node-postgres";
import { migrate as migrateDatabase } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const MIGRATION_LOCK_NAME = "codestead:production-migration:v1";
const TRY_LOCK_SQL = "select pg_try_advisory_lock(hashtextextended($1, 0)) acquired";
const UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended($1, 0)) released";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const lockTimeoutError = () => {
  const error = new Error("Timed out waiting for the production migration lock");
  error.name = "MigrationLockTimeoutError";
  return error;
};

export async function acquireMigrationLock(
  client,
  {
    timeoutMs = 120_000,
    pollMs = 500,
    now = Date.now,
    sleep = delay,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let attempted = false;

  while (true) {
    if (attempted && now() >= deadline) throw lockTimeoutError();
    attempted = true;

    const result = await client.query(TRY_LOCK_SQL, [MIGRATION_LOCK_NAME]);
    if (result.rows[0]?.acquired === true) return;

    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw lockTimeoutError();

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

  try {
    client = await migrationPool.connect();
    await acquireMigrationLock(client, options.lockOptions);
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    try {
      if (client) {
        await client.query(UNLOCK_SQL, [MIGRATION_LOCK_NAME]);
      }
    } finally {
      try {
        client?.release();
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
