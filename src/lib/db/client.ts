import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { errorMonitoringOptions } from "@/lib/observability/error-monitoring";

import * as schema from "./schema";

// The local fallback uses 127.0.0.1, not localhost: when no database is listening,
// a dual-stack localhost refusal surfaces as an AggregateError that the Next 16.3
// dev server fails to construct, leaving the query (and the page) hung.
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://learncoding:learncoding@127.0.0.1:5432/learncoding";

const DEFAULT_POOL_SIZE = 10;

// A bad DATABASE_POOL_SIZE ("abc", "0", "2.5") must not become NaN or a useless pool size.
export function databasePoolSize(value: string | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(trimmed)) return DEFAULT_POOL_SIZE;
  return Number(trimmed);
}

declare global {
  var learnCodingPool: Pool | undefined;
}

export const pool =
  globalThis.learnCodingPool ??
  new Pool({
    connectionString,
    max: databasePoolSize(process.env.DATABASE_POOL_SIZE),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

const idleErrorObserver = Symbol.for("codestead.database.idleErrorObserver");
const observedPool = pool as Pool & { [idleErrorObserver]?: boolean };

async function reportIdlePoolError(error: Error): Promise<void> {
  const options = errorMonitoringOptions({
    runtime: process.env.NEXT_RUNTIME === "nodejs" ? "nodejs" : "worker",
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.SENTRY_ENVIRONMENT,
  });
  if (!options) return;
  const Sentry = await import("@sentry/node");
  if (!Sentry.isInitialized()) {
    Sentry.init({ ...options, defaultIntegrations: false, tracesSampleRate: 0 });
  }
  Sentry.captureException(error, { level: "error", tags: { code: "DATABASE_POOL_ERROR" } });
}

if (!observedPool[idleErrorObserver]) {
  pool.on("error", (error: unknown) => {
    // pg-pool already removed the failed idle client. Keep the pool available;
    // never pass the raw error, SQL, credentials, or client to logging/monitoring.
    const rawCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const code = typeof rawCode === "string" && (
      /^[0-9]{2}[0-9A-Z]{3}$/.test(rawCode)
      || ["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(rawCode)
    ) ? rawCode : "UNKNOWN";
    try {
      console.error(JSON.stringify({ event: "database.pool_error", code }));
    } catch {
      // A broken log sink must not turn a handled connection failure into a crash.
    }
    const safeError = new Error(`Database pool idle client error (${code}).`);
    safeError.name = "DatabasePoolError";
    void reportIdlePoolError(safeError).catch(() => undefined);
  });
  observedPool[idleErrorObserver] = true;
}

if (process.env.NODE_ENV !== "production") {
  globalThis.learnCodingPool = pool;
}

export const db = drizzle(pool, { schema });

export type Database = typeof db;
