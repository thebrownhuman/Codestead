import { describe, expect, it, vi } from "vitest";

import {
  inspectMailDispatchRuntime,
  MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS,
  MAIL_DISPATCH_PRODUCTION_CONCURRENCY,
} from "../mail-dispatch-runtime-startup";

function pool(input: Readonly<{
  maximum?: number;
  rows?: unknown[];
}> = {}) {
  return {
    options: {
      max: input.maximum ?? 3,
    },
    query: vi.fn(async (text: string) => {
      void text;
      return {
        rows: input.rows ?? [{
          max_connections: "100",
          admin_reserved_connections: "3",
        }],
      };
    }),
  };
}

describe("mail dispatch runtime startup inspection", () => {
  it("proves deliberate C=1, pool=C+2, and actual server capacity", async () => {
    const database = pool();

    const plan = await inspectMailDispatchRuntime(database, {
      concurrency: MAIL_DISPATCH_PRODUCTION_CONCURRENCY,
      otherProcessPoolMaximumConnections:
        MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS,
    });

    expect(database.query).toHaveBeenCalledOnce();
    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain("current_setting('max_connections')");
    expect(sql).toContain(
      "current_setting('superuser_reserved_connections')",
    );
    expect(sql).toContain("current_setting('reserved_connections', true)");
    expect(plan.dispatch).toEqual({
      concurrency: 1,
      maximumParallelSends: 1,
    });
    expect(plan.pool).toMatchObject({
      maximumConnections: 3,
      dispatchConnections: 1,
      localReserves: {
        schedulerConnections: 1,
        maintenanceConnections: 1,
        totalConnections: 2,
      },
      serverCapacity: {
        maximumConnections: 100,
        adminReservedConnections: 3,
        otherProcessPoolMaximumConnections: 80,
        sumProcessPoolMaximumConnections: 83,
        gmailReconciliationReserveConnections: 1,
        remainingConnections: 13,
      },
    });
  });

  it.each([undefined, 2, 4, 10, Number.NaN])(
    "rejects a pool maximum that is not exact C+2: %s",
    async (maximum) => {
      const database = pool({ maximum });
      if (maximum === undefined) {
        Reflect.deleteProperty(database.options, "max");
      }

      await expect(inspectMailDispatchRuntime(database, {
        concurrency: 1,
        otherProcessPoolMaximumConnections: 80,
      })).rejects.toThrow(/pool maximum/i);
    },
  );

  it.each([
    [[]],
    [[
      { max_connections: "100", admin_reserved_connections: "3" },
      { max_connections: "100", admin_reserved_connections: "3" },
    ]],
    [[{ max_connections: "100.5", admin_reserved_connections: "3" }]],
    [[{ max_connections: "100", admin_reserved_connections: "-1" }]],
    [[{ max_connections: 100, admin_reserved_connections: "3" }]],
  ])("rejects a malformed PostgreSQL capacity result", async (rows) => {
    await expect(inspectMailDispatchRuntime(pool({ rows }), {
      concurrency: 1,
      otherProcessPoolMaximumConnections: 80,
    })).rejects.toThrow(/capacity result/i);
  });

  it("fails startup when aggregate commitments exceed actual capacity", async () => {
    await expect(inspectMailDispatchRuntime(pool({
      rows: [{
        max_connections: "84",
        admin_reserved_connections: "3",
      }],
    }), {
      concurrency: 1,
      otherProcessPoolMaximumConnections: 80,
    })).rejects.toThrow(/reconciliation reserve/i);
  });

  it("rejects non-sequential production concurrency", async () => {
    await expect(inspectMailDispatchRuntime(pool({ maximum: 4 }), {
      concurrency: 2,
      otherProcessPoolMaximumConnections: 80,
    })).rejects.toThrow(/exactly one/i);
  });

  it("propagates a capacity-query failure and never falls back to defaults", async () => {
    const database = pool();
    const failure = new Error("capacity query unavailable");
    database.query.mockRejectedValueOnce(failure);

    await expect(inspectMailDispatchRuntime(database, {
      concurrency: 1,
      otherProcessPoolMaximumConnections: 80,
    })).rejects.toBe(failure);
  });
});
