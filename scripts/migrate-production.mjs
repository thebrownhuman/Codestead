import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { drizzle as createDrizzle } from "drizzle-orm/node-postgres";
import { migrate as migrateDatabase } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const MIGRATION_LOCK_NAME = "codestead:database-administration:v1";
const MAX_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_UNLOCK_TIMEOUT_MS = 5_000;
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

class MigrationUnlockTimeoutError extends Error {
  constructor() {
    super("Timed out releasing the production migration lock");
    this.name = "MigrationUnlockTimeoutError";
  }
}

class MigrationUnlockError extends Error {
  constructor() {
    super("PostgreSQL did not release the production migration lock");
    this.name = "MigrationUnlockError";
  }
}

class MigrationCleanupTimeoutError extends Error {
  constructor(phase = "session identity restoration") {
    super(`Timed out during production migration ${phase}`);
    this.name = "MigrationCleanupTimeoutError";
  }
}

function normalizeLockTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs)) {
    throw new RangeError("Production migration lock timeout must be finite");
  }
  return Math.min(timeoutMs, MAX_LOCK_TIMEOUT_MS);
}

function normalizeUnlockTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Production migration unlock timeout must be positive and finite");
  }
  return Math.min(timeoutMs, DEFAULT_UNLOCK_TIMEOUT_MS);
}

function normalizeCleanupTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Production migration cleanup timeout must be positive and finite");
  }
  return Math.min(timeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
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

async function queryMigrationUnlock(client, timeoutMs) {
  const deadline = monotonicNow() + timeoutMs;
  let timeoutHandle;
  const query = Promise.resolve().then(() =>
    client.query(UNLOCK_SQL, [MIGRATION_LOCK_NAME]),
  );
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new MigrationUnlockTimeoutError()),
      timeoutMs,
    );
  });

  try {
    const result = await Promise.race([query, timeout]);
    if (monotonicNow() >= deadline) throw new MigrationUnlockTimeoutError();
    if (result?.rows?.[0]?.released !== true) throw new MigrationUnlockError();
    return;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

async function boundedMigrationCleanup(operation, timeoutMs, phase) {
  const deadline = monotonicNow() + timeoutMs;
  let timeoutHandle;
  const task = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new MigrationCleanupTimeoutError(phase)),
      timeoutMs,
    );
  });

  try {
    const result = await Promise.race([task, timeout]);
    if (monotonicNow() >= deadline) throw new MigrationCleanupTimeoutError(phase);
    return result;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
async function queryMigrationCleanup(client, sql, timeoutMs) {
  return boundedMigrationCleanup(() => client.query(sql), timeoutMs, "session cleanup");
}


async function verifyMigrationIdentity(client, expectedCurrentUser, cleanupTimeoutMs) {
  const result = cleanupTimeoutMs === undefined
    ? await client.query("select current_user, session_user")
    : await queryMigrationCleanup(
      client,
    "select current_user, session_user",
      cleanupTimeoutMs,
    );
  const row = result?.rows?.[0];
  if (
    row?.current_user !== expectedCurrentUser ||
    row?.session_user !== "learncoding_migrator"
  ) {
    throw new Error("production migration role identity verification failed");
  }
}

export async function acquireMigrationLock(
  client,
  {
    timeoutMs = MAX_LOCK_TIMEOUT_MS,
    pollMs = 500,
    now = monotonicNow,
    sleep = delay,
  } = {},
) {
  const deadline = now() + normalizeLockTimeoutMs(timeoutMs);

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
  const unlockTimeoutMs = normalizeUnlockTimeoutMs(
    options.unlockTimeoutMs ?? DEFAULT_UNLOCK_TIMEOUT_MS,
  );
  const cleanupTimeoutMs = normalizeCleanupTimeoutMs(
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
  );
  let client;
  let lockAcquired = false;
  let destroyClient = false;

  let ownerRoleAssumed = false;
  try {
    client = await migrationPool.connect();
    try {
      await acquireMigrationLock(client, options.lockOptions);
      lockAcquired = true;
    } catch (error) {
      destroyClient = true;
      throw error;
    }
    await verifyMigrationIdentity(client, "learncoding_migrator");
    await client.query("SET ROLE learncoding_owner");
    ownerRoleAssumed = true;
    await verifyMigrationIdentity(client, "learncoding_owner");
    await migrate(drizzle(client), { migrationsFolder });
  } catch (error) {
    destroyClient = true;
    throw error;
  } finally {
    try {
      if (client && ownerRoleAssumed) {
        await queryMigrationCleanup(client, "RESET ROLE", cleanupTimeoutMs);
        await verifyMigrationIdentity(
          client,
          "learncoding_migrator",
          cleanupTimeoutMs,
        );
      }
      if (client && lockAcquired) {
        await queryMigrationUnlock(client, unlockTimeoutMs);
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
        await boundedMigrationCleanup(
          () => migrationPool.end(),
          cleanupTimeoutMs,
          "pool shutdown",
        );
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
