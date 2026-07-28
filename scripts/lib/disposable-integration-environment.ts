export type DisposableIntegrationEnvironmentSource =
  Readonly<Record<string, string | undefined>>;
type Environment = DisposableIntegrationEnvironmentSource;
export type DisposableIntegrationRole =
  | "learncoding_app"
  | "learncoding_worker"
  | "learncoding_ops"
  | "learncoding_backup_reporter";


export type DisposableOwnerDatabaseTarget = Readonly<{
  databaseApplicationUrl: string;
  databaseOwnerUrl: string;
}>;

export type RetentionOpsEnvironment = Readonly<{
  databaseAppUrl: string;
  databaseOwnerTarget: DisposableOwnerDatabaseTarget;
  databaseWorkerUrl: string;
  databaseOpsUrl: string;
}>;

const DISPOSABLE_DATABASE = "learncoding_integration";
const DISPOSABLE_HOST = "127.0.0.1";
const DISPOSABLE_INTEGRATION_POOL_SHUTDOWN_TIMEOUT_MS = 5_000;
export const DISPOSABLE_INTEGRATION_POOL_BOUNDS = Object.freeze({
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 5_000,
  query_timeout: 30_000,
  statement_timeout: 30_000,
  lock_timeout: 5_000,
  idle_in_transaction_session_timeout: 30_000,
});
const PLATFORM_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "CI",
  "GITHUB_ACTIONS",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const);

function failValidation(): never {
  throw new Error("disposable integration environment validation failed");
}

function parseDatabaseUrl(
  value: string | undefined,
  expectedUser: DisposableIntegrationRole,
): URL {
  if (typeof value !== "string" || value.length === 0) failValidation();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failValidation();
  }

  const numericPort = Number(url.port);
  const pathStart = value.indexOf("/", "postgresql://".length);
  if (
    url.protocol !== "postgresql:"
    || url.username !== expectedUser
    || url.password.length === 0
    || url.hostname !== DISPOSABLE_HOST
    || pathStart < 0
    || value.slice(value.lastIndexOf("@", pathStart) + 1, pathStart) !== `${DISPOSABLE_HOST}:${url.port}`
    || !Number.isSafeInteger(numericPort)
    || numericPort < 1
    || numericPort > 65_535
    || numericPort === 5_432
    || url.pathname !== `/${DISPOSABLE_DATABASE}`
    || url.search !== ""
    || url.hash !== ""
  ) {
    failValidation();
  }
  return url;
}

function parseOwnerDatabaseUrl(value: string | undefined): URL {
  if (typeof value !== "string" || value.length === 0) failValidation();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failValidation();
  }
  const numericPort = Number(url.port);
  const pathStart = value.indexOf("/", "postgresql://".length);
  if (
    url.protocol !== "postgresql:"
    || url.username !== "learncoding_migrator"
    || url.password.length === 0
    || url.hostname !== DISPOSABLE_HOST
    || !Number.isSafeInteger(numericPort)
    || pathStart < 0
    || value.slice(value.lastIndexOf("@", pathStart) + 1, pathStart) !== `${DISPOSABLE_HOST}:${url.port}`
    || numericPort < 1
    || numericPort > 65_535
    || numericPort === 5_432
    || url.pathname !== `/${DISPOSABLE_DATABASE}`
    || url.search !== "?options=-c+role%3Dlearncoding_owner"
    || url.hash !== ""
  ) {
    failValidation();
  }
  return url;
}
export function validatedDisposableApplicationDatabaseUrl(
  environment: Environment,
): string {
  if (environment.INTEGRATION_TEST !== "1") failValidation();
  const canonicalAppUrl = environment.DATABASE_URL;
  const databaseApplicationUrl = environment.DATABASE_APP_URL;
  const canonicalApp = parseDatabaseUrl(canonicalAppUrl, "learncoding_app");
  const app = parseDatabaseUrl(databaseApplicationUrl, "learncoding_app");
  if (
    canonicalAppUrl !== databaseApplicationUrl
    || canonicalApp.href !== app.href
  ) {
    failValidation();
  }
  return databaseApplicationUrl!;
}

export type DisposableBackupReporterEnvironment = Readonly<{
  databaseAppUrl: string;
  databaseBackupReporterUrl: string;
}>;

export function validatedDisposableBackupReporterEnvironment(
  environment: Environment,
): DisposableBackupReporterEnvironment {
  const databaseAppUrl = validatedDisposableApplicationDatabaseUrl(environment);
  const databaseBackupReporterUrl = environment.DATABASE_BACKUP_REPORTER_URL;
  const app = parseDatabaseUrl(databaseAppUrl, "learncoding_app");
  const reporter = parseDatabaseUrl(
    databaseBackupReporterUrl,
    "learncoding_backup_reporter",
  );
  if (
    reporter.hostname !== app.hostname
    || reporter.port !== app.port
    || reporter.pathname !== app.pathname
  ) failValidation();
  return Object.freeze({
    databaseAppUrl,
    databaseBackupReporterUrl: databaseBackupReporterUrl!,
  });
}


export function validatedDisposableOwnerDatabaseTarget(
  environment: Environment,
): DisposableOwnerDatabaseTarget {
  const databaseApplicationUrl = validatedDisposableApplicationDatabaseUrl(environment);
  const databaseOwnerUrl = environment.DATABASE_OWNER_URL;
  const app = parseDatabaseUrl(databaseApplicationUrl, "learncoding_app");
  const owner = parseOwnerDatabaseUrl(databaseOwnerUrl);
  if (
    owner.hostname !== app.hostname
    || owner.port !== app.port
    || owner.pathname !== app.pathname
  ) {
    failValidation();
  }
  return Object.freeze({
    databaseApplicationUrl: databaseApplicationUrl!,
    databaseOwnerUrl: databaseOwnerUrl!,
  });
}

export function validatedDisposableRetentionOpsEnvironment(
  environment: Environment,
): RetentionOpsEnvironment {
  const databaseOwnerTarget =
    validatedDisposableOwnerDatabaseTarget(environment);
  const databaseAppUrl = databaseOwnerTarget.databaseApplicationUrl;
  const databaseWorkerUrl = environment.DATABASE_WORKER_URL;
  const databaseOpsUrl = environment.DATABASE_OPS_URL;
  const app = parseDatabaseUrl(databaseAppUrl, "learncoding_app");
  const worker = parseDatabaseUrl(databaseWorkerUrl, "learncoding_worker");
  const ops = parseDatabaseUrl(databaseOpsUrl, "learncoding_ops");

  if (
    worker.hostname !== app.hostname
    || worker.port !== app.port
    || worker.pathname !== app.pathname
    || ops.hostname !== app.hostname
    || ops.port !== app.port
    || ops.pathname !== app.pathname
  ) {
    failValidation();
  }

  return Object.freeze({
    databaseAppUrl,
    databaseOwnerTarget,
    databaseWorkerUrl: databaseWorkerUrl!,
    databaseOpsUrl: databaseOpsUrl!,
  });
}

export async function runWithValidatedRetentionOpsEnvironment<T>(
  environment: Environment,
  operation: (input: RetentionOpsEnvironment) => T | PromiseLike<T>,
): Promise<T> {
  const validated = validatedDisposableRetentionOpsEnvironment(environment);
  return operation(validated);
}

type DisposableIntegrationRoleIdentity = Readonly<{
  current_database?: unknown;
  current_user?: unknown;
  session_user?: unknown;
}>;

export type DisposableIntegrationRoleClient = Readonly<{
  query: (statement: string) => PromiseLike<Readonly<{
    rows: readonly DisposableIntegrationRoleIdentity[];
  }>>;
  release: (destroy?: boolean) => void;
}>;

export type DisposableIntegrationRolePool<
  Client extends DisposableIntegrationRoleClient,
> = Readonly<{
  connect: () => PromiseLike<Client>;
}>;

export async function acquireValidatedDisposableRoleClient<
  Client extends DisposableIntegrationRoleClient,
>(
  database: DisposableIntegrationRolePool<Client>,
  expectedRole: DisposableIntegrationRole,
): Promise<Client> {
  const client = await database.connect();
  try {
    const identity = await client.query(`
      SELECT current_database()::text AS current_database,
             current_user::text AS current_user,
             session_user::text AS session_user
    `);
    const row = identity.rows[0];
    if (
      identity.rows.length !== 1
      || row?.current_database !== DISPOSABLE_DATABASE
      || row.current_user !== expectedRole
      || row.session_user !== expectedRole
    ) {
      throw new Error("disposable integration role identity mismatch");
    }
    return client;
  } catch (primaryError) {
    try {
      client.release(true);
    } catch (releaseError) {
      throw new AggregateError(
        [primaryError, releaseError],
        "disposable integration role validation and release failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
}

type DisposableIntegrationEndablePool = Readonly<{
  end: () => void | PromiseLike<void>;
}>;

class DisposableIntegrationPoolShutdownTimeoutError extends Error {
  constructor() {
    super("disposable integration pool shutdown timed out");
    this.name = "DisposableIntegrationPoolShutdownTimeoutError";
  }
}

export async function endDisposableIntegrationPoolWithinDeadline(
  database: DisposableIntegrationEndablePool,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shutdown = Promise.resolve()
    .then(() => database.end())
    .then(
      () => ({ kind: "closed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  const deadline = new Promise<{ kind: "timed-out" }>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timed-out" }),
      DISPOSABLE_INTEGRATION_POOL_SHUTDOWN_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([shutdown, deadline]);
    if (result.kind === "timed-out") {
      throw new DisposableIntegrationPoolShutdownTimeoutError();
    }
    if (result.kind === "failed") throw result.error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runWithBoundedDisposableIntegrationPool<T>(
  database: DisposableIntegrationEndablePool,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  let outcome:
    | Readonly<{ kind: "succeeded"; value: T }>
    | Readonly<{ kind: "failed"; error: unknown }>;
  try {
    outcome = { kind: "succeeded", value: await operation() };
  } catch (error) {
    outcome = { kind: "failed", error };
  }

  let shutdownFailure: Readonly<{ error: unknown }> | undefined;
  try {
    await endDisposableIntegrationPoolWithinDeadline(database);
  } catch (error) {
    shutdownFailure = { error };
  }

  if (outcome.kind === "failed" && shutdownFailure) {
    throw new AggregateError(
      [outcome.error, shutdownFailure.error],
      "disposable integration operation and pool shutdown failed",
      { cause: outcome.error },
    );
  }
  if (outcome.kind === "failed") throw outcome.error;
  if (shutdownFailure) throw shutdownFailure.error;
  return outcome.value;
}
function environmentValue(environment: Environment, canonicalName: string) {
  if (Object.prototype.hasOwnProperty.call(environment, canonicalName)) {
    return environment[canonicalName];
  }
  const matchedNames = Object.keys(environment).filter(
    (name) =>
      name.toUpperCase() === canonicalName
      && environment[name] !== undefined,
  );
  if (matchedNames.length > 1) failValidation();
  const matchedName = matchedNames[0];
  return matchedName === undefined ? undefined : environment[matchedName];
}

export function minimalNodeTestEnvironment(
  environment: Environment,
): NodeJS.ProcessEnv {
  const result = {} as NodeJS.ProcessEnv;
  for (const name of PLATFORM_ENVIRONMENT_KEYS) {
    const value = environmentValue(environment, name);
    if (value !== undefined) result[name] = value;
  }
  return result;
}
