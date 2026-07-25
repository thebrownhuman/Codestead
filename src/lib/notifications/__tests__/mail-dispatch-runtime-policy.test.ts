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
      phases: {
        providerLeaseStartsAfterTx1Commit: true,
        poolAcquireWithinTransactionBudget: false,
        shouldStopGateBeforeOauth: true,
        oauthWithinTx2: false,
        shouldStopGateBeforeTx2: true,
        guardedSendWithinTx2: true,
        liveProviderTx2DatabaseTimeoutsDisabled: true,
        synchronousFatalExitBeforeTx2Unlock: true,
      },
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
        serverCapacity: {
          maximumConnections: 100,
          adminReservedConnections: 3,
          otherProcessPoolMaximumConnections: 80,
          sumProcessPoolMaximumConnections: 83,
          gmailReconciliationReserveConnections: 1,
          remainingConnections: 13,
        },
      },
      liveProviderTx2DatabaseTimeouts: {
        idleInTransactionSessionTimeoutMs: 0,
        transactionTimeoutMs: 0,
      },
      applicationProofBudgets: {
        idleInTransactionMs: 35_000,
        tx2Ms: 50_000,
      },
      timeouts: {
        poolAcquireMs: 5_000,
        poolIdleMs: 30_000,
        lockMs: 2_000,
        statementMs: 5_000,
        queryMs: 6_000,
        tx1Ms: 15_000,
        oauthDeadlineMs: 20_000,
        guardedSendDeadlineMs: 20_000,
        providerAbortSettlementMs: 5_000,
        fatalExitMarginMs: 5_000,
        persistenceMarginMs: 5_000,
        providerLeaseMs: 90_000,
        drainMs: 100_000,
        poolCloseMs: 5_000,
        shutdownMarginMs: 5_000,
        stopMs: 120_000,
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.phases)).toBe(true);
    expect(Object.isFrozen(plan.dispatch)).toBe(true);
    expect(Object.isFrozen(plan.liveProviderTx2DatabaseTimeouts)).toBe(true);
    expect(Object.isFrozen(plan.applicationProofBudgets)).toBe(true);
    expect(Object.isFrozen(plan.pool)).toBe(true);
    expect(Object.isFrozen(plan.pool.localReserves)).toBe(true);
    expect(Object.isFrozen(plan.pool.serverCapacity)).toBe(true);
    expect(Object.isFrozen(plan.timeouts)).toBe(true);
    expect(plan.liveProviderTx2DatabaseTimeouts).toEqual({
      idleInTransactionSessionTimeoutMs: 0,
      transactionTimeoutMs: 0,
    });
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
      serverCapacity: {
        maximumConnections: 100,
        adminReservedConnections: 3,
        otherProcessPoolMaximumConnections: 80,
        sumProcessPoolMaximumConnections: 84,
        gmailReconciliationReserveConnections: 1,
        remainingConnections: 12,
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
      plan.pool.serverCapacity.sumProcessPoolMaximumConnections,
    ).toBe(92);
    expect(plan.pool.serverCapacity.remainingConnections).toBe(4);
  });

  it.each([0, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid concurrency %s",
    (concurrency) => {
      expect(() => planMailDispatchRuntime({ concurrency })).toThrow(
        /concurrency must be an integer from 1 to 10/i,
      );
    },
  );

  it.each([
    { serverMaximumConnections: 0 },
    { serverAdminReserveConnections: 1.5 },
    { otherProcessPoolMaximumConnections: Number.POSITIVE_INFINITY },
    { poolAcquireTimeoutMs: Number.NaN },
    { poolIdleTimeoutMs: 0 },
    { lockTimeoutMs: 1.5 },
    { statementTimeoutMs: Number.POSITIVE_INFINITY },
    { queryTimeoutMs: 0 },
    { tx1TimeoutMs: Number.NaN },
    { tx2ProofBudgetMs: Number.POSITIVE_INFINITY },
    { idleInTransactionProofBudgetMs: 0 },
    { persistenceMarginMs: 0 },
    { providerLeaseMs: Number.NaN },
    { drainTimeoutMs: 0 },
    { poolCloseTimeoutMs: 0 },
    { stopTimeoutMs: 0 },
  ])("rejects invalid numeric override %#", (overrides) => {
    expect(() => planMailDispatchRuntime(overrides as never)).toThrow(
      /positive safe integer/i,
    );
  });

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
    expect(() => planMailDispatchRuntime({
      concurrency: 2,
      serverMaximumConnections: 87,
    })).toThrow(/server capacity must retain the Gmail reconciliation reserve/i);

    const exactCapacity = planMailDispatchRuntime({
      concurrency: 2,
      serverMaximumConnections: 88,
      serverAdminReserveConnections: 3,
      otherProcessPoolMaximumConnections: 80,
    });
    expect(exactCapacity.pool.serverCapacity.remainingConnections).toBe(0);
    expect(
      exactCapacity.pool.serverCapacity.sumProcessPoolMaximumConnections,
    ).toBe(84);

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
    const leasedPathMs = plan.timeouts.oauthDeadlineMs
      + plan.applicationProofBudgets.tx2Ms
      + plan.timeouts.persistenceMarginMs;

    expect(plan.phases.providerLeaseStartsAfterTx1Commit).toBe(true);
    expect(plan.phases.shouldStopGateBeforeOauth).toBe(true);
    expect(plan.phases.oauthWithinTx2).toBe(false);
    expect(plan.phases.shouldStopGateBeforeTx2).toBe(true);
    expect(plan.phases.guardedSendWithinTx2).toBe(true);
    expect(plan.phases.liveProviderTx2DatabaseTimeoutsDisabled).toBe(true);
    expect(plan.phases.synchronousFatalExitBeforeTx2Unlock).toBe(true);
    expect(plan.timeouts.oauthDeadlineMs).toBeLessThanOrEqual(20_000);
    expect(plan.timeouts.guardedSendDeadlineMs).toBeLessThanOrEqual(20_000);
    expect(plan.timeouts.providerAbortSettlementMs).toBeLessThanOrEqual(5_000);
    expect(plan.timeouts.fatalExitMarginMs).toBeLessThanOrEqual(5_000);
    expect(plan.timeouts.providerLeaseMs).toBeLessThan(300_000);
    expect(leasedPathMs).toBeLessThan(
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
      fatalExitMarginMs: 0,
    })).toThrow(/fatal exit margin/i);
    expect(() => planMailDispatchRuntime({
      fatalExitMarginMs: 5_001,
    })).toThrow(/fatal exit margin/i);
    expect(() => planMailDispatchRuntime({
      providerLeaseMs: 300_000,
    })).toThrow(/provider lease/i);
    expect(() => planMailDispatchRuntime({
      providerLeaseMs: leasedPathMs,
    })).toThrow(/dispatch path must finish before the provider lease/i);
  });

  it("separates finite proof budgets from disabled live-TX2 database timeouts", () => {
    const { applicationProofBudgets, phases, timeouts } =
      planMailDispatchRuntime();
    const guardedNetworkMs = timeouts.guardedSendDeadlineMs
      + timeouts.providerAbortSettlementMs
      + timeouts.fatalExitMarginMs;
    const tx2PathMs = (2 * timeouts.queryMs) + guardedNetworkMs;

    expect(phases.poolAcquireWithinTransactionBudget).toBe(false);
    expect(timeouts.poolAcquireMs).toBe(5_000);
    expect(timeouts.poolIdleMs).toBe(30_000);
    expect(timeouts.lockMs).toBeLessThan(timeouts.statementMs);
    expect(timeouts.statementMs).toBeLessThan(timeouts.queryMs);
    expect(timeouts.queryMs).toBeLessThan(timeouts.tx1Ms);
    expect(timeouts.queryMs).toBeLessThan(applicationProofBudgets.tx2Ms);
    expect(guardedNetworkMs).toBeLessThan(
      applicationProofBudgets.idleInTransactionMs,
    );
    expect(applicationProofBudgets.tx2Ms).toBeGreaterThan(
      applicationProofBudgets.idleInTransactionMs,
    );
    expect(tx2PathMs).toBeLessThan(applicationProofBudgets.tx2Ms);

    expect(() => planMailDispatchRuntime({
      poolAcquireTimeoutMs: 5_001,
    })).toThrow(/pool acquire timeout/i);
    expect(() => planMailDispatchRuntime({
      poolIdleTimeoutMs: 0,
    })).toThrow(/pool idle timeout/i);
    expect(() => planMailDispatchRuntime({
      lockTimeoutMs: 5_000,
    })).toThrow(/lock timeout must finish before statement timeout/i);
    expect(() => planMailDispatchRuntime({
      statementTimeoutMs: 6_000,
    })).toThrow(/statement timeout must finish before query timeout/i);
    expect(() => planMailDispatchRuntime({
      queryTimeoutMs: 15_000,
    })).toThrow(/query timeout must finish inside TX1 and TX2/i);
    expect(() => planMailDispatchRuntime({
      idleInTransactionProofBudgetMs: 30_000,
    })).toThrow(/locked provider window must finish before the idle-in-transaction proof budget/i);
    expect(() => planMailDispatchRuntime({
      idleInTransactionProofBudgetMs: 50_000,
    })).toThrow(/idle-in-transaction proof budget must finish inside the TX2 proof budget/i);
    expect(() => planMailDispatchRuntime({
      tx2ProofBudgetMs: 42_000,
    })).toThrow(/TX2 path must finish before the TX2 proof budget/i);
  });

  it("bounds drain and stop time with strict room for pool close", () => {
    const { applicationProofBudgets, timeouts } =
      planMailDispatchRuntime();
    const worstSafeShutdownPathMs = timeouts.oauthDeadlineMs
      + applicationProofBudgets.tx2Ms
      + timeouts.persistenceMarginMs
      + timeouts.poolCloseMs
      + timeouts.shutdownMarginMs;

    expect(timeouts.drainMs).toBeLessThan(105_000);
    expect(timeouts.stopMs).toBeLessThanOrEqual(120_000);
    expect(timeouts.providerLeaseMs).toBeLessThan(timeouts.drainMs);
    expect(
      timeouts.drainMs + timeouts.poolCloseMs + timeouts.shutdownMarginMs,
    ).toBeLessThan(
      timeouts.stopMs,
    );
    expect(worstSafeShutdownPathMs).toBeLessThan(timeouts.stopMs);
    expect(worstSafeShutdownPathMs).toBeGreaterThan(60_000);

    expect(() => planMailDispatchRuntime({
      drainTimeoutMs: 105_000,
    })).toThrow(/drain timeout/i);
    expect(() => planMailDispatchRuntime({
      stopTimeoutMs: 120_001,
    })).toThrow(/stop timeout/i);
    expect(() => planMailDispatchRuntime({
      poolCloseTimeoutMs: 15_000,
    })).toThrow(/drain, pool close, and shutdown margin must finish before stop timeout/i);
    expect(() => planMailDispatchRuntime({
      providerLeaseMs: 100_000,
    })).toThrow(/provider lease must finish before the drain timeout/i);
    expect(() => planMailDispatchRuntime({
      shutdownMarginMs: 0,
    })).toThrow(/shutdown margin/i);
    expect(() => planMailDispatchRuntime({
      stopTimeoutMs: 110_000,
    })).toThrow(/drain, pool close, and shutdown margin must finish before stop timeout/i);
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
      expect(() => planMailDispatchRuntime({
        idleInTransactionSessionTimeoutMs: 35_000,
      } as never)).toThrow(/unknown mail dispatch runtime override/i);
      expect(() => planMailDispatchRuntime({
        tx2TimeoutMs: 50_000,
      } as never)).toThrow(/unknown mail dispatch runtime override/i);
      expect(() => planMailDispatchRuntime(null as never)).toThrow(
        /overrides must be a plain own-property object/i,
      );
      const inherited = Object.create({ concurrency: 10 }) as Record<
        string,
        number
      >;
      expect(() => planMailDispatchRuntime(inherited)).toThrow(/inherited overrides/i);
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
