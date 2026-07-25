import { afterEach, describe, expect, it, vi } from "vitest";

import {
  planMailDispatchRuntime,
} from "../mail-dispatch-runtime-policy";
import {
  createMailDispatchDatabaseResources,
} from "../mail-dispatch-pool";
import {
  isMailDispatchRuntimeStartupInspectionForPool,
} from "../mail-dispatch-runtime-startup";

const STARTUP_ROW = Object.freeze({
  max_connections: "87",
  admin_reserved_connections: "3",
  server_version_num: "170005",
});

function poolForPlan(plan = planMailDispatchRuntime()) {
  return {
    options: {
      max: plan.pool.maximumConnections,
      connectionTimeoutMillis: plan.timeouts.poolAcquireMs,
      idleTimeoutMillis: plan.timeouts.poolIdleMs,
      lock_timeout: plan.timeouts.lockMs,
      statement_timeout: plan.timeouts.statementMs,
      query_timeout: plan.timeouts.queryMs,
    },
    query: vi.fn(async () => ({
      rows: [STARTUP_ROW],
    })),
    end: vi.fn(async () => undefined),
  };
}

describe("dedicated mail dispatch database resources", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs one inspected pool and Drizzle database from an internal issued plan", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://mail-worker:private@database.example/mail",
    );
    const plan = planMailDispatchRuntime();
    const createdPool = poolForPlan(plan);
    const createdDatabase = { kind: "dedicated-mail-drizzle" };
    const createPool = vi.fn(() => createdPool);
    const createDatabase = vi.fn(() => createdDatabase);

    const resources = await createMailDispatchDatabaseResources({
        createPool: createPool as never,
        createDatabase: createDatabase as never,
    });

    expect(createPool).toHaveBeenCalledOnce();
    expect(createPool).toHaveBeenCalledWith({
      connectionString:
        "postgresql://mail-worker:private@database.example/mail",
      max: plan.pool.maximumConnections,
      connectionTimeoutMillis: plan.timeouts.poolAcquireMs,
      idleTimeoutMillis: plan.timeouts.poolIdleMs,
      lock_timeout: plan.timeouts.lockMs,
      statement_timeout: plan.timeouts.statementMs,
      query_timeout: plan.timeouts.queryMs,
    });
    expect(plan.timeouts.poolAcquireMs).toBe(2_000);
    expect(resources.pool).toBe(createdPool);
    expect(resources.database).toBe(createdDatabase);
    expect(resources.inspection.plan.pool.maximumConnections).toBe(3);
    expect(resources.inspection.plan.timeouts.poolAcquireMs).toBe(2_000);
    expect(
      isMailDispatchRuntimeStartupInspectionForPool(
        resources.inspection,
        createdPool,
      ),
    ).toBe(true);
    for (const option of [
      "max",
      "connectionTimeoutMillis",
      "idleTimeoutMillis",
      "lock_timeout",
      "statement_timeout",
      "query_timeout",
    ] as const) {
      expect(Reflect.set(createdPool.options, option, 99)).toBe(false);
    }
    expect(createDatabase).toHaveBeenCalledWith(createdPool);
    expect(Object.isFrozen(resources)).toBe(true);
  });

  it("uses the application development URL without importing its pool", async () => {
    const createdPool = poolForPlan();
    const createPool = vi.fn(() => createdPool);

    await createMailDispatchDatabaseResources({
      createPool: createPool as never,
      createDatabase: vi.fn(() => ({})) as never,
    });

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      connectionString:
        "postgresql://learncoding:learncoding@localhost:5432/learncoding",
    }));
  });

  it("destroys the pool before returning an invalid startup snapshot", async () => {
    const createdPool = poolForPlan();
    createdPool.query.mockResolvedValueOnce({ rows: [] });
    const createPool = vi.fn(() => createdPool);
    const createDatabase = vi.fn(() => ({}));

    await expect(createMailDispatchDatabaseResources({
        createPool: createPool as never,
        createDatabase: createDatabase as never,
    })).rejects.toThrow(/startup snapshot/i);
    expect(createPool).toHaveBeenCalledOnce();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(createdPool.end).toHaveBeenCalledOnce();
  });
});
