import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://learncoding:learncoding@localhost:5432/learncoding";

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
