// @vitest-environment node

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAIL_DISPATCH_RUNTIME_BOOTSTRAP,
  planMailDispatchRuntime,
} from "../mail-dispatch-runtime-policy";
import {
  createMailDispatchBootstrapResources,
  createMailDispatchDatabaseResources,
} from "../mail-dispatch-pool";

describe("dedicated mail dispatch database resources", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs one pool and Drizzle database from an issued plan", () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://mail-worker:private@database.example/mail",
    );
    const plan = planMailDispatchRuntime();
    const on = vi.fn();
    const createdPool = {
      on,
      options: {
        max: plan.pool.maximumConnections,
        connectionTimeoutMillis: plan.timeouts.poolAcquireMs,
        idleTimeoutMillis: plan.timeouts.poolIdleMs,
      },
    };
    const createdDatabase = { kind: "dedicated-mail-drizzle" };
    const createPool = vi.fn(() => createdPool);
    const createDatabase = vi.fn(() => createdDatabase);

    const resources = createMailDispatchDatabaseResources(plan, {
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
    });
    expect(plan.timeouts.poolAcquireMs).toBe(2_000);
    expect(resources.pool).toBe(createdPool);
    expect(resources.database).toBe(createdDatabase);
    expect(resources.configurationPlan).toBe(plan);
    expect(createDatabase).toHaveBeenCalledWith(createdPool);
    expect(on).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(Object.isFrozen(resources)).toBe(true);
  });

  it("uses the application development URL without importing its pool", () => {
    const plan = planMailDispatchRuntime();
    const createPool = vi.fn(() => ({ on: vi.fn() }));

    createMailDispatchDatabaseResources(plan, {
      createPool: createPool as never,
      createDatabase: vi.fn(() => ({})) as never,
    });

    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString:
          "postgresql://learncoding:learncoding@localhost:5432/learncoding",
      }),
    );
  });

  it("rejects reconstructed plans before constructing database resources", () => {
    const issuedPlan = planMailDispatchRuntime();
    const createPool = vi.fn(() => ({}));
    const createDatabase = vi.fn(() => ({}));

    expect(() =>
      createMailDispatchDatabaseResources(structuredClone(issuedPlan), {
        createPool: createPool as never,
        createDatabase: createDatabase as never,
      }),
    ).toThrow(/issued runtime plan/i);
    expect(createPool).not.toHaveBeenCalled();
    expect(createDatabase).not.toHaveBeenCalled();
  });
  it("bootstraps exactly one dedicated pool before live runtime inspection", () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://mail-worker:private@database.example/mail",
    );
    const on = vi.fn();
    const createdPool = {
      on,
      options: {
        max: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections,
        connectionTimeoutMillis:
          MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
        idleTimeoutMillis: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
      },
    };
    const createdDatabase = { kind: "bootstrap-mail-drizzle" };
    const createPool = vi.fn(() => createdPool);
    const createDatabase = vi.fn(() => createdDatabase);

    const resources = createMailDispatchBootstrapResources({
      createPool: createPool as never,
      createDatabase: createDatabase as never,
    });
    const plan = planMailDispatchRuntime();


    expect(createPool).toHaveBeenCalledOnce();
    expect(createPool).toHaveBeenCalledWith({
      connectionString:
        "postgresql://mail-worker:private@database.example/mail",
      max: 3,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
    });
    expect(createDatabase).toHaveBeenCalledOnce();
    expect(
      plan.pool.serverCapacity.gmailReconciliationReserveConnections,
    ).toBe(createdPool.options.max);
    expect(createdPool.options.max).toBe(3);
    expect(createDatabase).toHaveBeenCalledWith(createdPool);
    expect(on).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(resources).toEqual({
      pool: createdPool,
      database: createdDatabase,
    });
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.hasOwn(resources, "configurationPlan")).toBe(false);
  });

  it("shares one frozen bootstrap constant set without startup or global-pool cycles", () => {
    expect(MAIL_DISPATCH_RUNTIME_BOOTSTRAP).toEqual({
      productionConcurrency: 1,
      poolMaximumConnections: 3,
      poolAcquireTimeoutMs: 2_000,
      poolIdleTimeoutMs: 30_000,
      otherProcessPoolMaximumConnections: 80,
    });
    expect(Object.isFrozen(MAIL_DISPATCH_RUNTIME_BOOTSTRAP)).toBe(true);

    const source = readFileSync(
      new URL("../mail-dispatch-pool.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("mail-dispatch-runtime-startup");
    expect(source).not.toContain("../db/client");
  });
});
