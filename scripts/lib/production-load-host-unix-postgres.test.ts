import { describe, expect, it, vi } from "vitest";

import { createUnixSocketProductionLoadDatabase } from "./production-load-host";

describe("production load root-only PostgreSQL Unix-socket adapter", () => {
  it("rewrites the reviewed internal Compose URL to the fixed host Unix socket", async () => {
    const pool = {
      connect: vi.fn(),
      query: vi.fn(async () => ({ rows: [{ ok: true }] })),
      end: vi.fn(async () => undefined),
    };
    const factory = vi.fn(() => pool as never);

    const database = createUnixSocketProductionLoadDatabase(
      "postgresql://load%2Duser:p%40ss%2Fword@postgres:5432/learncoding",
      factory,
    );

    await expect(database.query("select 1")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(factory).toHaveBeenCalledWith({
      host: "/run/learncoding-postgres",
      port: 5432,
      user: "load-user",
      password: "p@ss/word",
      database: "learncoding",
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 5_000,
      query_timeout: 6_000,
      lock_timeout: 2_000,
      idle_in_transaction_session_timeout: 30_000,
      allowExitOnIdle: false,
    });
    expect(pool.query).toHaveBeenCalledWith("select 1", []);
    await database.close?.();
  });

  it.each([
    "",
    "not-a-url",
    "postgresql://user:secret@127.0.0.1:5432/learncoding",
    "postgresql://user:secret@postgres:5433/learncoding",
    "postgresql://user:secret@postgres:5432/",
    "postgresql://user@postgres:5432/learncoding",
    "postgresql://user:secret@postgres:5432/learncoding?sslmode=disable",
    "postgresql://user:secret@postgres:5432/learncoding#fragment",
  ])("rejects any URL outside the exact internal Compose database identity: %s", (url) => {
    const factory = vi.fn();
    expect(() => createUnixSocketProductionLoadDatabase(url, factory)).toThrow(
      /invalid_database_url/,
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("retains explicit transaction, rollback, bounded pool, and redacted errors", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        events.push(text);
        if (text === "unsafe") throw new Error("postgresql://user:secret@postgres/learncoding");
        return { rows: [] };
      }),
      release: vi.fn(() => events.push("RELEASE")),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined),
    };
    const database = createUnixSocketProductionLoadDatabase(
      "postgresql://user:secret@postgres:5432/learncoding",
      () => pool as never,
    );

    await expect(database.transaction(async (session) => {
      await session.query("unsafe");
    })).rejects.toThrow("Production load database failed: transaction_failed");
    expect(events).toEqual(["BEGIN", "unsafe", "ROLLBACK", "RELEASE"]);
  });
});
