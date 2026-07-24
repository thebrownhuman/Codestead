type Environment = Readonly<Record<string, string | undefined>>;

export type RetentionOpsEnvironment = Readonly<{
  databaseUrl: string;
  databaseOpsUrl: string;
}>;

const DISPOSABLE_DATABASE = "learncoding_integration";
const DISPOSABLE_HOST = "127.0.0.1";
const OWNER_ASSUMPTION = "-c role=learncoding_owner";
const PLATFORM_ENVIRONMENT_KEYS = Object.freeze([
  "CI",
  "LANG",
  "LC_ALL",
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
  expectedUser: "learncoding_migrator" | "learncoding_ops",
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
    || url.pathname !== `/${DISPOSABLE_DATABASE}`
    || url.hash !== ""
  ) {
    failValidation();
  }
  return url;
}

function validatedRetentionOpsEnvironment(
  environment: Environment,
): RetentionOpsEnvironment {
  if (environment.INTEGRATION_TEST !== "1") failValidation();

  const databaseUrl = environment.DATABASE_URL;
  const databaseOpsUrl = environment.DATABASE_OPS_URL;
  const migrator = parseDatabaseUrl(databaseUrl, "learncoding_migrator");
  const ops = parseDatabaseUrl(databaseOpsUrl, "learncoding_ops");
  const migratorOptions = [...migrator.searchParams.entries()];

  if (
    migratorOptions.length !== 1
    || migratorOptions[0]?.[0] !== "options"
    || migratorOptions[0]?.[1] !== OWNER_ASSUMPTION
    || ops.search !== ""
    || ops.hostname !== migrator.hostname
    || ops.port !== migrator.port
    || ops.pathname !== migrator.pathname
  ) {
    failValidation();
  }

  return {
    databaseUrl: databaseUrl!,
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
  if (environment[canonicalName] !== undefined) return environment[canonicalName];
  const matchedName = Object.keys(environment).find(
    (name) => name.toUpperCase() === canonicalName,
  );
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
