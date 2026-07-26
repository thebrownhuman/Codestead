import { lstatSync, readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

const INVALID_INPUT = "backup status reporter input is invalid";
const INVALID_SECRET = "backup status reporter database secret is invalid";
const INVALID_POLICY = "backup status reporter policy is invalid";
const INVALID_ACKNOWLEDGEMENT =
  "backup status reporter acknowledgement is invalid";
const CONNECTION_TIMEOUT = "backup status reporter connection timed out";
const QUERY_TIMEOUT = "backup status reporter query timed out";
const SHUTDOWN_TIMEOUT = "backup status reporter pool shutdown timed out";
const REPORTER_USER = "learncoding_backup_reporter";
const MAX_SECRET_BYTES = 4_096;
const MIN_PASSWORD_BYTES = 32;
const MAX_PASSWORD_BYTES = 1_024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const BACKUP_RUN_KEY =
  /^(?:[0-9]{8}T[0-9]{6}Z|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

const POLICY_KEYS = Object.freeze({
  connectionTimeoutMillis:
    "BACKUP_STATUS_REPORTER_CONNECTION_TIMEOUT_MS",
  queryTimeoutMillis:
    "BACKUP_STATUS_REPORTER_QUERY_TIMEOUT_MS",
  statementTimeoutMillis:
    "BACKUP_STATUS_REPORTER_STATEMENT_TIMEOUT_MS",
  lockTimeoutMillis:
    "BACKUP_STATUS_REPORTER_LOCK_TIMEOUT_MS",
  idleInTransactionSessionTimeoutMillis:
    "BACKUP_STATUS_REPORTER_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  idleTimeoutMillis:
    "BACKUP_STATUS_REPORTER_POOL_IDLE_TIMEOUT_MS",
  shutdownTimeoutMillis:
    "BACKUP_STATUS_REPORTER_POOL_SHUTDOWN_TIMEOUT_MS",
});

const POLICY_MAXIMUMS = Object.freeze({
  connectionTimeoutMillis: 5_000,
  queryTimeoutMillis: 6_000,
  statementTimeoutMillis: 6_000,
  lockTimeoutMillis: 6_000,
  idleInTransactionSessionTimeoutMillis: 6_000,
  idleTimeoutMillis: 5_000,
  shutdownTimeoutMillis: 5_000,
});

function invalidInput() {
  return new Error(INVALID_INPUT);
}

function invalidSecret() {
  return new Error(INVALID_SECRET);
}

function invalidPolicy() {
  return new Error(INVALID_POLICY);
}

function parsePolicyInteger(environment, key, maximum) {
  const value = environment?.[key];
  if (
    typeof value !== "string"
    || !/^[1-9][0-9]{0,4}$/u.test(value)
  ) {
    throw invalidPolicy();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw invalidPolicy();
  }
  return parsed;
}

export function validateBackupStatusReporterPolicy(environment) {
  const policy = Object.fromEntries(
    Object.entries(POLICY_KEYS).map(([name, key]) => [
      name,
      parsePolicyInteger(environment, key, POLICY_MAXIMUMS[name]),
    ]),
  );
  if (
    policy.queryTimeoutMillis <= policy.statementTimeoutMillis
    || policy.statementTimeoutMillis <= policy.lockTimeoutMillis
  ) {
    throw invalidPolicy();
  }
  return Object.freeze(policy);
}

export function validateBackupStatusRequest(input) {
  if (
    !input
    || !["success", "failure"].includes(input.outcome)
    || typeof input.runKey !== "string"
    || !BACKUP_RUN_KEY.test(input.runKey)
  ) {
    throw invalidInput();
  }
  return Object.freeze({
    outcome: input.outcome,
    runKey: input.runKey,
  });
}

function decodeRequired(value) {
  const decoded = decodeURIComponent(value);
  if (!decoded || /[\u0000-\u0020\u007f]/u.test(decoded)) {
    throw invalidSecret();
  }
  return decoded;
}

export function validateReporterDatabaseUrl(value, databaseName) {
  try {
    if (
      typeof value !== "string"
      || value.length === 0
      || value.length > MAX_SECRET_BYTES
      || value !== value.trim()
      || !/^[a-z_][a-z0-9_]{0,62}$/u.test(databaseName)
    ) {
      throw invalidSecret();
    }
    const url = new URL(value);
    const username = decodeRequired(url.username);
    const password = decodeRequired(url.password);
    const database = decodeRequired(url.pathname.slice(1));
    const passwordBytes = Buffer.byteLength(password, "utf8");
    if (
      url.protocol !== "postgresql:"
      || username !== REPORTER_USER
      || passwordBytes < MIN_PASSWORD_BYTES
      || passwordBytes > MAX_PASSWORD_BYTES
      || url.hostname !== "postgres"
      || (url.port !== "" && url.port !== "5432")
      || database !== databaseName
      || url.pathname !== `/${encodeURIComponent(databaseName)}`
      || url.search !== ""
      || url.hash !== ""
    ) {
      throw invalidSecret();
    }
    return value;
  } catch {
    throw invalidSecret();
  }
}

export function readReporterDatabaseUrl(secretPath) {
  try {
    if (
      typeof secretPath !== "string"
      || secretPath.length === 0
      || secretPath.includes("\u0000")
    ) {
      throw invalidSecret();
    }
    const metadata = lstatSync(secretPath);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size < 1
      || metadata.size > MAX_SECRET_BYTES
    ) {
      throw invalidSecret();
    }
    const value = readFileSync(secretPath, "utf8");
    if (
      Buffer.byteLength(value, "utf8") !== metadata.size
      || value !== value.trim()
      || /[\u0000-\u0020\u007f]/u.test(value)
    ) {
      throw invalidSecret();
    }
    return value;
  } catch {
    throw invalidSecret();
  }
}

function createDeadlineTimer(dependencies, callback, timeoutMillis) {
  const schedule = dependencies.setTimeout ?? setTimeout;
  const timer = schedule(callback, timeoutMillis);
  return timer;
}

async function runWithinDeadline(
  action,
  timeoutMillis,
  timeoutMessage,
  dependencies,
  options = {},
) {
  let timer;
  let deadlineWon = false;
  const actionPromise = Promise.resolve().then(action);
  void actionPromise.then(
    (value) => {
      if (deadlineWon && options.onLateResolve) {
        try {
          void Promise.resolve(options.onLateResolve(value)).catch(() => {});
        } catch {
          // A cleanup failure cannot restore authority to the timed-out caller.
        }
      }
    },
    () => {
      // Promise.race observes the primary rejection; this handler also
      // consumes a rejection that arrives after the deadline won.
    },
  );
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = createDeadlineTimer(
      dependencies,
      () => {
        deadlineWon = true;
        reject(new Error(timeoutMessage));
      },
      timeoutMillis,
    );
  });
  try {
    return await Promise.race([actionPromise, timeoutPromise]);
  } finally {
    const cancel = dependencies.clearTimeout ?? clearTimeout;
    cancel(timer);
  }
}

function attachSecondaryFailure(primaryError, secondaryError) {
  try {
    if (
      primaryError
      && typeof primaryError === "object"
      && primaryError.cause === undefined
    ) {
      primaryError.cause = secondaryError;
    }
  } catch {
    // Preserve the original failure even when a non-extensible error is used.
  }
}

export async function enqueueBackupStatus(input, dependencies = {}) {
  const request = validateBackupStatusRequest(input);
  const policy = validateBackupStatusReporterPolicy(input.environment);
  const databaseUrl = validateReporterDatabaseUrl(
    input.databaseUrl,
    input.databaseName,
  );
  const createPool =
    dependencies.createPool
    ?? ((options) => new Pool(options));
  const pool = createPool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: policy.connectionTimeoutMillis,
    idleTimeoutMillis: policy.idleTimeoutMillis,
    query_timeout: policy.queryTimeoutMillis,
    statement_timeout: policy.statementTimeoutMillis,
    lock_timeout: policy.lockTimeoutMillis,
    idle_in_transaction_session_timeout:
      policy.idleInTransactionSessionTimeoutMillis,
    application_name: "codestead-backup-status-reporter",
  });

  let client;
  let primaryError;
  let destroyClient = false;
  let acknowledgement;
  try {
    client = await runWithinDeadline(
      () => pool.connect(),
      policy.connectionTimeoutMillis,
      CONNECTION_TIMEOUT,
      dependencies,
      {
        onLateResolve(lateClient) {
          if (lateClient?.release) {
            lateClient.release(true);
          }
        },
      },
    );
    const result = await runWithinDeadline(
      () => client.query(
        `select acknowledgement, authority_id::text, outbox_id::text, operation_id::text
           from public.enqueue_backup_status_mail_authority($1::text, $2::text)`,
        [request.runKey, request.outcome],
      ),
      policy.queryTimeoutMillis,
      QUERY_TIMEOUT,
      dependencies,
    );
    const row = result.rows?.[0];
    if (
      result.rowCount !== 1
      || result.rows?.length !== 1
      || !["queued", "existing"].includes(row?.acknowledgement)
      || !UUID.test(row?.authority_id ?? "")
      || !UUID.test(row?.outbox_id ?? "")
      || !UUID.test(row?.operation_id ?? "")
    ) {
      throw new Error(INVALID_ACKNOWLEDGEMENT);
    }
    acknowledgement = row.acknowledgement;
  } catch (error) {
    primaryError = error;
    destroyClient = client !== undefined;
  } finally {
    if (client) {
      try {
        client.release(destroyClient);
      } catch (releaseError) {
        if (primaryError) {
          attachSecondaryFailure(primaryError, releaseError);
        } else {
          primaryError = releaseError;
        }
      }
    }
    try {
      await runWithinDeadline(
        () => pool.end(),
        policy.shutdownTimeoutMillis,
        SHUTDOWN_TIMEOUT,
        dependencies,
      );
    } catch (shutdownError) {
      if (primaryError) {
        attachSecondaryFailure(primaryError, shutdownError);
      } else {
        primaryError = shutdownError;
      }
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  return acknowledgement;
}

export async function runBackupStatusReporter(
  environment = process.env,
  dependencies = {},
) {
  validateBackupStatusReporterPolicy(environment);
  const databaseName = environment.POSTGRES_DB ?? "learncoding";
  const databaseUrl = readReporterDatabaseUrl(
    environment.DATABASE_BACKUP_REPORTER_URL_FILE,
  );
  const acknowledgement = await enqueueBackupStatus({
    databaseUrl,
    databaseName,
    environment,
    outcome: environment.BACKUP_REPORT_OUTCOME,
    runKey: environment.BACKUP_REPORT_RUN_KEY,
  }, dependencies);
  process.stdout.write(`${acknowledgement}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runBackupStatusReporter().catch(() => {
    process.stderr.write("backup status reporter failed\n");
    process.exitCode = 1;
  });
}
