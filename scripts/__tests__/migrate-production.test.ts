import { describe, expect, it, vi } from "vitest";

import { acquireMigrationLock, runProductionMigration } from "../migrate-production.mjs";

vi.mock("../lib/reviewed-migration-ledger.mjs", () => ({
  verifyReviewedMigrationRepository: vi.fn(() => ({
    entryCount: 70,
    ledgerSha256: "a".repeat(64),
    tailIndex: 69,
    tailTag: "0069_mail_outbox_guarded_delivery_authority",
  })),
  verifyAppliedMigrationLedger: vi.fn(async () => ({
    appliedCount: 70,
    complete: true,
    ledgerSha256: "a".repeat(64),
  })),
}));

function roleAwareQuery(
  unlock: () => Promise<{ rows: Array<Record<string, unknown>> }> = async () => ({
    rows: [{ released: true }],
  }),
) {
  let ownerRoleAssumed = false;
  return vi.fn(async (sql: string) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    if (sql.includes("SET ROLE learncoding_owner")) {
      ownerRoleAssumed = true;
      return { rows: [] };
    }
    if (sql.includes("RESET ROLE")) {
      ownerRoleAssumed = false;
      return { rows: [] };
    }
    if (sql.includes("current_user") && sql.includes("session_user")) {
      return {
        rows: [{
          current_user: ownerRoleAssumed ? "learncoding_owner" : "learncoding_migrator",
          session_user: "learncoding_migrator",
        }],
      };
    }
    if (sql.includes("pg_advisory_unlock")) return unlock();
    return { rows: [] };
  });
}

it("verifies the reviewed repository and applied ledger around the migration boundary", async () => {
  const query = roleAwareQuery();
  const client = { query, release: vi.fn() };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  };
  const migrate = vi.fn(async () => undefined);
  const migrationsFolder = "/reviewed/drizzle";
  const verifyReviewedMigrationRepository = vi.fn(() => ({
    entryCount: 70,
    ledgerSha256: "a".repeat(64),
    tailIndex: 69,
    tailTag: "0069_mail_outbox_guarded_delivery_authority",
  }));
  const verifyAppliedMigrationLedger = vi.fn(async () => ({
    appliedCount: 70,
    complete: true,
    ledgerSha256: "a".repeat(64),
  }));

  await runProductionMigration({
    connectionString: "postgresql://learncoding_migrator:Fake@postgres/learncoding",
    pool,
    migrate,
    drizzle: vi.fn(() => ({})),
    migrationsFolder,
    verifyReviewedMigrationRepository,
    verifyAppliedMigrationLedger,
  });

  expect(verifyReviewedMigrationRepository).toHaveBeenCalledWith({
    drizzleDirectory: migrationsFolder,
  });
  expect(verifyAppliedMigrationLedger.mock.calls).toEqual([
    [client, { requireComplete: false }],
    [client, { requireComplete: true }],
  ]);
  expect(verifyReviewedMigrationRepository.mock.invocationCallOrder[0]).toBeLessThan(
    verifyAppliedMigrationLedger.mock.invocationCallOrder[0] ?? 0,
  );
  const setRoleCall = query.mock.calls.findIndex(([sql]) =>
    String(sql).includes("SET ROLE learncoding_owner"),
  );
  expect(verifyReviewedMigrationRepository.mock.invocationCallOrder[0]).toBeLessThan(
    query.mock.invocationCallOrder[setRoleCall] ?? 0,
  );
  expect(query.mock.invocationCallOrder[setRoleCall]).toBeLessThan(
    verifyAppliedMigrationLedger.mock.invocationCallOrder[0] ?? 0,
  );
  expect(verifyAppliedMigrationLedger.mock.invocationCallOrder[0]).toBeLessThan(
    migrate.mock.invocationCallOrder[0] ?? 0,
  );
  expect(migrate.mock.invocationCallOrder[0]).toBeLessThan(
    verifyAppliedMigrationLedger.mock.invocationCallOrder[1] ?? 0,
  );
});

it.each(["160011", "180000"])(
  "rejects PostgreSQL server_version_num %s before locking or migrating",
  async (serverVersionNum) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("current_setting('server_version_num')")) {
        return { rows: [{ server_version_num: serverVersionNum }] };
      }
      throw new Error("version rejection reached database mutation");
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration({
        connectionString: "postgresql://learncoding_migrator:Fake@postgres/learncoding",
        pool,
        migrate,
        drizzle: vi.fn(() => ({})),
        requiredPostgresMajor: 17,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "ProductionPostgresVersionError",
        message: "Production migration requires PostgreSQL major 17.",
      }),
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(migrate).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledTimes(1);
  },
);

it("accepts exact PostgreSQL 17 before acquiring the migration lock", async () => {
  const query = roleAwareQuery();
  query.mockImplementationOnce(async (sql: string) => {
    expect(sql).toContain("current_setting('server_version_num')");
    return { rows: [{ server_version_num: "170012" }] };
  });
  const client = { query, release: vi.fn() };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  };
  const migrate = vi.fn(async () => undefined);

  await runProductionMigration({
    connectionString: "postgresql://learncoding_migrator:Fake@postgres/learncoding",
    pool,
    migrate,
    drizzle: vi.fn(() => ({})),
    requiredPostgresMajor: 17,
  });

  const statements = query.mock.calls.map(([sql]) => String(sql));
  expect(statements[0]).toContain("current_setting('server_version_num')");
  expect(statements[1]).toContain("pg_try_advisory_lock");
  expect(migrate).toHaveBeenCalledTimes(1);
});

it("keeps imported targeted-PG18 harnesses version-neutral by default", async () => {
  const query = roleAwareQuery();
  const client = { query, release: vi.fn() };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  };

  await runProductionMigration({
    connectionString: "postgresql://learncoding_migrator:Fake@postgres/learncoding",
    pool,
    migrate: vi.fn(async () => undefined),
    drizzle: vi.fn(() => ({})),
  });

  expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain(
    expect.stringContaining("server_version_num"),
  );
});


  it("uses the shared administration lock and migrates only as the owner role", async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("pg_try_advisory_lock")) {
        expect(parameters).toEqual(["codestead:database-administration:v1"]);
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes("current_user") && sql.includes("session_user")) {
        const assumedOwner = query.mock.calls.some(([statement]) =>
          String(statement).includes("SET ROLE learncoding_owner"),
        );
        const resetOwner = query.mock.calls.some(([statement]) =>
          String(statement).includes("RESET ROLE"),
        );
        return {
          rows: [
            assumedOwner && !resetOwner
              ? { current_user: "learncoding_owner", session_user: "learncoding_migrator" }
              : { current_user: "learncoding_migrator", session_user: "learncoding_migrator" },
          ],
        };
      }
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const migrate = vi.fn(async () => undefined);

    await runProductionMigration({
      connectionString: "postgresql://learncoding_migrator:Fake@postgres/learncoding",
      pool,
      migrate,
      drizzle: vi.fn(() => ({})),
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("SET ROLE learncoding_owner"))).toBe(true);
    expect(statements.some((sql) => sql.includes("RESET ROLE"))).toBe(true);
    const setRoleCall = query.mock.invocationCallOrder.find(
      (_, index) => statements[index]?.includes("SET ROLE learncoding_owner"),
    );
    expect(setRoleCall).toBeLessThan(migrate.mock.invocationCallOrder[0] ?? 0);
    expect(statements.at(-1)).toContain("pg_advisory_unlock");
  });

describe("production migration", () => {
  it("preserves the exact primary migration Error when cleanup also fails", async () => {
    class MigrationExecutionError extends Error {
      readonly code = "MIGRATION_EXECUTION_FAILED";
      readonly context = { phase: "migrate" };
    }
    const originalCause = new Error("driver migration failed");
    const primaryError = new MigrationExecutionError("migration execution failed");
    primaryError.name = "MigrationExecutionError";
    Object.defineProperty(primaryError, "cause", {
      value: originalCause,
      configurable: true,
      writable: true,
      enumerable: false,
    });
    const primaryStack = primaryError.stack;
    const resetError = new Error("reset cleanup failed");
    const releaseError = new Error("release cleanup failed");
    const poolError = new Error("pool cleanup failed");
    let ownerRoleAssumed = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("SET ROLE learncoding_owner")) {
        ownerRoleAssumed = true;
        return { rows: [] };
      }
      if (sql.includes("RESET ROLE")) throw resetError;
      if (sql.includes("current_user") && sql.includes("session_user")) {
        return {
          rows: [{
            current_user: ownerRoleAssumed ? "learncoding_owner" : "learncoding_migrator",
            session_user: "learncoding_migrator",
          }],
        };
      }
      return { rows: [] };
    });
    const client = {
      query,
      release: vi.fn(() => {
        throw releaseError;
      }),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {
        throw poolError;
      }),
    };

    const failure = await runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate: vi.fn(async () => {
        throw primaryError;
      }),
      drizzle: vi.fn(() => ({})),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBe(primaryError);
    expect(failure).toBeInstanceOf(MigrationExecutionError);
    expect(failure).toMatchObject({
      name: primaryError.name,
      message: primaryError.message,
      code: primaryError.code,
      context: primaryError.context,
    });
    expect((failure as Error).stack).toBe(primaryStack);
    const causeDescriptor = Object.getOwnPropertyDescriptor(failure as object, "cause");
    expect(causeDescriptor?.enumerable).toBe(false);
    const cleanupCause = (failure as Error & { cause?: unknown }).cause;
    expect(cleanupCause).toBeInstanceOf(AggregateError);
    expect((cleanupCause as AggregateError).errors).toEqual([
      resetError,
      releaseError,
      poolError,
    ]);
    expect((cleanupCause as AggregateError & { cause?: unknown }).cause).toBe(
      originalCause,
    );
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("fails closed and destroys the session when identity evidence is absent", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("current_user")) return { rows: [] };
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const migrate = vi.fn(async () => undefined);

    await expect(
      runProductionMigration({
        connectionString: "postgresql://learncoding_migrator:Fake@postgres/learncoding",
        pool,
        migrate,
        drizzle: vi.fn(() => ({})),
      }),
    ).rejects.toThrow("production migration role identity verification failed");

    expect(migrate).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("destroys the locked session when RESET ROLE fails", async () => {
    let ownerRoleAssumed = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("SET ROLE learncoding_owner")) {
        ownerRoleAssumed = true;
        return { rows: [] };
      }
      if (sql.includes("RESET ROLE")) throw new Error("reset failed");
      if (sql.includes("current_user") && sql.includes("session_user")) {
        return {
          rows: [{
            current_user: ownerRoleAssumed ? "learncoding_owner" : "learncoding_migrator",
            session_user: "learncoding_migrator",
          }],
        };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };

    await expect(
      runProductionMigration({
        connectionString: "postgresql://learncoding_migrator:Fake@postgres/learncoding",
        pool,
        migrate: vi.fn(async () => undefined),
        drizzle: vi.fn(() => ({})),
      }),
    ).rejects.toThrow("reset failed");

    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(String(query.mock.calls.at(-1)?.[0])).toContain("RESET ROLE");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_unlock"))).toBe(false);
  });

  it("polls until the advisory lock is acquired", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: false }] })
      .mockResolvedValueOnce({ rows: [{ acquired: true }] });
    const sleep = vi.fn(async () => undefined);
    let time = 0;

    await acquireMigrationLock(
      { query },
      { timeoutMs: 1000, pollMs: 25, now: () => (time += 10), sleep },
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain("pg_try_advisory_lock");
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("does not attempt the lock again after the timeout expires", async () => {
    const query = vi.fn(async () => ({ rows: [{ acquired: false }] }));
    let time = 0;
    const sleep = vi.fn(async () => {
      time = 1001;
    });

    await expect(
      acquireMigrationLock(
        { query },
        { timeoutMs: 1000, pollMs: 500, now: () => time, sleep },
      ),
    ).rejects.toMatchObject({ name: "MigrationLockTimeoutError" });

    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects a lock acquired after the timeout expires", async () => {
    let time = 0;
    const query = vi.fn(async () => {
      time = 1001;
      return { rows: [{ acquired: true }] };
    });

    await expect(
      acquireMigrationLock(
        { query },
        { timeoutMs: 1000, now: () => time },
      ),
    ).rejects.toMatchObject({ name: "MigrationLockTimeoutError" });

    expect(query).toHaveBeenCalledOnce();
  });

  it("caps a supplied lock timeout at 120 seconds", async () => {
    let time = 0;
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: false }] })
      .mockResolvedValueOnce({ rows: [{ acquired: true }] });
    const sleep = vi.fn(async () => {
      time = 120_001;
    });

    await expect(
      acquireMigrationLock(
        { query },
        { timeoutMs: 240_000, pollMs: 500, now: () => time, sleep },
      ),
    ).rejects.toMatchObject({ name: "MigrationLockTimeoutError" });

    expect(query).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects the non-finite lock timeout %s before querying",
    async (timeoutMs) => {
      const query = vi.fn(async () => ({ rows: [{ acquired: true }] }));

      await expect(
        acquireMigrationLock(
          { query },
          { timeoutMs, now: () => 0 },
        ),
      ).rejects.toBeInstanceOf(RangeError);

      expect(query).not.toHaveBeenCalled();
    },
  );

  it("destroys the session when a lock query does not resolve", async () => {
    const client = {
      query: vi.fn(() => new Promise<never>(() => undefined)),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const migrate = vi.fn(async () => undefined);
    const migration = runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate,
      drizzle: vi.fn(() => ({})),
      lockOptions: { timeoutMs: 10 },
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      migration.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.name : "unknown"),
      ),
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("still pending"), 100);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);

    expect(outcome).toBe("MigrationLockTimeoutError");
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("destroys the active session when migration exceeds its operation deadline", async () => {
    const client = {
      query: roleAwareQuery(),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const migrate = vi.fn(() => new Promise<never>(() => undefined));
    const migration = runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate,
      drizzle: vi.fn(() => ({})),
      operationTimeoutMs: 10,
      cleanupTimeoutMs: 10,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      migration.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.name : "unknown"),
      ),
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("still pending"), 100);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);

    expect(outcome).toBe("MigrationOperationTimeoutError");
    expect(migrate).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("RESET ROLE"))).toBe(false);
    expect(
      statements.some((sql) => sql.includes("pg_advisory_unlock")),
    ).toBe(false);
    expect(migrate.mock.invocationCallOrder[0]).toBeLessThan(
      client.release.mock.invocationCallOrder[0] ?? 0,
    );
    expect(client.release.mock.invocationCallOrder[0]).toBeLessThan(
      pool.end.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps migration timeout primary when forced release and pool shutdown fail", async () => {
    const releaseError = new Error("forced release failed");
    const shutdownError = new Error("pool shutdown failed");
    const client = {
      query: roleAwareQuery(),
      release: vi.fn(() => {
        throw releaseError;
      }),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {
        throw shutdownError;
      }),
    };
    const migration = runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate: vi.fn(() => new Promise<never>(() => undefined)),
      drizzle: vi.fn(() => ({})),
      operationTimeoutMs: 10,
      cleanupTimeoutMs: 10,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      migration.then(
        () => undefined,
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("still pending"), 100);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({
      name: "MigrationOperationTimeoutError",
    });
    const cause = (
      outcome as Error & { cause?: unknown }
    ).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([
      releaseError,
      shutdownError,
    ]);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("unlocks and closes resources after migration failure", async () => {
    const client = {
      query: roleAwareQuery(),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const migrate = vi.fn(async () => {
      throw new Error("migration failed");
    });
    const database = {};
    const drizzle = vi.fn(() => database);

    await expect(
      runProductionMigration({
        connectionString: "postgresql://test",
        pool,
        migrate,
        drizzle,
      }),
    ).rejects.toThrow("migration failed");
    expect(drizzle).toHaveBeenCalledWith(client);
    expect(migrate).toHaveBeenCalledWith(database, { migrationsFolder: "/app/drizzle" });
    expect(client.query.mock.invocationCallOrder[0]).toBeLessThan(
      migrate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(migrate.mock.invocationCallOrder[0]).toBeLessThan(
      client.query.mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(String(client.query.mock.calls.at(-1)?.[0])).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("destroys the session when the unlock query does not resolve", async () => {
    const client = {
      query: roleAwareQuery(
        () => new Promise<never>(() => undefined),
      ),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };
    const migration = runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate: vi.fn(async () => undefined),
      drizzle: vi.fn(() => ({})),
      unlockTimeoutMs: 10,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      migration.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.name : "unknown"),
      ),
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("still pending"), 100);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);

    expect(outcome).toBe("MigrationUnlockTimeoutError");
    expect(client.query).toHaveBeenCalledTimes(7);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("does not allow an unlock timeout override to widen the five-second bound", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        query: roleAwareQuery(
          () => new Promise<never>(() => undefined),
        ),
        release: vi.fn(),
      };
      const pool = {
        connect: vi.fn(async () => client),
        end: vi.fn(async () => undefined),
      };
      const migration = runProductionMigration({
        connectionString: "postgresql://test",
        pool,
        migrate: vi.fn(async () => undefined),
        drizzle: vi.fn(() => ({})),
        unlockTimeoutMs: 10_000,
      });
      const rejection = expect(migration).rejects.toMatchObject({
        name: "MigrationUnlockTimeoutError",
      });

      await vi.advanceTimersByTimeAsync(5_000);

      expect(client.release).toHaveBeenCalledWith(true);
      await rejection;
      expect(pool.end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not duplicate the outward cleanup failure in its cause", async () => {
    const unlockError = new Error("unlock failed");
    const releaseError = new Error("release failed");
    const releaseStack = releaseError.stack;
    const client = {
      query: roleAwareQuery(
        async () => { throw unlockError; },
      ),
      release: vi.fn(() => {
        throw releaseError;
      }),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };

    const failure = await runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate: vi.fn(async () => undefined),
      drizzle: vi.fn(() => ({})),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBe(releaseError);
    expect(failure).toMatchObject({
      name: releaseError.name,
      message: releaseError.message,
    });
    expect((failure as Error).stack).toBe(releaseStack);
    const cause = (failure as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([unlockError]);
    expect(String(client.query.mock.calls.at(-1)?.[0])).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(client.query.mock.invocationCallOrder.at(-1)).toBeLessThan(
      client.release.mock.invocationCallOrder[0] ?? 0,
    );
    expect(client.release.mock.invocationCallOrder[0]).toBeLessThan(
      pool.end.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("fails closed when PostgreSQL reports that the advisory lock was not released", async () => {
    const client = {
      query: roleAwareQuery(async () => ({ rows: [{ released: false }] })),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };

    await expect(
      runProductionMigration({
        connectionString: "postgresql://test",
        pool,
        migrate: vi.fn(async () => undefined),
        drizzle: vi.fn(() => ({})),
      }),
    ).rejects.toMatchObject({ name: "MigrationUnlockError" });

    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("bounds RESET ROLE cleanup and destroys a session that stops responding", async () => {
    let ownerRoleAssumed = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("SET ROLE learncoding_owner")) {
        ownerRoleAssumed = true;
        return { rows: [] };
      }
      if (sql.includes("RESET ROLE")) return new Promise<never>(() => undefined);
      if (sql.includes("current_user") && sql.includes("session_user")) {
        return {
          rows: [{
            current_user: ownerRoleAssumed ? "learncoding_owner" : "learncoding_migrator",
            session_user: "learncoding_migrator",
          }],
        };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };

    await expect(
      runProductionMigration({
        connectionString: "postgresql://test",
        pool,
        migrate: vi.fn(async () => undefined),
        drizzle: vi.fn(() => ({})),
        cleanupTimeoutMs: 10,
      }),
    ).rejects.toMatchObject({ name: "MigrationCleanupTimeoutError" });

    expect(client.release).toHaveBeenCalledWith(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_unlock"))).toBe(false);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("bounds post-reset identity verification and destroys an ambiguous session", async () => {
    let ownerRoleAssumed = false;
    let identityChecks = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("SET ROLE learncoding_owner")) {
        ownerRoleAssumed = true;
        return { rows: [] };
      }
      if (sql.includes("RESET ROLE")) {
        ownerRoleAssumed = false;
        return { rows: [] };
      }
      if (sql.includes("current_user") && sql.includes("session_user")) {
        identityChecks += 1;
        if (identityChecks === 3) return new Promise<never>(() => undefined);
        return {
          rows: [{
            current_user: ownerRoleAssumed ? "learncoding_owner" : "learncoding_migrator",
            session_user: "learncoding_migrator",
          }],
        };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    };

    await expect(
      runProductionMigration({
        connectionString: "postgresql://test",
        pool,
        migrate: vi.fn(async () => undefined),
        drizzle: vi.fn(() => ({})),
        cleanupTimeoutMs: 10,
      }),
    ).rejects.toMatchObject({ name: "MigrationCleanupTimeoutError" });

    expect(client.release).toHaveBeenCalledWith(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_unlock"))).toBe(false);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it.each([
    ["unlock", { unlockTimeoutMs: 0 }],
    ["cleanup", { cleanupTimeoutMs: -1 }],
  ])("rejects a non-positive %s timeout before opening a session", async (_name, override) => {
    const pool = {
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    };

    await expect(
      runProductionMigration({
        connectionString: "postgresql://test",
        pool,
        migrate: vi.fn(async () => undefined),
        drizzle: vi.fn(() => ({})),
        ...override,
      }),
    ).rejects.toBeInstanceOf(RangeError);

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("bounds pool shutdown after destroying the migration session", async () => {
    const client = {
      query: roleAwareQuery(async () => ({ rows: [{ released: true }] })),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(() => new Promise<never>(() => undefined)),
    };

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const migration = runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate: vi.fn(async () => undefined),
      drizzle: vi.fn(() => ({})),
      cleanupTimeoutMs: 10,
    });
    const outcome = await Promise.race([
      migration.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.name : "unknown"),
      ),
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("still pending"), 100);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);

    expect(outcome).toBe("MigrationCleanupTimeoutError");
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("bounds pool checkout inside the production migration operation deadline", async () => {
    const migrate = vi.fn(async () => undefined);
    const pool = {
      connect: vi.fn(() => new Promise<never>(() => undefined)),
      end: vi.fn(async () => undefined),
    };
    const startedAt = performance.now();
    const migration = runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate,
      drizzle: vi.fn(() => ({})),
      operationTimeoutMs: 25,
      cleanupTimeoutMs: 40,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      migration.then(
        () => undefined,
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("checkout watchdog expired"), 200);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);

    expect(outcome).toBeInstanceOf(AggregateError);
    const aggregate = outcome as AggregateError;
    expect(aggregate.cause).toMatchObject({
      name: "MigrationOperationTimeoutError",
      message: "Timed out during the checked-out production migration operation",
    });
    expect(aggregate.errors[0]).toBe(aggregate.cause);
    expect(aggregate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "MigrationCleanupTimeoutError" }),
      ]),
    );
    expect(performance.now() - startedAt).toBeLessThan(150);
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(migrate).not.toHaveBeenCalled();
  });

  it("destroys a checkout that resolves after the operation deadline", async () => {
    const client = {
      query: vi.fn(),
      release: vi.fn(),
    };
    let resolveCheckout: ((value: typeof client) => void) | undefined;
    const pool = {
      connect: vi.fn(() => new Promise<typeof client>((resolve) => {
        resolveCheckout = resolve;
      })),
      end: vi.fn(async () => undefined),
    };
    const migrate = vi.fn(async () => undefined);

    const failure = await runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate,
      drizzle: vi.fn(() => ({})),
      operationTimeoutMs: 25,
      cleanupTimeoutMs: 40,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toMatchObject({
      name: "MigrationOperationTimeoutError",
    });
    expect(aggregate.errors[0]).toBe(aggregate.cause);
    expect(aggregate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "MigrationCleanupTimeoutError" }),
      ]),
    );
    expect(resolveCheckout).toBeTypeOf("function");
    resolveCheckout?.(client);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.query).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("preserves a late checkout release failure with the timeout primary", async () => {
    const releaseError = new Error("late checkout forced release failed");
    const client = {
      query: vi.fn(),
      release: vi.fn(() => {
        throw releaseError;
      }),
    };
    let resolveCheckout: ((value: typeof client) => void) | undefined;
    const pool = {
      connect: vi.fn(() => new Promise<typeof client>((resolve) => {
        resolveCheckout = resolve;
      })),
      end: vi.fn(async () => undefined),
    };
    const migrate = vi.fn(async () => undefined);
    setTimeout(() => resolveCheckout?.(client), 40);

    const failure = await runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate,
      drizzle: vi.fn(() => ({})),
      operationTimeoutMs: 25,
      cleanupTimeoutMs: 100,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toMatchObject({
      name: "MigrationOperationTimeoutError",
      message: "Timed out during the checked-out production migration operation",
    });
    expect(aggregate.errors[0]).toBe(aggregate.cause);
    expect(aggregate.errors).toContain(releaseError);
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.query).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("uses one cleanup deadline across safe session restoration and pool shutdown", async () => {
    const primaryError = new Error("migration failed before cleanup");
    const phaseDelayMs = 50;
    const cleanupBudgetMs = 170;
    const pause = () => new Promise<void>((resolve) => {
      setTimeout(resolve, phaseDelayMs);
    });
    let ownerRoleAssumed = false;
    let cleanupStarted = false;
    const query = vi.fn(async (sql: string) => {
      if (cleanupStarted) await pause();
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes("SET ROLE learncoding_owner")) {
        ownerRoleAssumed = true;
        return { rows: [] };
      }
      if (sql.includes("RESET ROLE")) {
        ownerRoleAssumed = false;
        return { rows: [] };
      }
      if (sql.includes("current_user") && sql.includes("session_user")) {
        return {
          rows: [{
            current_user: ownerRoleAssumed
              ? "learncoding_owner"
              : "learncoding_migrator",
            session_user: "learncoding_migrator",
          }],
        };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [{ released: true }] };
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => {
        await pause();
      }),
    };
    const migrate = vi.fn(async () => {
      cleanupStarted = true;
      throw primaryError;
    });
    const startedAt = performance.now();

    const failure = await runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate,
      drizzle: vi.fn(() => ({})),
      cleanupTimeoutMs: cleanupBudgetMs,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const elapsedMs = performance.now() - startedAt;

    expect(failure).toBe(primaryError);
    expect(elapsedMs).toBeLessThan(190);
    const cause = (failure as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(
      (cause as AggregateError).errors.some(
        (error) => (
          error instanceof Error
          && error.name === "MigrationCleanupTimeoutError"
        ),
      ),
    ).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("shares one cleanup deadline between timeout settlement and pool shutdown", async () => {
    const lateAbortError = new Error("migration rejected after stream abort");
    let rejectMigration: ((error: Error) => void) | undefined;
    const migrate = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectMigration = reject;
    }));
    const stream = {
      destroy: vi.fn(() => {
        setTimeout(() => rejectMigration?.(lateAbortError), 80);
      }),
    };
    const client = {
      query: roleAwareQuery(),
      release: vi.fn(),
      connection: { stream },
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const startedAt = performance.now();
    const migration = runProductionMigration({
      connectionString: "postgresql://test",
      pool,
      migrate,
      drizzle: vi.fn(() => ({})),
      operationTimeoutMs: 25,
      cleanupTimeoutMs: 100,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      migration.then(
        () => undefined,
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => {
        watchdog = setTimeout(() => resolve("cleanup watchdog expired"), 300);
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);
    const elapsedMs = performance.now() - startedAt;

    expect(outcome).toMatchObject({
      name: "MigrationOperationTimeoutError",
      message: "Timed out during the checked-out production migration operation",
    });
    expect(elapsedMs).toBeLessThan(170);
    expect(stream.destroy).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(
      client.query.mock.calls.some(
        ([sql]) => String(sql).includes("RESET ROLE"),
      ),
    ).toBe(false);
  });
});
