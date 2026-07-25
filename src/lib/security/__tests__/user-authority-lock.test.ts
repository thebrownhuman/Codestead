import { describe, expect, it, vi } from "vitest";

import {
  lockUserAuthorityOnPgClient,
  USER_AUTHORITY_ADVISORY_LOCK_SQL,
  USER_AUTHORITY_TRY_ADVISORY_LOCK_SQL,
  userAuthorityLockKey,
} from "@/lib/security/user-authority-lock";

describe("user authority advisory lock", () => {
  it("uses one signed transaction-lock statement for raw PostgreSQL clients", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));

    await lockUserAuthorityOnPgClient({ query }, "learner-1");

    expect(USER_AUTHORITY_ADVISORY_LOCK_SQL).toBe(
      "select pg_catalog.pg_advisory_xact_lock("
      + "pg_catalog.hashtext($1)::pg_catalog.int8)",
    );
    expect(USER_AUTHORITY_TRY_ADVISORY_LOCK_SQL).toBe(
      "select pg_catalog.pg_try_advisory_xact_lock("
      + "pg_catalog.hashtext($1)::pg_catalog.int8) as locked",
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      USER_AUTHORITY_ADVISORY_LOCK_SQL,
      ["user-authority:learner-1"],
    );
  });

  it("keeps the account namespace stable for positive and negative hashtext results", () => {
    expect(userAuthorityLockKey("learner-1")).toBe("user-authority:learner-1");
    expect(USER_AUTHORITY_ADVISORY_LOCK_SQL).toContain(
      "hashtext($1)::pg_catalog.int8",
    );
    expect(USER_AUTHORITY_ADVISORY_LOCK_SQL).not.toContain("hashtextextended");
  });
});
