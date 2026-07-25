import { describe, expect, it, vi } from "vitest";

import { planMailDispatchRuntime } from "../mail-dispatch-runtime-policy";
import {
  inspectMailDispatchRuntime,
  isMailDispatchRuntimeStartupInspection,
  MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS,
  MAIL_DISPATCH_PRODUCTION_CONCURRENCY,
} from "../mail-dispatch-runtime-startup";

const EXACT_POOL_OPTIONS = Object.freeze({
  max: 3,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

function pool(input: Readonly<{
  options?: Readonly<{
    max?: unknown;
    connectionTimeoutMillis?: unknown;
    idleTimeoutMillis?: unknown;
  }>;
  rows?: readonly unknown[];
}> = {}) {
  return {
    options: input.options ?? EXACT_POOL_OPTIONS,
    query: vi.fn(async (text: string) => {
      void text;
      return {
        rows: input.rows ?? [{
          max_connections: "87",
          admin_reserved_connections: "3",
          server_version_num: "170005",
        }],
      };
    }),
  };
}

describe("mail dispatch runtime startup inspection", () => {
  it("inspects one exact production pool and PostgreSQL snapshot", async () => {
    const database = pool();

    const inspection = await inspectMailDispatchRuntime(database);

    expect(database.query).toHaveBeenCalledOnce();
    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain("current_setting('max_connections')");
    expect(sql).toContain(
      "current_setting('superuser_reserved_connections')",
    );
    expect(sql).toContain("current_setting('reserved_connections', true)");
    expect(sql).toContain("current_setting('server_version_num')");
    expect(inspection.postgresMajor).toBe(17);
    expect(inspection.plan.dispatch).toEqual({
      concurrency: 1,
      maximumParallelSends: 1,
    });
    expect(inspection.plan.pool).toEqual({
      maximumConnections: 3,
      dispatchConnections: 1,
      localReserves: {
        schedulerConnections: 1,
        maintenanceConnections: 1,
        totalConnections: 2,
      },
      serverCapacity: {
        maximumConnections: 87,
        adminReservedConnections: 3,
        otherProcessPoolMaximumConnections: 80,
        sumProcessPoolMaximumConnections: 83,
        gmailReconciliationReserveConnections: 1,
        remainingConnections: 0,
      },
    });
    expect(inspection.plan.timeouts).toMatchObject({
      poolAcquireMs: 5_000,
      poolIdleMs: 30_000,
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.plan)).toBe(true);
    expect(isMailDispatchRuntimeStartupInspection(inspection)).toBe(true);
  });

  it("accepts 87 connections and rejects 86 after all exact reserves", async () => {
    await expect(inspectMailDispatchRuntime(pool())).resolves.toMatchObject({
      plan: {
        pool: {
          serverCapacity: {
            remainingConnections: 0,
          },
        },
      },
    });

    await expect(inspectMailDispatchRuntime(pool({
      rows: [{
        max_connections: "86",
        admin_reserved_connections: "3",
        server_version_num: "170005",
      }],
    }))).rejects.toThrow(/reconciliation reserve/i);
  });

  it("requires PostgreSQL 17 or newer", async () => {
    await expect(inspectMailDispatchRuntime(pool({
      rows: [{
        max_connections: "87",
        admin_reserved_connections: "3",
        server_version_num: "160009",
      }],
    }))).rejects.toThrow(/PostgreSQL 17 or newer/i);

    await expect(inspectMailDispatchRuntime(pool({
      rows: [{
        max_connections: "87",
        admin_reserved_connections: "3",
        server_version_num: "180002",
      }],
    }))).resolves.toMatchObject({ postgresMajor: 18 });
  });

  it.each([
    ["maximum", { ...EXACT_POOL_OPTIONS, max: 2 }],
    ["maximum", { ...EXACT_POOL_OPTIONS, max: 4 }],
    [
      "acquire timeout",
      { ...EXACT_POOL_OPTIONS, connectionTimeoutMillis: 4_999 },
    ],
    [
      "acquire timeout",
      { ...EXACT_POOL_OPTIONS, connectionTimeoutMillis: 5_001 },
    ],
    ["idle timeout", { ...EXACT_POOL_OPTIONS, idleTimeoutMillis: 29_999 }],
    ["idle timeout", { ...EXACT_POOL_OPTIONS, idleTimeoutMillis: 30_001 }],
    [
      "configuration",
      {
        max: EXACT_POOL_OPTIONS.max,
        idleTimeoutMillis: EXACT_POOL_OPTIONS.idleTimeoutMillis,
      },
    ],
    [
      "configuration",
      {
        max: EXACT_POOL_OPTIONS.max,
        connectionTimeoutMillis: EXACT_POOL_OPTIONS.connectionTimeoutMillis,
      },
    ],
  ])("rejects production pool %s drift", async (_label, options) => {
    await expect(inspectMailDispatchRuntime(pool({ options })))
      .rejects.toThrow(/pool configuration/i);
  });

  it.each([
    [[]],
    [[
      {
        max_connections: "87",
        admin_reserved_connections: "3",
        server_version_num: "170005",
      },
      {
        max_connections: "87",
        admin_reserved_connections: "3",
        server_version_num: "170005",
      },
    ]],
    [[{
      max_connections: "87.0",
      admin_reserved_connections: "3",
      server_version_num: "170005",
    }]],
    [[{
      max_connections: "87",
      admin_reserved_connections: "-1",
      server_version_num: "170005",
    }]],
    [[{
      max_connections: "87",
      admin_reserved_connections: "3",
      server_version_num: 170_005,
    }]],
    [[{
      max_connections: "87",
      admin_reserved_connections: "3",
      server_version_num: "0170005",
    }]],
  ])("rejects a malformed PostgreSQL startup snapshot", async (rows) => {
    await expect(inspectMailDispatchRuntime(pool({ rows })))
      .rejects.toThrow(/startup snapshot/i);
  });

  it("recognizes only the exact issued inspection, plan, and major", async () => {
    const inspection = await inspectMailDispatchRuntime(pool());
    const matchingFactoryPlan = planMailDispatchRuntime({
      concurrency: MAIL_DISPATCH_PRODUCTION_CONCURRENCY,
      poolMaximumConnections: 3,
      serverMaximumConnections: 87,
      serverAdminReserveConnections: 3,
      otherProcessPoolMaximumConnections:
        MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS,
      poolAcquireTimeoutMs: 5_000,
      poolIdleTimeoutMs: 30_000,
    });

    expect(isMailDispatchRuntimeStartupInspection({
      plan: inspection.plan,
      postgresMajor: inspection.postgresMajor,
    })).toBe(false);
    expect(isMailDispatchRuntimeStartupInspection({ ...inspection }))
      .toBe(false);
    expect(isMailDispatchRuntimeStartupInspection({
      plan: { ...inspection.plan },
      postgresMajor: inspection.postgresMajor,
    })).toBe(false);
    expect(isMailDispatchRuntimeStartupInspection({
      plan: matchingFactoryPlan,
      postgresMajor: 17,
    })).toBe(false);
    expect(isMailDispatchRuntimeStartupInspection(null)).toBe(false);
  });

  it("sanitizes a failed startup query instead of leaking its details", async () => {
    const database = pool();
    database.query.mockRejectedValueOnce(
      new Error("credential=do-not-leak operation=raw-id"),
    );

    let observed: unknown;
    try {
      await inspectMailDispatchRuntime(database);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toBe(
      "Mail dispatch startup database inspection failed.",
    );
    expect(String(observed)).not.toContain("do-not-leak");
    expect(String(observed)).not.toContain("raw-id");
  });
});
