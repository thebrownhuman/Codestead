import { describe, expect, it, vi } from "vitest";

import {
  MAIL_DISPATCH_RUNTIME_DEFAULTS,
  MAIL_DISPATCH_RUNTIME_LIMITS,
  planMailDispatchRuntime,
} from "../mail-dispatch-runtime-policy";

describe("mail dispatch runtime policy", () => {
  it("plans the conservative single-send defaults as a deeply frozen value", () => {
    const plan = planMailDispatchRuntime();

    expect(plan).toEqual({
      dispatch: {
        concurrency: 1,
        maximumParallelSends: 1,
      },
      pool: {
        maximumConnections: 3,
        dispatchConnections: 1,
        localReserves: {
          schedulerConnections: 1,
          maintenanceConnections: 1,
          totalConnections: 2,
        },
        serverGlobalReserve: {
          gmailReconciliationConnections: 1,
        },
      },
      timeouts: {
        oauthDeadlineMs: 20_000,
        guardedSendDeadlineMs: 20_000,
        providerAbortSettlementMs: 5_000,
        providerTerminationMs: 5_000,
        tx1Ms: 15_000,
        tx2Ms: 50_000,
        statementMs: 5_000,
        idleInTransactionSessionMs: 35_000,
        providerLeaseMs: 100_000,
        drainMs: 105_000,
        poolCloseMs: 5_000,
        stopMs: 120_000,
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.dispatch)).toBe(true);
    expect(Object.isFrozen(plan.pool)).toBe(true);
    expect(Object.isFrozen(plan.pool.localReserves)).toBe(true);
    expect(Object.isFrozen(plan.pool.serverGlobalReserve)).toBe(true);
    expect(Object.isFrozen(plan.timeouts)).toBe(true);
    expect(Object.isFrozen(MAIL_DISPATCH_RUNTIME_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(MAIL_DISPATCH_RUNTIME_LIMITS)).toBe(true);
  });

  it("gives concurrency two a four-connection pool and exactly two send slots", () => {
    const plan = planMailDispatchRuntime({ concurrency: 2 });

    expect(plan.dispatch).toEqual({
      concurrency: 2,
      maximumParallelSends: 2,
    });
    expect(plan.pool).toEqual({
      maximumConnections: 4,
      dispatchConnections: 2,
      localReserves: {
        schedulerConnections: 1,
        maintenanceConnections: 1,
        totalConnections: 2,
      },
      serverGlobalReserve: {
        gmailReconciliationConnections: 1,
      },
    });
  });

  it("allows the maximum concurrency without lending reserved connections to sends", () => {
    const plan = planMailDispatchRuntime({ concurrency: 10 });

    expect(plan.dispatch.maximumParallelSends).toBe(10);
    expect(plan.pool.maximumConnections).toBe(12);
    expect(
      plan.pool.maximumConnections - plan.pool.localReserves.totalConnections,
    ).toBe(10);
    expect(
      plan.pool.serverGlobalReserve.gmailReconciliationConnections,
    ).toBe(1);
  });

  it.each([0, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid concurrency %s",
    (concurrency) => {
      expect(() => planMailDispatchRuntime({ concurrency })).toThrow(
        /concurrency must be an integer from 1 to 10/i,
      );
    },
  );

  it("rejects pool overrides that weaken local or server-global reserves", () => {
    expect(() => planMailDispatchRuntime({
      concurrency: 2,
      poolMaximumConnections: 3,
    })).toThrow(/pool maximum must equal concurrency plus two reserves/i);
    expect(() => planMailDispatchRuntime({
      schedulerReserveConnections: 0,
    })).toThrow(/scheduler reserve must be exactly one connection/i);
    expect(() => planMailDispatchRuntime({
      maintenanceReserveConnections: 2,
    })).toThrow(/maintenance reserve must be exactly one connection/i);
    expect(() => planMailDispatchRuntime({
      gmailReconciliationServerReserveConnections: 0,
    })).toThrow(
      /server-global Gmail reconciliation reserve must be exactly one connection/i,
    );

    expect(planMailDispatchRuntime({
      concurrency: 2,
      poolMaximumConnections: 4,
      schedulerReserveConnections: 1,
      maintenanceReserveConnections: 1,
      gmailReconciliationServerReserveConnections: 1,
    }).pool.maximumConnections).toBe(4);
  });

  it("caps OAuth and guarded send separately and keeps the path inside the lease", () => {
    const plan = planMailDispatchRuntime();
    const completeDispatchPathMs = plan.timeouts.tx1Ms
      + plan.timeouts.oauthDeadlineMs
      + plan.timeouts.tx2Ms;

    expect(plan.timeouts.oauthDeadlineMs).toBeLessThanOrEqual(20_000);
    expect(plan.timeouts.guardedSendDeadlineMs).toBeLessThanOrEqual(20_000);
    expect(plan.timeouts.providerAbortSettlementMs).toBeLessThanOrEqual(5_000);
    expect(plan.timeouts.providerTerminationMs).toBeLessThanOrEqual(5_000);
    expect(plan.timeouts.providerLeaseMs).toBeLessThan(300_000);
    expect(completeDispatchPathMs).toBeLessThan(
      plan.timeouts.providerLeaseMs,
    );

    expect(() => planMailDispatchRuntime({
      oauthDeadlineMs: 20_001,
    })).toThrow(/OAuth deadline/i);
    expect(() => planMailDispatchRuntime({
      guardedSendDeadlineMs: 20_001,
    })).toThrow(/guarded send deadline/i);
    expect(() => planMailDispatchRuntime({
      providerAbortSettlementTimeoutMs: 5_001,
    })).toThrow(/provider abort settlement timeout/i);
    expect(() => planMailDispatchRuntime({
      providerTerminationTimeoutMs: 0,
    })).toThrow(/provider termination timeout/i);
    expect(() => planMailDispatchRuntime({
      providerTerminationTimeoutMs: 5_001,
    })).toThrow(/provider termination timeout/i);
    expect(() => planMailDispatchRuntime({
      providerLeaseMs: 300_000,
    })).toThrow(/provider lease/i);
    expect(() => planMailDispatchRuntime({
      providerLeaseMs: completeDispatchPathMs,
    })).toThrow(/dispatch path must finish before the provider lease/i);
  });

  it("makes both transaction and PostgreSQL session budgets explicit and ordered", () => {
    const { timeouts } = planMailDispatchRuntime();

    expect(timeouts.tx1Ms).toBeGreaterThan(timeouts.statementMs);
    expect(timeouts.tx2Ms).toBeGreaterThan(timeouts.statementMs);
    expect(timeouts.tx2Ms).toBeGreaterThan(
      timeouts.idleInTransactionSessionMs,
    );
    expect(timeouts.idleInTransactionSessionMs).toBeGreaterThan(
      timeouts.guardedSendDeadlineMs
        + timeouts.providerAbortSettlementMs
        + timeouts.providerTerminationMs,
    );
    expect(() => planMailDispatchRuntime({
      oauthDeadlineMs: 20_000,
      idleInTransactionSessionTimeoutMs: 31_000,
    })).not.toThrow();

    expect(() => planMailDispatchRuntime({
      tx1TimeoutMs: 5_000,
    })).toThrow(/statement timeout must finish inside tx1 and tx2/i);
    expect(() => planMailDispatchRuntime({
      tx2TimeoutMs: 5_000,
    })).toThrow(/statement timeout must finish inside tx1 and tx2/i);
    expect(() => planMailDispatchRuntime({
      idleInTransactionSessionTimeoutMs: 30_000,
    })).toThrow(/guarded send, abort settlement, and termination must finish before/i);
    expect(() => planMailDispatchRuntime({
      idleInTransactionSessionTimeoutMs: 50_000,
    })).toThrow(/idle-in-transaction timeout must finish inside TX2/i);
  });

  it("bounds drain and stop time with strict room for pool close", () => {
    const { timeouts } = planMailDispatchRuntime();

    expect(timeouts.drainMs).toBeLessThanOrEqual(105_000);
    expect(timeouts.stopMs).toBeLessThanOrEqual(120_000);
    expect(timeouts.providerLeaseMs).toBeLessThanOrEqual(timeouts.drainMs);
    expect(timeouts.drainMs + timeouts.poolCloseMs).toBeLessThan(
      timeouts.stopMs,
    );

    expect(() => planMailDispatchRuntime({
      drainTimeoutMs: 105_001,
    })).toThrow(/drain timeout/i);
    expect(() => planMailDispatchRuntime({
      stopTimeoutMs: 120_001,
    })).toThrow(/stop timeout/i);
    expect(() => planMailDispatchRuntime({
      poolCloseTimeoutMs: 15_000,
    })).toThrow(/drain and pool close must finish before stop timeout/i);
    expect(() => planMailDispatchRuntime({
      providerLeaseMs: 100_000,
      drainTimeoutMs: 99_000,
    })).toThrow(/provider lease must fit inside the drain timeout/i);
  });

  it("ignores ambient configuration, emits no logs, and rejects unknown input", () => {
    vi.stubEnv("MAIL_DISPATCH_CONCURRENCY", "10");
    vi.stubEnv("DATABASE_URL", "postgres://ambient-secret");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(planMailDispatchRuntime().dispatch.concurrency).toBe(1);
      expect(() => planMailDispatchRuntime({
        concurrency: 2,
        databaseUrl: "postgres://must-not-flow-through-policy",
      } as never)).toThrow(/unknown mail dispatch runtime override/i);
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
