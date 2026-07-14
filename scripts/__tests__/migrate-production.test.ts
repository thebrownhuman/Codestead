import { describe, expect, it, vi } from "vitest";

import { acquireMigrationLock, runProductionMigration } from "../migrate-production.mjs";

describe("production migration", () => {
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

  it("unlocks and closes resources after migration failure", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rows: [{ released: true }] }),
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
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockImplementationOnce(() => new Promise<never>(() => undefined)),
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
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("does not allow an unlock timeout override to widen the five-second bound", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ acquired: true }] })
          .mockImplementationOnce(() => new Promise<never>(() => undefined)),
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

  it("ends the pool after unlock and release failures", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockRejectedValueOnce(new Error("unlock failed")),
      release: vi.fn(() => {
        throw new Error("release failed");
      }),
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
    ).rejects.toThrow("release failed");

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
});
