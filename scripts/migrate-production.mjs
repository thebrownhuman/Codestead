import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { drizzle as createDrizzle } from "drizzle-orm/node-postgres";
import { migrate as migrateDatabase } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import {
  verifyAppliedMigrationLedger as verifyAppliedMigrationLedgerContract,
  verifyReviewedMigrationRepository as verifyReviewedMigrationRepositoryContract,
} from "./lib/reviewed-migration-ledger.mjs";

const MIGRATION_LOCK_NAME = "codestead:database-administration:v1";
const MAX_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 55_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_UNLOCK_TIMEOUT_MS = 5_000;
const TRY_LOCK_SQL = "select pg_try_advisory_lock(hashtextextended($1, 0)) acquired";
const UNLOCK_SQL = "select pg_advisory_unlock(hashtextextended($1, 0)) released";
const PRODUCTION_POSTGRES_MAJOR = 17;
const TIMED_OUT_OPERATION_OUTCOME = Symbol(
  "timed-out-production-migration-outcome",
);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const monotonicNow = () => performance.now();

class ProductionPostgresVersionError extends Error {
  constructor() {
    super("Production migration requires PostgreSQL major 17.");
    this.name = "ProductionPostgresVersionError";
  }
}

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

class MigrationOperationTimeoutError extends Error {
  constructor() {
    super("Timed out during the checked-out production migration operation");
    this.name = "MigrationOperationTimeoutError";
  }
}

function preserveFailureWithAggregateCause(primaryFailure, cleanupFailures) {
  if (primaryFailure instanceof Error) {
    try {
      const hasExistingCause = "cause" in primaryFailure;
      const cleanupCause = hasExistingCause
        ? new AggregateError(
            cleanupFailures,
            "Production migration failed and cleanup was incomplete",
            { cause: primaryFailure.cause },
          )
        : new AggregateError(
            cleanupFailures,
            "Production migration failed and cleanup was incomplete",
          );
      Object.defineProperty(primaryFailure, "cause", {
        value: cleanupCause,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    } catch {
      // Never replace the primary failure because diagnostic attachment failed.
    }
    return primaryFailure;
  }

  const cleanupCause = new AggregateError(
    cleanupFailures,
    "Production migration failed and cleanup was incomplete",
  );
  const failure = new Error("Production migration failed", { cause: cleanupCause });
  failure.name = "UNKNOWN";
  return failure;
}

function attachLateCleanupEvidence(cleanupError, lateError) {
  try {
    Object.defineProperty(cleanupError, "cause", {
      value: lateError,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch {
    // The bounded cleanup-timeout evidence remains authoritative.
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

function normalizeOperationTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Production migration operation timeout must be positive and finite");
  }
  return Math.min(timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS);
}

function normalizeCleanupTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Production migration cleanup timeout must be positive and finite");
  }
  return Math.min(timeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
}

function createMigrationDeadline(timeoutMs) {
  return monotonicNow() + timeoutMs;
}

function remainingOperationDeadlineMs(deadline) {
  const remainingMs = deadline - monotonicNow();
  if (remainingMs <= 0) throw new MigrationOperationTimeoutError();
  return remainingMs;
}

function remainingCleanupDeadlineMs(deadline, phase) {
  const remainingMs = deadline - monotonicNow();
  if (remainingMs <= 0) throw new MigrationCleanupTimeoutError(phase);
  return remainingMs;
}

async function runCleanupWithinDeadline(operation, deadline, phase) {
  return boundedMigrationCleanup(
    operation,
    remainingCleanupDeadlineMs(deadline, phase),
    phase,
  );
}

async function shutdownPoolWithinDeadline(pool, deadline) {
  let shutdown;
  try {
    shutdown = Promise.resolve(pool.end());
  } catch (error) {
    throw error;
  }
  const immediate = {
    settled: false,
    status: undefined,
    value: undefined,
    error: undefined,
  };
  void shutdown.then(
    (value) => {
      immediate.settled = true;
      immediate.status = "fulfilled";
      immediate.value = value;
    },
    (error) => {
      immediate.settled = true;
      immediate.status = "rejected";
      immediate.error = error;
    },
  );
  await Promise.resolve();
  if (immediate.settled) {
    if (immediate.status === "rejected") throw immediate.error;
    if (monotonicNow() >= deadline) {
      throw new MigrationCleanupTimeoutError("pool shutdown");
    }
    return immediate.value;
  }
  const remainingMs = remainingCleanupDeadlineMs(
    deadline,
    "pool shutdown",
  );
  return boundedMigrationCleanup(
    () => shutdown,
    remainingMs,
    "pool shutdown",
  );
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

function observeMigrationOutcome(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
}

async function waitForMigrationOutcome(observed, timeoutMs) {
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ settled: false }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      observed.then((outcome) => ({ settled: true, outcome })),
      timeout,
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

async function runMigrationOperationWithinDeadline(
  client,
  operation,
  operationDeadline,
) {
  const observed = observeMigrationOutcome(
    Promise.resolve().then(operation),
  );
  const remainingMs = operationDeadline - monotonicNow();
  const initial = remainingMs > 0
    ? await waitForMigrationOutcome(observed, remainingMs)
    : { settled: false };
  if (initial.settled && monotonicNow() < operationDeadline) {
    if (initial.outcome.status === "rejected") throw initial.outcome.error;
    return initial.outcome.value;
  }

  const timeoutError = new MigrationOperationTimeoutError();
  try {
    client.connection?.stream?.destroy();
  } catch (error) {
    Object.defineProperty(timeoutError, "cause", {
      value: new AggregateError(
        [error],
        "Production migration session abort failed",
      ),
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(timeoutError, TIMED_OUT_OPERATION_OUTCOME, {
    value: observed,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  throw timeoutError;
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

async function requireProductionPostgresMajor(client, requiredMajor) {
  if (requiredMajor === undefined) return;
  if (requiredMajor !== PRODUCTION_POSTGRES_MAJOR) {
    throw new ProductionPostgresVersionError();
  }

  try {
    const result = await client.query(
      "select pg_catalog.current_setting('server_version_num') as server_version_num",
    );
    const versionNum = result?.rows?.length === 1
      ? result.rows[0]?.server_version_num
      : undefined;
    if (
      typeof versionNum !== "string"
      || !/^[1-9][0-9]{4,7}$/u.test(versionNum)
      || Math.floor(Number.parseInt(versionNum, 10) / 10_000) !== requiredMajor
    ) {
      throw new ProductionPostgresVersionError();
    }
  } catch {
    throw new ProductionPostgresVersionError();
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
  const verifyReviewedMigrationRepository =
    options.verifyReviewedMigrationRepository ??
    verifyReviewedMigrationRepositoryContract;
  const verifyAppliedMigrationLedger =
    options.verifyAppliedMigrationLedger ?? verifyAppliedMigrationLedgerContract;
  const migrationsFolder = options.migrationsFolder ?? "/app/drizzle";
  const unlockTimeoutMs = normalizeUnlockTimeoutMs(
    options.unlockTimeoutMs ?? DEFAULT_UNLOCK_TIMEOUT_MS,
  );
  const cleanupTimeoutMs = normalizeCleanupTimeoutMs(
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
  );
  const operationTimeoutMs = normalizeOperationTimeoutMs(
    options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
  );
  const operationDeadline = createMigrationDeadline(operationTimeoutMs);
  let client;
  let lockAcquired = false;
  let destroyClient = false;
  let primaryFailure;
  let hasPrimaryFailure = false;
  const cleanupFailures = [];
  let ownerRoleAssumed = false;
  let sessionAmbiguous = false;
  let timedOutCheckoutOutcome;

  try {
    const observedCheckout = observeMigrationOutcome(
      Promise.resolve().then(() => migrationPool.connect()),
    );
    const checkout = await waitForMigrationOutcome(
      observedCheckout,
      remainingOperationDeadlineMs(operationDeadline),
    );
    if (!checkout.settled || monotonicNow() >= operationDeadline) {
      timedOutCheckoutOutcome = observedCheckout;
      throw new MigrationOperationTimeoutError();
    }
    if (checkout.outcome.status === "rejected") {
      throw checkout.outcome.error;
    }
    client = checkout.outcome.value;
    await runMigrationOperationWithinDeadline(
      client,
      async () => {
        await requireProductionPostgresMajor(
          client,
          options.requiredPostgresMajor,
        );
        try {
          await acquireMigrationLock(client, options.lockOptions);
          lockAcquired = true;
        } catch (error) {
          destroyClient = true;
          throw error;
        }
        await verifyMigrationIdentity(client, "learncoding_migrator");
        verifyReviewedMigrationRepository({ drizzleDirectory: migrationsFolder });
        await client.query("SET ROLE learncoding_owner");
        ownerRoleAssumed = true;
        await verifyMigrationIdentity(client, "learncoding_owner");
        await verifyAppliedMigrationLedger(client, {
          requireComplete: false,
        });
        await migrate(drizzle(client), { migrationsFolder });
        await verifyAppliedMigrationLedger(client, {
          requireComplete: true,
        });
      },
      operationDeadline,
    );
  } catch (error) {
    destroyClient = true;
    sessionAmbiguous = error instanceof MigrationOperationTimeoutError;
    hasPrimaryFailure = true;
    primaryFailure = error;
  }

  const cleanupDeadline = createMigrationDeadline(cleanupTimeoutMs);
  const shutdownReserveMs = Math.min(
    cleanupTimeoutMs * 0.8,
    Math.max(10, cleanupTimeoutMs * 0.2),
  );
  if (timedOutCheckoutOutcome !== undefined) {
    const remainingMs = cleanupDeadline - monotonicNow();
    const settlementMs = Math.max(0, remainingMs - shutdownReserveMs);
    const lateCheckout = settlementMs > 0
      ? await waitForMigrationOutcome(
          timedOutCheckoutOutcome,
          settlementMs,
        )
      : { settled: false };
    if (lateCheckout.settled) {
      if (lateCheckout.outcome.status === "rejected") {
        cleanupFailures.push(lateCheckout.outcome.error);
      } else {
        try {
          lateCheckout.outcome.value.release(true);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    } else {
      const checkoutSettlementError = new MigrationCleanupTimeoutError(
        "pool checkout settlement",
      );
      cleanupFailures.push(checkoutSettlementError);
      void timedOutCheckoutOutcome.then((outcome) => {
        if (outcome.status === "rejected") {
          attachLateCleanupEvidence(
            checkoutSettlementError,
            outcome.error,
          );
          return;
        }
        try {
          outcome.value.release(true);
        } catch (error) {
          attachLateCleanupEvidence(checkoutSettlementError, error);
        }
      });
    }
  }
  const timedOutOperationOutcome = (
    primaryFailure instanceof MigrationOperationTimeoutError
  )
    ? primaryFailure[TIMED_OUT_OPERATION_OUTCOME]
    : undefined;
  if (timedOutOperationOutcome !== undefined) {
    const remainingMs = cleanupDeadline - monotonicNow();
    const settlementMs = Math.max(0, remainingMs - shutdownReserveMs);
    if (settlementMs > 0) {
      await waitForMigrationOutcome(timedOutOperationOutcome, settlementMs);
    }
  }

  try {
    if (client && ownerRoleAssumed && !sessionAmbiguous) {
      await runCleanupWithinDeadline(
        () => client.query("RESET ROLE"),
        cleanupDeadline,
        "session role reset",
      );
      await runCleanupWithinDeadline(
        () => verifyMigrationIdentity(client, "learncoding_migrator"),
        cleanupDeadline,
        "session identity restoration",
      );
    }
    if (client && lockAcquired && !sessionAmbiguous) {
      await queryMigrationUnlock(
        client,
        Math.min(
          unlockTimeoutMs,
          remainingCleanupDeadlineMs(
            cleanupDeadline,
            "advisory lock release",
          ),
        ),
      );
    }
  } catch (error) {
    destroyClient = true;
    cleanupFailures.push(error);
  }

  try {
    if (client) {
      if (destroyClient) client.release(true);
      else client.release();
    }
  } catch (error) {
    cleanupFailures.push(error);
  }

  try {
    await shutdownPoolWithinDeadline(migrationPool, cleanupDeadline);
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (hasPrimaryFailure) {
    if (cleanupFailures.length === 0) throw primaryFailure;
    if (timedOutCheckoutOutcome !== undefined) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        "Production migration checkout timed out and cleanup was incomplete",
        { cause: primaryFailure },
      );
    }
    throw preserveFailureWithAggregateCause(
      primaryFailure,
      cleanupFailures,
    );
  }

  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    const outwardFailure = cleanupFailures[cleanupFailures.length - 1];
    const relatedFailures = cleanupFailures.slice(0, -1);
    throw preserveFailureWithAggregateCause(outwardFailure, relatedFailures);
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (process.env.REQUIRE_POSTGRES_MAJOR !== String(PRODUCTION_POSTGRES_MAJOR)) {
    throw new ProductionPostgresVersionError();
  }

  await runProductionMigration({
    connectionString,
    requiredPostgresMajor: PRODUCTION_POSTGRES_MAJOR,
  });
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
