import {
  isMailDispatchRuntimePlan,
  planMailDispatchRuntime,
  type MailDispatchRuntimePlan,
} from "./mail-dispatch-runtime-policy";

export const MAIL_DISPATCH_PRODUCTION_CONCURRENCY = 1;
export const MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS = 80;

const MAIL_DISPATCH_POOL_MAXIMUM_CONNECTIONS = 3;
const MAIL_DISPATCH_POOL_ACQUIRE_TIMEOUT_MS = 5_000;
const MAIL_DISPATCH_POOL_IDLE_TIMEOUT_MS = 30_000;
const MAIL_DISPATCH_MINIMUM_POSTGRES_MAJOR = 17;

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
    return (
      pool.options?.max === MAIL_DISPATCH_POOL_MAXIMUM_CONNECTIONS
      && pool.options.connectionTimeoutMillis
        === MAIL_DISPATCH_POOL_ACQUIRE_TIMEOUT_MS
      && pool.options.idleTimeoutMillis === MAIL_DISPATCH_POOL_IDLE_TIMEOUT_MS
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

  const postgresMajor = Math.floor(serverVersionNumber / 10_000);
  if (postgresMajor < MAIL_DISPATCH_MINIMUM_POSTGRES_MAJOR) {
    throw new Error(
      "Mail dispatch requires PostgreSQL 17 or newer.",
    );
  }

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
    postgresMajor,
  });

  issuedPlanPostgresMajors.set(plan, postgresMajor);
  issuedInspections.add(inspection);
  return inspection;
}
