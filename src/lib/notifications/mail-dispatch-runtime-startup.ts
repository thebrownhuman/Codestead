import {
  isMailDispatchRuntimePlan,
  planMailDispatchRuntime,
  type MailDispatchRuntimePlan,
} from "./mail-dispatch-runtime-policy";

const MINIMUM_MAIL_DISPATCH_POSTGRES_MAJOR = 17;
const FAILURE_MESSAGE = "Mail dispatch requires PostgreSQL 17 or newer.";

export const MAIL_DISPATCH_PRODUCTION_CONCURRENCY = 1;
export const MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS = 80;

const MAIL_DISPATCH_POOL_MAXIMUM_CONNECTIONS = 3;
const MAIL_DISPATCH_POOL_ACQUIRE_TIMEOUT_MS = 5_000;
const MAIL_DISPATCH_POOL_IDLE_TIMEOUT_MS = 30_000;

type RuntimeVersionRow = {
  readonly server_version_num: unknown;
};

export type PostgresRuntimeQueryable = {
  query(
    queryText: string,
  ): Promise<{ readonly rows: readonly RuntimeVersionRow[] }>;
};

export class MailDispatchPostgresRuntimeError extends Error {
  constructor() {
    super(FAILURE_MESSAGE);
    this.name = "POSTGRES_RUNTIME_UNSUPPORTED";
  }
}

export function parsePostgresServerVersionNum(versionNum: unknown): {
  readonly major: number;
  readonly versionNum: number;
} {
  if (
    typeof versionNum !== "string"
    || !/^[1-9][0-9]{4,7}$/u.test(versionNum)
  ) {
    throw new MailDispatchPostgresRuntimeError();
  }

  const parsedVersionNum = Number.parseInt(versionNum, 10);
  const major = Math.floor(parsedVersionNum / 10_000);
  if (
    !Number.isSafeInteger(parsedVersionNum)
    || major < MINIMUM_MAIL_DISPATCH_POSTGRES_MAJOR
  ) {
    throw new MailDispatchPostgresRuntimeError();
  }

  return { major, versionNum: parsedVersionNum };
}

export async function requireMailDispatchPostgresRuntime(
  database: PostgresRuntimeQueryable,
): Promise<{
  readonly major: number;
  readonly versionNum: number;
}> {
  try {
    const result = await database.query(
      "select pg_catalog.current_setting('server_version_num') as server_version_num",
    );
    if (result.rows.length !== 1) {
      throw new MailDispatchPostgresRuntimeError();
    }
    return parsePostgresServerVersionNum(result.rows[0]?.server_version_num);
  } catch {
    throw new MailDispatchPostgresRuntimeError();
  }
}

type StartupSnapshotRow = Readonly<{
  max_connections?: unknown;
  admin_reserved_connections?: unknown;
  server_version_num?: unknown;
}>;

export type MailDispatchStartupPool = Readonly<{
  options?: Readonly<{
    max?: unknown;
    connectionTimeoutMillis?: unknown;
    idleTimeoutMillis?: unknown;
  }>;
  query(
    text: string,
  ): Promise<Readonly<{ rows: readonly unknown[] }>>;
}>;

export type MailDispatchRuntimeStartupInspection = Readonly<{
  plan: MailDispatchRuntimePlan;
  postgresMajor: number;
}>;

const issuedInspections = new WeakSet<object>();
const issuedPlanPostgresMajors = new WeakMap<object, number>();

function integerText(
  value: unknown,
  input: Readonly<{ allowZero: boolean }>,
): number | null {
  const pattern = input.allowZero
    ? /^(?:0|[1-9][0-9]*)$/
    : /^[1-9][0-9]*$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasExactPoolOptions(pool: MailDispatchStartupPool): boolean {
  try {
    const options = pool.options;
    return (
      options?.max === MAIL_DISPATCH_POOL_MAXIMUM_CONNECTIONS
      && options.connectionTimeoutMillis
        === MAIL_DISPATCH_POOL_ACQUIRE_TIMEOUT_MS
      && options.idleTimeoutMillis === MAIL_DISPATCH_POOL_IDLE_TIMEOUT_MS
    );
  } catch {
    return false;
  }
}

/**
 * Recognizes only the exact frozen inspection returned by this module.
 * Reconstructed objects and plans created directly by the policy factory do
 * not carry startup database provenance.
 */
export function isMailDispatchRuntimeStartupInspection(
  value: unknown,
): value is MailDispatchRuntimeStartupInspection {
  if (
    value === null
    || typeof value !== "object"
    || !issuedInspections.has(value)
  ) {
    return false;
  }

  const inspection = value as MailDispatchRuntimeStartupInspection;
  return (
    Object.isFrozen(inspection)
    && isMailDispatchRuntimePlan(inspection.plan)
    && issuedPlanPostgresMajors.get(inspection.plan)
      === inspection.postgresMajor
  );
}

/**
 * Inspects the exact production mail pool and one live PostgreSQL snapshot.
 * The returned object is the runtime capability consumed by dispatch storage;
 * callers cannot substitute a structurally equal policy plan.
 */
export async function inspectMailDispatchRuntime(
  pool: MailDispatchStartupPool,
): Promise<MailDispatchRuntimeStartupInspection> {
  if (
    pool === null
    || typeof pool !== "object"
    || !hasExactPoolOptions(pool)
  ) {
    throw new Error("Mail dispatch startup pool configuration is invalid.");
  }

  let result: Readonly<{ rows: readonly unknown[] }>;
  try {
    result = await pool.query(`
      select current_setting('max_connections') as max_connections,
             (
               current_setting('superuser_reserved_connections')::integer
               + coalesce(
                   nullif(
                     current_setting('reserved_connections', true),
                     ''
                   )::integer,
                   0
                 )
             )::text as admin_reserved_connections,
             current_setting('server_version_num') as server_version_num
    `);
  } catch {
    throw new Error(
      "Mail dispatch startup database inspection failed.",
    );
  }

  if (!Array.isArray(result.rows) || result.rows.length !== 1) {
    throw new Error("PostgreSQL startup snapshot is invalid.");
  }

  const row = result.rows[0] as StartupSnapshotRow | undefined;
  const serverMaximumConnections = integerText(
    row?.max_connections,
    { allowZero: false },
  );
  const serverAdminReserveConnections = integerText(
    row?.admin_reserved_connections,
    { allowZero: true },
  );
  const serverVersionNumber = integerText(
    row?.server_version_num,
    { allowZero: false },
  );
  if (
    serverMaximumConnections === null
    || serverAdminReserveConnections === null
    || serverVersionNumber === null
  ) {
    throw new Error("PostgreSQL startup snapshot is invalid.");
  }

  const postgresRuntime = parsePostgresServerVersionNum(
    row?.server_version_num,
  );
  const plan = planMailDispatchRuntime({
    concurrency: MAIL_DISPATCH_PRODUCTION_CONCURRENCY,
    poolMaximumConnections: MAIL_DISPATCH_POOL_MAXIMUM_CONNECTIONS,
    serverMaximumConnections,
    serverAdminReserveConnections,
    otherProcessPoolMaximumConnections:
      MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS,
    poolAcquireTimeoutMs: MAIL_DISPATCH_POOL_ACQUIRE_TIMEOUT_MS,
    poolIdleTimeoutMs: MAIL_DISPATCH_POOL_IDLE_TIMEOUT_MS,
  });
  const inspection = Object.freeze({
    plan,
    postgresMajor: postgresRuntime.major,
  });

  issuedPlanPostgresMajors.set(plan, postgresRuntime.major);
  issuedInspections.add(inspection);
  return inspection;
}
