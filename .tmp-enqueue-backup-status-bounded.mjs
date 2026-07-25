import { lstatSync, readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

const INVALID_INPUT = "backup status reporter input is invalid";
const INVALID_SECRET = "backup status reporter database secret is invalid";
const INVALID_ACKNOWLEDGEMENT =
  "backup status reporter acknowledgement is invalid";
const POOL_SHUTDOWN_TIMEOUT =
  "backup status reporter pool shutdown timed out";
const REPORTER_USER = "learncoding_backup_reporter";
const MAX_SECRET_BYTES = 4_096;
const MIN_PASSWORD_BYTES = 32;
const MAX_PASSWORD_BYTES = 1_024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const BACKUP_STATUS_REPORTER_POOL_POLICY = Object.freeze({
  max: 1,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 2_000,
  query_timeout: 10_000,
  statement_timeout: 8_000,
  lock_timeout: 3_000,
  idle_in_transaction_session_timeout: 8_000,
  application_name: "codestead-backup-status-reporter",
});
export const BACKUP_STATUS_REPORTER_SHUTDOWN_TIMEOUT_MS = 2_000;

function invalidInput() {
  return new Error(INVALID_INPUT);
}

function invalidSecret() {
  return new Error(INVALID_SECRET);
}

export function validateBackupStatusRequest(input) {
  if (
    !input
    || !["success", "failure"].includes(input.outcome)
    || typeof input.runKey !== "string"
    || !/^[0-9]{8}T[0-9]{6}Z$/u.test(input.runKey)
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

async function endPoolWithinDeadline(pool, dependencies) {
  const scheduleTimeout =
    dependencies.setTimeout
    ?? globalThis.setTimeout;
  const cancelTimeout =
    dependencies.clearTimeout
    ?? globalThis.clearTimeout;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = scheduleTimeout(() => {
      reject(new Error(POOL_SHUTDOWN_TIMEOUT));
    }, BACKUP_STATUS_REPORTER_SHUTDOWN_TIMEOUT_MS);
    timer?.unref?.();
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => pool.end()),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) cancelTimeout(timer);
  }
}

export async function enqueueBackupStatus(input, dependencies = {}) {
  const request = validateBackupStatusRequest(input);
  const databaseUrl = validateReporterDatabaseUrl(
    input.databaseUrl,
    input.databaseName,
  );
  const createPool =
    dependencies.createPool
    ?? ((options) => new Pool(options));
  const pool = createPool({
    connectionString: databaseUrl,
    ...BACKUP_STATUS_REPORTER_POOL_POLICY,
  });
  let acknowledgement;
  let primaryError;

  try {
    const result = await pool.query(
      `select acknowledgement, authority_id::text, outbox_id::text, operation_id::text
         from public.enqueue_backup_status_mail_authority($1::text, $2::text)`,
      [request.runKey, request.outcome],
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
  }

  try {
    await endPoolWithinDeadline(pool, dependencies);
  } catch (shutdownError) {
    if (primaryError === undefined) {
      primaryError = shutdownError;
    } else if (
      primaryError instanceof Error
      && primaryError.cause === undefined
    ) {
      primaryError.cause = shutdownError;
    }
  }

  if (primaryError !== undefined) throw primaryError;
  return acknowledgement;
}

export async function runBackupStatusReporter(
  environment = process.env,
  dependencies = {},
) {
  const databaseName = environment.POSTGRES_DB ?? "learncoding";
  const databaseUrl = readReporterDatabaseUrl(
    environment.DATABASE_BACKUP_REPORTER_URL_FILE,
  );
  const acknowledgement = await enqueueBackupStatus({
    databaseUrl,
    databaseName,
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
