export type DisposableIntegrationEnvironmentSource =
  Readonly<Record<string, string | undefined>>;
type Environment = DisposableIntegrationEnvironmentSource;

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
  expectedUser: "learncoding_app" | "learncoding_worker" | "learncoding_ops",
): URL {
  if (typeof value !== "string" || value.length === 0) failValidation();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failValidation();
  }

  const numericPort = Number(url.port);
  if (
    url.protocol !== "postgresql:"
    || url.username !== expectedUser
    || url.password.length === 0
    || url.hostname !== DISPOSABLE_HOST
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
  if (
    url.protocol !== "postgresql:"
    || url.username !== "learncoding_migrator"
    || url.password.length === 0
    || url.hostname !== DISPOSABLE_HOST
    || !Number.isSafeInteger(numericPort)
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

export function validatedDisposableOwnerDatabaseTarget(
  environment: Environment,
): DisposableOwnerDatabaseTarget {
  if (environment.INTEGRATION_TEST !== "1") failValidation();
  const canonicalAppUrl = environment.DATABASE_URL;
  const databaseApplicationUrl = environment.DATABASE_APP_URL;
  const databaseOwnerUrl = environment.DATABASE_OWNER_URL;
  const canonicalApp = parseDatabaseUrl(canonicalAppUrl, "learncoding_app");
  const app = parseDatabaseUrl(databaseApplicationUrl, "learncoding_app");
  const owner = parseOwnerDatabaseUrl(databaseOwnerUrl);
  if (
    canonicalAppUrl !== databaseApplicationUrl
    || canonicalApp.href !== app.href
    || owner.hostname !== app.hostname
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

function validatedRetentionOpsEnvironment(
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

  return {
    databaseAppUrl,
    databaseOwnerTarget,
    databaseWorkerUrl: databaseWorkerUrl!,
    databaseOpsUrl: databaseOpsUrl!,
  };
}

export async function runWithValidatedRetentionOpsEnvironment<T>(
  environment: Environment,
  operation: (input: RetentionOpsEnvironment) => T | PromiseLike<T>,
): Promise<T> {
  const validated = validatedRetentionOpsEnvironment(environment);
  return operation(validated);
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
