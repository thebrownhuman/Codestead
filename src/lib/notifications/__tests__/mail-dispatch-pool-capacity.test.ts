import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { createMailDispatchDatabaseResources } from "../mail-dispatch-pool";

const STARTUP_ROW = Object.freeze({
  max_connections: "87",
  admin_reserved_connections: "3",
  server_version_num: "170005",
});

class InMemoryPgClient extends EventEmitter {
  _queryable = true;
  _ending = false;

  connect(callback: (error?: Error) => void) {
    callback();
  }

  isConnected() {
    return !this._ending;
  }

  query(
    _text: unknown,
    _values: unknown,
    callback: (
      error: Error | null,
      result: { rows: readonly [typeof STARTUP_ROW]; rowCount: number },
    ) => void,
  ) {
    callback(null, { rows: [STARTUP_ROW], rowCount: 1 });
  }

  end(callback?: () => void) {
    this._ending = true;
    this._queryable = false;
    this.emit("end");
    callback?.();
  }

  ref() {}
  unref() {}
}

describe("dedicated mail pool capacity", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reserves all three real pool slots and times out a fourth acquire at two seconds", async () => {
    const resources = await createMailDispatchDatabaseResources({
      createPool: (configuration) => new Pool({
        ...configuration,
        Client: InMemoryPgClient,
      } as unknown as PoolConfig),
      createDatabase: () => ({ kind: "dedicated-mail-database" }) as never,
    });
    const { pool } = resources;
    const holders: Array<{
      role: "tx2" | "scheduler" | "maintenance";
      client: PoolClient;
    }> = [];

    try {
      vi.useFakeTimers();

      holders.push(
        { role: "tx2", client: await pool.connect() },
        { role: "scheduler", client: await pool.connect() },
        { role: "maintenance", client: await pool.connect() },
      );

      expect(holders.map(({ role }) => role)).toEqual([
        "tx2",
        "scheduler",
        "maintenance",
      ]);
      expect(pool.options.max).toBe(3);
      expect(pool.options.connectionTimeoutMillis).toBe(2_000);
      expect(pool.totalCount).toBe(3);
      expect(pool.idleCount).toBe(0);

      let fourthSettled = false;
      const fourthAcquire = pool.connect();
      void fourthAcquire.then(
        () => {
          fourthSettled = true;
        },
        () => {
          fourthSettled = true;
        },
      );
      const rejection = expect(fourthAcquire).rejects.toThrow(
        "timeout exceeded when trying to connect",
      );

      expect(pool.waitingCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fourthSettled).toBe(false);
      expect(pool.waitingCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(fourthSettled).toBe(true);
      expect(pool.waitingCount).toBe(0);
    } finally {
      for (const { client } of holders) client.release();
      await pool.end();
    }
  });
});
