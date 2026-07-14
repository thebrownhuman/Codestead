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
});
