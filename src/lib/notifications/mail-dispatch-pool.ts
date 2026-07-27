import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "../db/schema";
import {
  isMailDispatchRuntimePlan,
  MAIL_DISPATCH_RUNTIME_BOOTSTRAP,
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

export type MailDispatchBootstrapResources = Readonly<{
  pool: Pool;
  database: MailDispatchDatabase;
}>;

const productionDependencies: MailDispatchResourceFactoryDependencies =
  Object.freeze({
    createPool: (configuration: PoolConfig) => new Pool(configuration),
    createDatabase: (pool: Pool) => drizzle(pool, { schema }),
  });

function observeIdleMailDispatchPoolErrors(pool: Pool): void {
  pool.on("error", () => {
    // pg-pool has already removed the failed idle client before this event.
    // A listener prevents EventEmitter from terminating an otherwise healthy
    // worker; the next acquisition creates a replacement connection.
  });
}

/**
 * Creates the mail worker's one bootstrap pool before live inspection issues
 * the pool-bound runtime plan. Its Drizzle facade always shares that pool.
 */
export function createMailDispatchBootstrapResources(
  dependencies: MailDispatchResourceFactoryDependencies = productionDependencies,
): MailDispatchBootstrapResources {
  const pool = dependencies.createPool({
    connectionString: process.env.DATABASE_URL ?? DEVELOPMENT_DATABASE_URL,
    max: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections,
    connectionTimeoutMillis:
      MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
    idleTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
  });
  observeIdleMailDispatchPoolErrors(pool);
  const database = dependencies.createDatabase(pool);

  return Object.freeze({
    pool,
    database,
  });
}

/**
 * Creates the mail worker's only database pool and its Drizzle facade.
 * The configuration comes exclusively from an issued runtime plan; the
 * application-wide pool is neither imported nor reused.
 */
export function createMailDispatchDatabaseResources(
  configurationPlan: MailDispatchRuntimePlan,
  dependencies: MailDispatchResourceFactoryDependencies = productionDependencies,
): MailDispatchDatabaseResources {
  if (!isMailDispatchRuntimePlan(configurationPlan)) {
    throw new Error(
      "Mail dispatch database resources require an issued runtime plan.",
    );
  }

  const pool = dependencies.createPool({
    connectionString: process.env.DATABASE_URL ?? DEVELOPMENT_DATABASE_URL,
    max: configurationPlan.pool.maximumConnections,
    connectionTimeoutMillis: configurationPlan.timeouts.poolAcquireMs,
    idleTimeoutMillis: configurationPlan.timeouts.poolIdleMs,
  });
  observeIdleMailDispatchPoolErrors(pool);
  const database = dependencies.createDatabase(pool);

  return Object.freeze({
    pool,
    database,
    configurationPlan,
  });
}
