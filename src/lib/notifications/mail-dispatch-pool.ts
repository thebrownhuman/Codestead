import {
  drizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import {
  Pool,
  type PoolConfig,
} from "pg";

import * as schema from "../db/schema";
import { planMailDispatchRuntime } from "./mail-dispatch-runtime-policy";
import {
  inspectMailDispatchRuntime,
  isMailDispatchRuntimeStartupInspectionForPool,
  type MailDispatchRuntimeStartupInspection,
} from "./mail-dispatch-runtime-startup";

const DEVELOPMENT_DATABASE_URL =
  "postgresql://learncoding:learncoding@localhost:5432/learncoding";

export type MailDispatchDatabase = NodePgDatabase<typeof schema>;

export type MailDispatchResourceFactoryDependencies = Readonly<{
  createPool(configuration: PoolConfig): Pool;
  createDatabase(pool: Pool): MailDispatchDatabase;
}>;

export type MailDispatchDatabaseResources = Readonly<{
  pool: Pool;
  database: MailDispatchDatabase;
  inspection: MailDispatchRuntimeStartupInspection;
}>;

const productionDependencies: MailDispatchResourceFactoryDependencies =
  Object.freeze({
    createPool: (configuration: PoolConfig) => new Pool(configuration),
    createDatabase: (pool: Pool) => drizzle(pool, { schema }),
  });

async function closeFailedStartupPool(
  pool: Pool,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Mail dispatch startup pool close timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    throw new Error("Mail dispatch startup pool cleanup failed.");
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function bindExactPoolConfiguration(
  pool: Pool,
  inspection: MailDispatchRuntimeStartupInspection,
): void {
  const options = pool.options;
  Object.defineProperties(options, {
    max: {
      value: inspection.plan.pool.maximumConnections,
      writable: false,
      configurable: false,
      enumerable: true,
    },
    connectionTimeoutMillis: {
      value: inspection.plan.timeouts.poolAcquireMs,
      writable: false,
      configurable: false,
      enumerable: true,
    },
    idleTimeoutMillis: {
      value: inspection.plan.timeouts.poolIdleMs,
      writable: false,
      configurable: false,
      enumerable: true,
    },
  });
  Object.defineProperty(pool, "options", {
    value: options,
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

/**
 * Creates, live-inspects, and seals the mail worker's only database pool.
 * No pre-inspection plan escapes as authority, and any failed startup tears
 * down this exact pool before the failure is returned.
 */
export async function createMailDispatchDatabaseResources(
  dependencies: MailDispatchResourceFactoryDependencies =
    productionDependencies,
): Promise<MailDispatchDatabaseResources> {
  const configurationPlan = planMailDispatchRuntime();
  const pool = dependencies.createPool({
    connectionString:
      process.env.DATABASE_URL ?? DEVELOPMENT_DATABASE_URL,
    max: configurationPlan.pool.maximumConnections,
    connectionTimeoutMillis:
      configurationPlan.timeouts.poolAcquireMs,
    idleTimeoutMillis: configurationPlan.timeouts.poolIdleMs,
    lock_timeout: configurationPlan.timeouts.lockMs,
    statement_timeout: configurationPlan.timeouts.statementMs,
    query_timeout: configurationPlan.timeouts.queryMs,
  });

  try {
    const inspection = await inspectMailDispatchRuntime(pool);
    if (
      !isMailDispatchRuntimeStartupInspectionForPool(
        inspection,
        pool,
      )
    ) {
      throw new Error(
        "Mail dispatch startup inspection does not authorize its pool.",
      );
    }

    bindExactPoolConfiguration(pool, inspection);
    if (
      !isMailDispatchRuntimeStartupInspectionForPool(
        inspection,
        pool,
      )
    ) {
      throw new Error(
        "Mail dispatch startup pool configuration changed after inspection.",
      );
    }
    const database = dependencies.createDatabase(pool);

    return Object.freeze({
      pool,
      database,
      inspection,
    });
  } catch (error) {
    await closeFailedStartupPool(
      pool,
      configurationPlan.timeouts.poolCloseMs,
    );
    throw error;
  }
}
