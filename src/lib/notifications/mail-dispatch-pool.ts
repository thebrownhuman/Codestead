import {
  drizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import {
  Pool,
  type PoolConfig,
} from "pg";

import * as schema from "../db/schema";
import {
  isMailDispatchRuntimePlan,
  type MailDispatchRuntimePlan,
} from "./mail-dispatch-runtime-policy";

const DEVELOPMENT_DATABASE_URL =
  "postgresql://learncoding:learncoding@localhost:5432/learncoding";

export type MailDispatchDatabase = NodePgDatabase<typeof schema>;

type MailDispatchResourceFactoryDependencies = Readonly<{
  createPool(configuration: PoolConfig): Pool;
  createDatabase(pool: Pool): MailDispatchDatabase;
}>;

export type MailDispatchDatabaseResources = Readonly<{
  pool: Pool;
  database: MailDispatchDatabase;
  configurationPlan: MailDispatchRuntimePlan;
}>;

const productionDependencies: MailDispatchResourceFactoryDependencies =
  Object.freeze({
    createPool: (configuration: PoolConfig) => new Pool(configuration),
    createDatabase: (pool: Pool) => drizzle(pool, { schema }),
  });

/**
 * Creates the mail worker's only database pool and its Drizzle facade.
 * The configuration comes exclusively from an issued runtime plan; the
 * application-wide pool is neither imported nor reused.
 */
export function createMailDispatchDatabaseResources(
  configurationPlan: MailDispatchRuntimePlan,
  dependencies: MailDispatchResourceFactoryDependencies =
    productionDependencies,
): MailDispatchDatabaseResources {
  if (!isMailDispatchRuntimePlan(configurationPlan)) {
    throw new Error(
      "Mail dispatch database resources require an issued runtime plan.",
    );
  }

  const pool = dependencies.createPool({
    connectionString:
      process.env.DATABASE_URL ?? DEVELOPMENT_DATABASE_URL,
    max: configurationPlan.pool.maximumConnections,
    connectionTimeoutMillis:
      configurationPlan.timeouts.poolAcquireMs,
    idleTimeoutMillis: configurationPlan.timeouts.poolIdleMs,
  });
  const database = dependencies.createDatabase(pool);

  return Object.freeze({
    pool,
    database,
    configurationPlan,
  });
}
