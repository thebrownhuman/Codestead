import { describe, expect, it, vi } from "vitest";

import {
  accessRequestAuthorityLockKey,
  lockAccessRequestAuthorityOnPgClient,
  lockAccessRequestSourceAuthority,
  lockUserAuthorityOnPgClient,
  USER_AUTHORITY_ADVISORY_LOCK_SQL,
  USER_AUTHORITY_TRY_ADVISORY_LOCK_SQL,
  userAuthorityLockKey,
} from "@/lib/security/user-authority-lock";

describe("user authority advisory lock", () => {
  it("canonicalizes access-request email authority into one shared lock namespace", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await lockAccessRequestAuthorityOnPgClient(
      { query },
      " Learner@Example.INVALID ",
    );

    expect(accessRequestAuthorityLockKey(" Learner@Example.INVALID ")).toBe(
      "access-request:learner@example.invalid",
    );
    expect(query).toHaveBeenCalledWith(
      USER_AUTHORITY_ADVISORY_LOCK_SQL,
      ["access-request:learner@example.invalid"],
    );
  });

  it("checks deletion status only after owning the shared email lock", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: false }] });

    await expect(lockAccessRequestSourceAuthority(
      { execute } as never,
      "Learner@Example.INVALID",
    )).resolves.toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });

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
