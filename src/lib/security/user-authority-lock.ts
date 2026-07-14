import { sql } from "drizzle-orm";

import type { db } from "@/lib/db/client";

type UserAuthorityExecutor = Pick<typeof db, "execute">;

export function userAuthorityLockKey(userId: string) {
  return `user-authority:${userId}`;
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
    sql`select pg_advisory_xact_lock(hashtext(${userAuthorityLockKey(userId)}))`,
  );
}
