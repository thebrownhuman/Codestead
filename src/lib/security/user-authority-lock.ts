import { sql } from "drizzle-orm";

import type { db } from "@/lib/db/client";

type UserAuthorityExecutor = Pick<typeof db, "execute">;

export const USER_AUTHORITY_ADVISORY_LOCK_SQL =
  "select pg_catalog.pg_advisory_xact_lock("
  + "pg_catalog.hashtext($1)::pg_catalog.int8)";

export const USER_AUTHORITY_TRY_ADVISORY_LOCK_SQL =
  "select pg_catalog.pg_try_advisory_xact_lock("
  + "pg_catalog.hashtext($1)::pg_catalog.int8) as locked";

type UserAuthorityPgExecutor = Readonly<{
  query(
    statement: string,
    values?: unknown[],
  ): Promise<unknown>;
}>;

export function userAuthorityLockKey(userId: string) {
  return `user-authority:${userId}`;
}

export async function lockUserAuthorityOnPgClient(
  database: UserAuthorityPgExecutor,
  userId: string,
) {
  await database.query(
    USER_AUTHORITY_ADVISORY_LOCK_SQL,
    [userAuthorityLockKey(userId)],
  );
}

/**
 * Global per-user transaction lock. Every operation that can create or
 * invalidate user-scoped processing authority must acquire this first,
 * before request-, grant-, credential-, or row-level locks.
 */
export async function lockUserAuthority(
  database: UserAuthorityExecutor,
  userId: string,
) {
  await database.execute(
    sql`select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(${userAuthorityLockKey(userId)})::pg_catalog.int8
    )`,
  );
}
