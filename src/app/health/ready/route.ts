import type { QueryConfig } from "pg";

import { pool } from "@/lib/db/client";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

type TimedQueryConfig = QueryConfig & { query_timeout: number };

const readinessQuery: TimedQueryConfig = {
  text: "select 1",
  query_timeout: 2_000,
};

export async function GET() {
  try {
    await pool.query(readinessQuery);
    return Response.json({ status: "ready" }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
