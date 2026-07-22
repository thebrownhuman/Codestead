import { describe, expect, it, vi } from "vitest";

import { createPostgresProductionLoadDatabase } from "./production-load-host";

describe("production load PostgreSQL adapter", () => {
  it("uses one checked-out client and an explicit transaction for seed callbacks", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        events.push(text);
        return { rows: [{ ok: true }] };
      }),
      release: vi.fn(() => events.push("RELEASE")),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined),
    };
    const database = createPostgresProductionLoadDatabase(
      "postgresql://user:secret@127.0.0.1:5432/database",
      () => pool as never,
    );

    await expect(database.transaction(async (session) => {
      const result = await session.query<{ ok: boolean }>("select $1::int as ok", [1]);
      return result.rows[0]!.ok;
    })).resolves.toBe(true);

    expect(events).toEqual(["BEGIN", "select $1::int as ok", "COMMIT", "RELEASE"]);
    expect(client.query).toHaveBeenNthCalledWith(2, "select $1::int as ok", [1]);
    await database.close?.();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("rolls back, releases, and projects driver errors without embedding the database URL", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        events.push(text);
        if (text === "unsafe") throw new Error("driver password=secret");
        return { rows: [] };
      }),
      release: vi.fn(() => events.push("RELEASE")),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined),
    };
    const database = createPostgresProductionLoadDatabase(
      "postgresql://user:secret@127.0.0.1:5432/database",
      () => pool as never,
    );

    await expect(database.transaction(async (session) => {
      await session.query("unsafe");
    })).rejects.toThrow("Production load database failed: transaction_failed");
    expect(events).toEqual(["BEGIN", "unsafe", "ROLLBACK", "RELEASE"]);
  });

  it.each(["", "not-a-url", "http://db.example.test", "postgresql://remote.example.test/db?sslmode=disable"])(
    "rejects an unsafe connection configuration without opening a pool: %s",
    (connectionString) => {
      const factory = vi.fn();
      expect(() => createPostgresProductionLoadDatabase(connectionString, factory)).toThrow(
        /invalid_database_url/,
      );
      expect(factory).not.toHaveBeenCalled();
    },
  );
});
