import { describe, expect, it, vi } from "vitest";

import {
  createPostgresProductionLoadDatabase,
  createUnixSocketProductionLoadDatabase,
} from "./production-load-host";

const BOUNDED_DATABASE_OPTIONS = {
  max: 2,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 10_000,
  statement_timeout: 5_000,
  query_timeout: 6_000,
  lock_timeout: 2_000,
  idle_in_transaction_session_timeout: 30_000,
  allowExitOnIdle: false,
};

function poolFactory() {
  const pool = {
    connect: vi.fn(),
    query: vi.fn(async () => ({ rows: [] })),
    end: vi.fn(async () => undefined),
  };
  return { pool, factory: vi.fn(() => pool as never) };
}

describe("production load database deadlines", () => {
  it("bounds every loopback PostgreSQL connection, statement, lock, and client query", () => {
    const { factory } = poolFactory();

    createPostgresProductionLoadDatabase(
      "postgresql://user:secret@127.0.0.1:5432/learncoding",
      factory,
    );

    expect(factory).toHaveBeenCalledWith({
      connectionString: "postgresql://user:secret@127.0.0.1:5432/learncoding",
      ...BOUNDED_DATABASE_OPTIONS,
    });
  });

  it("applies the same deadlines to the root-only PostgreSQL Unix socket", () => {
    const { factory } = poolFactory();

    createUnixSocketProductionLoadDatabase(
      "postgresql://load-user:secret@postgres:5432/learncoding",
      factory,
    );

    expect(factory).toHaveBeenCalledWith({
      host: "/run/learncoding-postgres",
      port: 5432,
      user: "load-user",
      password: "secret",
      database: "learncoding",
      ...BOUNDED_DATABASE_OPTIONS,
    });
  });

  it("rolls back instead of committing when cancellation arrives inside a transaction", async () => {
    const events: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        events.push(text);
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
      "postgresql://user:secret@127.0.0.1:5432/learncoding",
      () => pool as never,
    );
    const controller = new AbortController();

    await expect(database.transaction(async (session) => {
      await session.query("select 1");
      controller.abort(new Error("credential=must-not-leak"));
    }, controller.signal)).rejects.toThrow(
      /^Production load database failed: transaction_failed$/,
    );

    expect(events).toEqual(["BEGIN", "select 1", "ROLLBACK", "RELEASE"]);
  });
});
