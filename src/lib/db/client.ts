import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

// The local fallback uses 127.0.0.1, not localhost: when no database is listening,
// a dual-stack localhost refusal surfaces as an AggregateError that the Next 16.3
// dev server fails to construct, leaving the query (and the page) hung.
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://learncoding:learncoding@127.0.0.1:5432/learncoding";

declare global {
  var learnCodingPool: Pool | undefined;
}

export const pool =
  globalThis.learnCodingPool ??
  new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.learnCodingPool = pool;
}

export const db = drizzle(pool, { schema });

export type Database = typeof db;
