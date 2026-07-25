import {
  planMailDispatchRuntime,
  type MailDispatchRuntimePlan,
} from "./mail-dispatch-runtime-policy";

export const MAIL_DISPATCH_PRODUCTION_CONCURRENCY = 1;
export const MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS = 80;

type CapacityRow = Readonly<{
  max_connections?: unknown;
  admin_reserved_connections?: unknown;
}>;

export type MailDispatchStartupPool = Readonly<{
  options?: Readonly<{ max?: unknown }>;
  query(
    text: string,
  ): Promise<Readonly<{ rows: unknown[] }>>;
}>;

function integerText(
  value: unknown,
  input: Readonly<{ allowZero: boolean }>,
): number | null {
  if (
    typeof value !== "string"
    || !(input.allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Inspects the pool actually constructed for the mail process and the live
 * PostgreSQL server. Production startup must not rely on policy defaults for
 * either capacity value.
 */
export async function inspectMailDispatchRuntime(
  pool: MailDispatchStartupPool,
  input: Readonly<{
    concurrency: number;
    otherProcessPoolMaximumConnections: number;
  }>,
): Promise<MailDispatchRuntimePlan> {
  if (input.concurrency !== MAIL_DISPATCH_PRODUCTION_CONCURRENCY) {
    throw new Error(
      "Production mail dispatch concurrency must be exactly one.",
    );
  }
  const poolMaximumConnections = pool.options?.max;
  if (
    !Number.isSafeInteger(poolMaximumConnections)
    || poolMaximumConnections !== input.concurrency + 2
  ) {
    throw new Error(
      "Production mail dispatch pool maximum must equal exact C+2.",
    );
  }

  const result = await pool.query(`
    select current_setting('max_connections') as max_connections,
           (
             current_setting('superuser_reserved_connections')::integer
             + coalesce(
                 nullif(current_setting('reserved_connections', true), '')::integer,
                 0
               )
           )::text as admin_reserved_connections
  `);
  if (result.rows.length !== 1) {
    throw new Error("PostgreSQL capacity result is invalid.");
  }
  const row = result.rows[0] as CapacityRow | undefined;
  const serverMaximumConnections = integerText(
    row?.max_connections,
    { allowZero: false },
  );
  const serverAdminReserveConnections = integerText(
    row?.admin_reserved_connections,
    { allowZero: true },
  );
  if (
    serverMaximumConnections === null
    || serverAdminReserveConnections === null
  ) {
    throw new Error("PostgreSQL capacity result is invalid.");
  }

  return planMailDispatchRuntime({
    concurrency: input.concurrency,
    poolMaximumConnections,
    serverMaximumConnections,
    serverAdminReserveConnections,
    otherProcessPoolMaximumConnections:
      input.otherProcessPoolMaximumConnections,
  });
}
