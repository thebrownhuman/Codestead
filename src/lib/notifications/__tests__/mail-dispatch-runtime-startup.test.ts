import { describe, expect, it, vi } from "vitest";

import { planMailDispatchRuntime } from "../mail-dispatch-runtime-policy";
import {
  inspectMailDispatchRuntime,
  isMailDispatchRuntimeStartupInspection,
  isMailDispatchRuntimeStartupInspectionForPool,
  MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS,
  MAIL_DISPATCH_PRODUCTION_CONCURRENCY,
  parsePostgresServerVersionNum,
  requireMailDispatchPostgresRuntime,
} from "../mail-dispatch-runtime-startup";

const EXACT_POOL_OPTIONS = Object.freeze({
  max: 3,
  connectionTimeoutMillis: 2_000,
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
      poolAcquireMs: 2_000,
      poolIdleMs: 30_000,
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.plan)).toBe(true);
    expect(isMailDispatchRuntimeStartupInspection(inspection)).toBe(true);
  });

  it("issues an exact two-second production pool acquire budget", async () => {
    const inspection = await inspectMailDispatchRuntime(pool({
      options: {
        ...EXACT_POOL_OPTIONS,
        connectionTimeoutMillis: 2_000,
      },
    }));

    expect(inspection.plan.timeouts.poolAcquireMs).toBe(2_000);
  });

  it("does not reread ambient pool capacity after the startup gate", async () => {
    let configuredMaximum = 3;
    let maximumReads = 0;
    const database = {
      options: {
        get max() {
          maximumReads += 1;
          return configuredMaximum;
        },
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 30_000,
      },
      query: vi.fn(async () => {
        configuredMaximum = 99;
        return {
          rows: [{
            max_connections: "87",
            admin_reserved_connections: "3",
            server_version_num: "170005",
          }],
        };
      }),
    };

    const inspection = await inspectMailDispatchRuntime(database);

    expect(maximumReads).toBe(1);
    expect(inspection.plan.pool.maximumConnections).toBe(3);
    expect(
      inspection.plan.pool.serverCapacity.sumProcessPoolMaximumConnections,
    ).toBe(83);
  });

  it("rejects an issued inspection and plan for a different pool identity", async () => {
    const poolA = pool();
    const poolB = pool();
    const inspection = await inspectMailDispatchRuntime(poolA);

    expect(
      isMailDispatchRuntimeStartupInspectionForPool(inspection, poolA),
    ).toBe(true);
    expect(
      isMailDispatchRuntimeStartupInspectionForPool(inspection, poolB),
    ).toBe(false);
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
      { ...EXACT_POOL_OPTIONS, connectionTimeoutMillis: 1_999 },
    ],
    [
      "acquire timeout",
      { ...EXACT_POOL_OPTIONS, connectionTimeoutMillis: 2_001 },
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
      poolAcquireTimeoutMs: 2_000,
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

describe("mail dispatch PostgreSQL runtime authority", () => {
  it.each([
    ["170000", 17],
    ["170012", 17],
    ["180000", 18],
  ])("accepts server_version_num %s as major %i", (versionNum, major) => {
    expect(parsePostgresServerVersionNum(versionNum)).toEqual({
      major,
      versionNum: Number(versionNum),
    });
  });

  it.each([
    "",
    "17",
    "17.5",
    " 170000",
    "170000 ",
    "0160000",
    "not-a-version",
  ])("rejects malformed server_version_num %j", (versionNum) => {
    expect(() => parsePostgresServerVersionNum(versionNum)).toThrow(
      expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
    );
  });

  it("accepts targeted PostgreSQL 18 while rejecting runtime majors below 17", async () => {
    const pg18 = {
      query: vi.fn(async () => ({
        rows: [{ server_version_num: "180000" }],
      })),
    };
    await expect(requireMailDispatchPostgresRuntime(pg18)).resolves.toEqual({
      major: 18,
      versionNum: 180000,
    });

    const pg16 = {
      query: vi.fn(async () => ({
        rows: [{ server_version_num: "160011" }],
      })),
    };
    await expect(requireMailDispatchPostgresRuntime(pg16)).rejects.toEqual(
      expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
    );
  });

  it.each([
    ["zero rows", []],
    [
      "multiple rows",
      [
        { server_version_num: "170000" },
        { server_version_num: "170000" },
      ],
    ],
    ["null value", [{ server_version_num: null }]],
    ["numeric value", [{ server_version_num: 170000 }]],
  ])("fails closed for %s", async (_label, rows) => {
    const database = { query: vi.fn(async () => ({ rows })) };

    await expect(requireMailDispatchPostgresRuntime(database)).rejects.toEqual(
      expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
    );
  });

  it("normalizes query failures to the fixed operational error", async () => {
    const database = {
      query: vi.fn(async () => {
        throw new Error("private connection detail");
      }),
    };

    await expect(requireMailDispatchPostgresRuntime(database)).rejects.toEqual(
      expect.objectContaining({
        name: "POSTGRES_RUNTIME_UNSUPPORTED",
        message: "Mail dispatch requires PostgreSQL 17 or newer.",
      }),
    );
  });
});
