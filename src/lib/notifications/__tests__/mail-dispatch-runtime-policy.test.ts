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
        effectiveProviderLeaseStartsAfterTx1Commit: true,
        poolAcquireWithinTransactionBudget: false,
        poolAcquireWithinHardWatchdogBudget: true,
        shouldStopGateBeforeOauth: true,
        oauthWithinTx2: false,
        oauthDeadlineIsAggregateRequestAndAbortSettlement: true,
        shouldStopGateBeforeTx2: true,
        guardedSendWithinTx2: true,
        hardWatchdogIsMainEventLoopIndependent: true,
        hardWatchdogArmedAndReadyBeforeTx2: true,
        perDispatchWatchdogArmAckRequiredBeforePoolAcquire: true,
        hardWatchdogTimerStartsBeforeArmedAck: true,
        watchdogArmAckTimeoutIsBounded: true,
        postReleaseWatchdogDisarmDeliveryIsBounded: true,
        preProviderInitiationDatabaseTimeoutsDisabled: true,
        preProviderTx2PhaseBudgetIsAggregateDeadline: true,
        tx2LocksAndFinalLiveFenceBeforeProviderInitiation: true,
        physicalProviderFetchInitiatedSynchronously: true,
        postProviderInitiationDatabaseTimeoutsArmedBeforeAwait: true,
        postProviderTx2PhaseBudgetIsAggregateDeadline: true,
        postProviderInitiationTimeoutArmFailureIsFatalUnknown: true,
        postProviderInitiationDatabaseTimeoutsAreStarvationFallback: true,
        hardWatchdogKillsProcessOnExpiry: true,
        hardWatchdogClosesDatabaseAndProviderOnExpiry: true,
        hardWatchdogDisarmSentOnlyAfterSafeTx2CompletionAndRelease: true,
        hardWatchdogTimerClearedAfterBoundedDisarmDelivery: true,
        synchronousFatalExitBeforeNormalTx2Unlock: true,
        tx1ProviderBindingPreventsReclaimAndRetry: true,
        revocationOrderedAfterProviderStart: true,
        tx2FallbackRequiresDatabaseOnlyReconciliation: true,
      },
      liveProviderTx2PhaseOrder: [
        "sendPerDispatchWatchdogArm",
        "childStartsHardTimerBeforeArmedAck",
        "receiveArmedAckWithinDeadline",
        "acquireTx2ClientWithinHardWatchdog",
        "beginTx2AndStartAggregatePreProviderPhaseDeadline",
        "setPreProviderDatabaseTimeoutsToZero",
        "acquireLocksAndVerifyFinalLiveFence",
        "synchronouslyInitiatePhysicalProviderFetch",
        "armFinitePostInitiationDatabaseTimeouts",
        "awaitAlreadyInitiatedProviderPromise",
        "startAggregatePostProviderPhaseDeadline",
        "persistTerminalOutcome",
        "commitAndReleaseTx2",
        "sendPostReleaseWatchdogDisarm",
        "childClearsHardTimerWithinDeadline",
      ],
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
        preProviderInitiation: {
          idleInTransactionSessionTimeoutMs: 0,
          transactionTimeoutMs: 0,
        },
        postProviderInitiation: {
          idleInTransactionSessionTimeoutMs: 35_000,
          transactionTimeoutMs: 60_000,
          transactionTimeoutMinimumPostgresMajor: 17,
        },
      },
      providerLease: {
        postCommitProviderLeaseMs: 95_000,
        tx1CommitAckAllowanceMs: 15_000,
        providerLeaseStampMs: 110_000,
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
        preProviderTx2PhaseBudgetMs: 6_000,
        postProviderTx2PhaseBudgetMs: 6_000,
        watchdogArmAckMs: 2_000,
        watchdogDisarmDeliveryMs: 2_000,
        hardWatchdogMs: 55_000,
        drainMs: 100_000,
        poolCloseMs: 5_000,
        shutdownMarginMs: 5_000,
        stopMs: 120_000,
        platformStopMs: 135_000,
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.phases)).toBe(true);
    expect(Object.isFrozen(plan.liveProviderTx2PhaseOrder)).toBe(true);
    expect(Object.isFrozen(plan.dispatch)).toBe(true);
    expect(Object.isFrozen(plan.liveProviderTx2DatabaseTimeouts)).toBe(true);
    expect(
      Object.isFrozen(
        plan.liveProviderTx2DatabaseTimeouts.preProviderInitiation,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        plan.liveProviderTx2DatabaseTimeouts.postProviderInitiation,
      ),
    ).toBe(true);
    expect(Object.isFrozen(plan.providerLease)).toBe(true);
    expect(Object.isFrozen(plan.pool)).toBe(true);
    expect(Object.isFrozen(plan.pool.localReserves)).toBe(true);
    expect(Object.isFrozen(plan.pool.serverCapacity)).toBe(true);
    expect(Object.isFrozen(plan.timeouts)).toBe(true);
    expect(plan.liveProviderTx2DatabaseTimeouts).toEqual({
      preProviderInitiation: {
        idleInTransactionSessionTimeoutMs: 0,
        transactionTimeoutMs: 0,
      },
      postProviderInitiation: {
        idleInTransactionSessionTimeoutMs: 35_000,
        transactionTimeoutMs: 60_000,
        transactionTimeoutMinimumPostgresMajor: 17,
      },
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
    {
      postProviderInitiationTransactionTimeoutMs: Number.POSITIVE_INFINITY,
    },
    {
      postProviderInitiationIdleInTransactionSessionTimeoutMs: 0,
    },
    { persistenceMarginMs: 0 },
    { preProviderTx2PhaseBudgetMs: 0 },
    { postProviderTx2PhaseBudgetMs: 0 },
    { watchdogArmAckTimeoutMs: 0 },
    { watchdogDisarmDeliveryTimeoutMs: 0 },
    { hardWatchdogMs: 0 },
    { postCommitProviderLeaseMs: Number.NaN },
    { providerLeaseStampMs: Number.NaN },
    { drainTimeoutMs: 0 },
    { poolCloseTimeoutMs: 0 },
    { stopTimeoutMs: 0 },
    { platformStopMs: 0 },
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

  it("orders zero pre-init timers and synchronous fetch before finite timers", () => {
    const plan = planMailDispatchRuntime();

    expect(plan.liveProviderTx2PhaseOrder).toEqual([
      "sendPerDispatchWatchdogArm",
      "childStartsHardTimerBeforeArmedAck",
      "receiveArmedAckWithinDeadline",
      "acquireTx2ClientWithinHardWatchdog",
      "beginTx2AndStartAggregatePreProviderPhaseDeadline",
      "setPreProviderDatabaseTimeoutsToZero",
      "acquireLocksAndVerifyFinalLiveFence",
      "synchronouslyInitiatePhysicalProviderFetch",
      "armFinitePostInitiationDatabaseTimeouts",
      "awaitAlreadyInitiatedProviderPromise",
      "startAggregatePostProviderPhaseDeadline",
      "persistTerminalOutcome",
      "commitAndReleaseTx2",
      "sendPostReleaseWatchdogDisarm",
      "childClearsHardTimerWithinDeadline",
    ]);
    expect(plan.phases.hardWatchdogIsMainEventLoopIndependent).toBe(true);
    expect(plan.phases.hardWatchdogArmedAndReadyBeforeTx2).toBe(true);
    expect(plan.phases.poolAcquireWithinHardWatchdogBudget).toBe(true);
    expect(plan.phases.preProviderInitiationDatabaseTimeoutsDisabled).toBe(true);
    expect(plan.phases.preProviderTx2PhaseBudgetIsAggregateDeadline).toBe(true);
    expect(
      plan.phases.tx2LocksAndFinalLiveFenceBeforeProviderInitiation,
    ).toBe(true);
    expect(plan.phases.physicalProviderFetchInitiatedSynchronously).toBe(true);
    expect(
      plan.phases.postProviderInitiationDatabaseTimeoutsArmedBeforeAwait,
    ).toBe(true);
    expect(
      plan.phases.postProviderTx2PhaseBudgetIsAggregateDeadline,
    ).toBe(true);
    expect(
      plan.phases.postProviderInitiationTimeoutArmFailureIsFatalUnknown,
    ).toBe(true);
    expect(plan.phases.hardWatchdogKillsProcessOnExpiry).toBe(true);
    expect(
      plan.phases.hardWatchdogClosesDatabaseAndProviderOnExpiry,
    ).toBe(true);
    expect(
      plan.phases.hardWatchdogDisarmSentOnlyAfterSafeTx2CompletionAndRelease,
    ).toBe(true);
    expect(plan.phases.hardWatchdogTimerClearedAfterBoundedDisarmDelivery).toBe(true);
    expect(
      plan.liveProviderTx2DatabaseTimeouts.preProviderInitiation,
    ).toEqual({
      idleInTransactionSessionTimeoutMs: 0,
      transactionTimeoutMs: 0,
    });
    expect(
      plan.liveProviderTx2DatabaseTimeouts.postProviderInitiation,
    ).toEqual({
      idleInTransactionSessionTimeoutMs: 35_000,
      transactionTimeoutMs: 60_000,
      transactionTimeoutMinimumPostgresMajor: 17,
    });
    expect(plan.timeouts.preProviderTx2PhaseBudgetMs).toBe(6_000);
    expect(plan.timeouts.postProviderTx2PhaseBudgetMs).toBe(6_000);
    expect(plan.timeouts.hardWatchdogMs).toBe(55_000);

    expect(() => planMailDispatchRuntime({
      preProviderInitiationIdleInTransactionSessionTimeoutMs: 1,
    })).toThrow(/pre-provider idle timeout must be exactly zero/i);
    expect(() => planMailDispatchRuntime({
      preProviderInitiationTransactionTimeoutMs: 1,
    })).toThrow(/pre-provider transaction timeout must be exactly zero/i);
    expect(() => planMailDispatchRuntime({
      postProviderInitiationIdleInTransactionSessionTimeoutMs: 0,
    })).toThrow(/post-provider idle-in-transaction session timeout must be a positive safe integer/i);
    expect(() => planMailDispatchRuntime({
      postProviderInitiationTransactionTimeoutMs: 0,
    })).toThrow(/post-provider transaction timeout must be a positive safe integer/i);
  });

  it("bounds both watchdog control-plane deliveries", () => {
    const plan = planMailDispatchRuntime();

    expect(plan.phases.oauthDeadlineIsAggregateRequestAndAbortSettlement).toBe(
      true,
    );
    expect(plan.phases.perDispatchWatchdogArmAckRequiredBeforePoolAcquire).toBe(
      true,
    );
    expect(plan.phases.hardWatchdogTimerStartsBeforeArmedAck).toBe(true);
    expect(plan.phases.watchdogArmAckTimeoutIsBounded).toBe(true);
    expect(plan.phases.postReleaseWatchdogDisarmDeliveryIsBounded).toBe(true);
    expect(Object.hasOwn(plan.timeouts, "watchdogArmAckMs")).toBe(true);
    expect(Object.hasOwn(plan.timeouts, "watchdogDisarmDeliveryMs")).toBe(true);
    expect(plan.timeouts.watchdogArmAckMs).toBe(2_000);
    expect(plan.timeouts.watchdogDisarmDeliveryMs).toBe(2_000);
    expect(MAIL_DISPATCH_RUNTIME_DEFAULTS.watchdogArmAckTimeoutMs).toBe(2_000);
    expect(
      MAIL_DISPATCH_RUNTIME_DEFAULTS.watchdogDisarmDeliveryTimeoutMs,
    ).toBe(2_000);

    expect(planMailDispatchRuntime({
      watchdogArmAckTimeoutMs: 1_999,
      watchdogDisarmDeliveryTimeoutMs: 1_999,
    }).timeouts).toMatchObject({
      watchdogArmAckMs: 1_999,
      watchdogDisarmDeliveryMs: 1_999,
    });
    expect(planMailDispatchRuntime({
      watchdogArmAckTimeoutMs: 2_000,
      watchdogDisarmDeliveryTimeoutMs: 2_000,
    }).timeouts).toMatchObject({
      watchdogArmAckMs: 2_000,
      watchdogDisarmDeliveryMs: 2_000,
    });
    expect(() => planMailDispatchRuntime({
      watchdogArmAckTimeoutMs: 2_001,
    })).toThrow(/watchdog ARM acknowledgement timeout must not exceed 2000ms/i);
    expect(() => planMailDispatchRuntime({
      watchdogDisarmDeliveryTimeoutMs: 2_001,
    })).toThrow(/watchdog DISARM delivery timeout must not exceed 2000ms/i);
  });

  it("guarantees a full post-COMMIT lease from the pre-COMMIT physical stamp", () => {
    const plan = planMailDispatchRuntime();
    const leasedCorePathMs = plan.timeouts.oauthDeadlineMs
      + plan.liveProviderTx2DatabaseTimeouts.postProviderInitiation
        .transactionTimeoutMs
      + plan.timeouts.persistenceMarginMs;
    const leasedOperationalPathMs = leasedCorePathMs
      + plan.timeouts.watchdogArmAckMs
      + plan.timeouts.poolAcquireMs;

    expect(plan.phases.effectiveProviderLeaseStartsAfterTx1Commit).toBe(true);
    expect(plan.phases.shouldStopGateBeforeOauth).toBe(true);
    expect(plan.phases.oauthWithinTx2).toBe(false);
    expect(plan.phases.shouldStopGateBeforeTx2).toBe(true);
    expect(plan.phases.guardedSendWithinTx2).toBe(true);
    expect(
      plan.phases.postProviderInitiationDatabaseTimeoutsAreStarvationFallback,
    ).toBe(true);
    expect(plan.phases.synchronousFatalExitBeforeNormalTx2Unlock).toBe(true);
    expect(plan.phases.tx1ProviderBindingPreventsReclaimAndRetry).toBe(true);
    expect(plan.phases.revocationOrderedAfterProviderStart).toBe(true);
    expect(plan.phases.tx2FallbackRequiresDatabaseOnlyReconciliation).toBe(true);
    expect(plan.timeouts.oauthDeadlineMs).toBeLessThanOrEqual(20_000);
    expect(plan.timeouts.guardedSendDeadlineMs).toBeLessThanOrEqual(20_000);
    expect(plan.timeouts.providerAbortSettlementMs).toBeLessThanOrEqual(5_000);
    expect(plan.timeouts.fatalExitMarginMs).toBeLessThanOrEqual(5_000);
    expect(plan.providerLease.postCommitProviderLeaseMs).toBeLessThan(300_000);
    expect(plan.providerLease.providerLeaseStampMs).toBe(
      plan.timeouts.tx1Ms
        + plan.providerLease.postCommitProviderLeaseMs,
    );
    expect(plan.providerLease.tx1CommitAckAllowanceMs).toBe(
      plan.timeouts.tx1Ms,
    );
    expect(leasedCorePathMs).toBe(85_000);
    expect(leasedOperationalPathMs).toBe(92_000);
    expect(leasedOperationalPathMs).toBeLessThan(
      plan.providerLease.postCommitProviderLeaseMs,
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
      postCommitProviderLeaseMs: 300_000,
    })).toThrow(/provider lease/i);
    expect(() => planMailDispatchRuntime({
      postCommitProviderLeaseMs: leasedOperationalPathMs,
    })).toThrow(/dispatch path must finish before the provider lease/i);
    expect(() => planMailDispatchRuntime({
      providerLeaseStampMs: 95_000,
    })).toThrow(/lease stamp must equal TX1 plus the post-COMMIT provider lease/i);
    expect(() => planMailDispatchRuntime({
      providerLeaseStampMs: 110_001,
    })).toThrow(/lease stamp must equal TX1 plus the post-COMMIT provider lease/i);
    expect(() => planMailDispatchRuntime({
      tx1TimeoutMs: Number.MAX_SAFE_INTEGER,
    })).toThrow(/lease stamp calculation must be a safe integer/i);

    const delayedCommit = planMailDispatchRuntime({
      tx1TimeoutMs: 20_000,
    });
    expect(delayedCommit.providerLease).toEqual({
      postCommitProviderLeaseMs: 95_000,
      tx1CommitAckAllowanceMs: 20_000,
      providerLeaseStampMs: 115_000,
    });
  });

  it("accepts the greatest default-lease TX1 allowance below process stop", () => {
    const plan = planMailDispatchRuntime({
      tx1TimeoutMs: 24_000,
    });

    expect(plan.providerLease).toEqual({
      postCommitProviderLeaseMs: 95_000,
      tx1CommitAckAllowanceMs: 24_000,
      providerLeaseStampMs: 119_000,
    });
    expect(plan.providerLease.providerLeaseStampMs).toBeLessThan(
      plan.timeouts.stopMs,
    );
  });

  it.each([
    [
      "default-stop equality",
      { tx1TimeoutMs: 25_000 },
    ],
    [
      "default-stop overrun",
      { tx1TimeoutMs: 30_000 },
    ],
    [
      "platform-stop overrun",
      { tx1TimeoutMs: 60_000 },
    ],
    [
      "coordinated TX1 and stop equality",
      { tx1TimeoutMs: 20_000, stopTimeoutMs: 115_000 },
    ],
  ] as const)(
    "rejects a provider lease stamp at or after process stop: %s",
    (_caseName, overrides) => {
      expect(() => planMailDispatchRuntime(overrides)).toThrow(
        /provider lease stamp must finish before stop timeout/i,
      );
    },
  );

  it("keeps the normal TX2 path inside finite database starvation fallbacks", () => {
    const { liveProviderTx2DatabaseTimeouts, phases, timeouts } =
      planMailDispatchRuntime();
    const { postProviderInitiation } = liveProviderTx2DatabaseTimeouts;
    const guardedNetworkMs = timeouts.guardedSendDeadlineMs
      + timeouts.providerAbortSettlementMs
      + timeouts.fatalExitMarginMs;
    const tx2PathMs = timeouts.preProviderTx2PhaseBudgetMs
      + guardedNetworkMs
      + timeouts.postProviderTx2PhaseBudgetMs;
    const watchedPathMs = timeouts.poolAcquireMs + tx2PathMs;
    const fullWatchedPathMs = timeouts.watchdogArmAckMs
      + watchedPathMs;
    const absoluteWindowMs = fullWatchedPathMs
      + timeouts.watchdogDisarmDeliveryMs;

    expect(phases.poolAcquireWithinTransactionBudget).toBe(false);
    expect(timeouts.poolAcquireMs).toBe(5_000);
    expect(timeouts.poolIdleMs).toBe(30_000);
    expect(timeouts.lockMs).toBeLessThan(timeouts.statementMs);
    expect(timeouts.statementMs).toBeLessThan(timeouts.queryMs);
    expect(timeouts.queryMs).toBeLessThan(timeouts.tx1Ms);
    expect(guardedNetworkMs).toBe(30_000);
    expect(tx2PathMs).toBe(42_000);
    expect(watchedPathMs).toBe(47_000);
    expect(timeouts.watchdogArmAckMs).toBe(2_000);
    expect(timeouts.watchdogDisarmDeliveryMs).toBe(2_000);
    expect(absoluteWindowMs).toBe(51_000);
    expect(timeouts.hardWatchdogMs).toBe(55_000);
    expect(postProviderInitiation.transactionTimeoutMs).toBe(60_000);
    expect(guardedNetworkMs).toBeLessThan(
      postProviderInitiation.idleInTransactionSessionTimeoutMs,
    );
    expect(
      postProviderInitiation.idleInTransactionSessionTimeoutMs,
    ).toBeLessThan(
      postProviderInitiation.transactionTimeoutMs,
    );
    expect(tx2PathMs).toBeLessThan(timeouts.hardWatchdogMs);
    expect(watchedPathMs).toBeLessThan(timeouts.hardWatchdogMs);
    expect(absoluteWindowMs).toBeLessThan(timeouts.hardWatchdogMs);
    expect(timeouts.hardWatchdogMs).toBeLessThan(
      postProviderInitiation.transactionTimeoutMs,
    );

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
      postProviderInitiationIdleInTransactionSessionTimeoutMs: 30_000,
    })).toThrow(/locked provider window must finish before the idle-in-transaction session timeout/i);
    expect(() => planMailDispatchRuntime({
      postProviderInitiationIdleInTransactionSessionTimeoutMs: 60_000,
    })).toThrow(/idle-in-transaction session timeout must finish inside the TX2 transaction timeout/i);
    expect(() => planMailDispatchRuntime({
      hardWatchdogMs: 51_000,
    })).toThrow(/watchdog control path must finish before the hard watchdog/i);
    expect(() => planMailDispatchRuntime({
      preProviderTx2PhaseBudgetMs: 10_000,
    })).toThrow(/watchdog control path must finish before the hard watchdog/i);
    expect(() => planMailDispatchRuntime({
      postProviderInitiationTransactionTimeoutMs: 55_000,
    })).toThrow(/hard watchdog must fire before the post-provider transaction timeout/i);
    expect(() => planMailDispatchRuntime({
      hardWatchdogMs: 55_001,
    })).toThrow(/hard watchdog/i);
    expect(() => planMailDispatchRuntime({
      postProviderInitiationTransactionTimeoutMs: 60_001,
    })).toThrow(/post-provider transaction timeout/i);
  });

  it("bounds drain and stop time with strict room for pool close", () => {
    const { liveProviderTx2DatabaseTimeouts, providerLease, timeouts } =
      planMailDispatchRuntime();
    const worstSafeShutdownPathMs = timeouts.oauthDeadlineMs
      + timeouts.watchdogArmAckMs
      + timeouts.poolAcquireMs
      + liveProviderTx2DatabaseTimeouts.postProviderInitiation
        .transactionTimeoutMs
      + timeouts.persistenceMarginMs
      + timeouts.watchdogDisarmDeliveryMs
      + timeouts.poolCloseMs
      + timeouts.shutdownMarginMs;

    expect(timeouts.drainMs).toBeLessThan(105_000);
    expect(timeouts.stopMs).toBeLessThanOrEqual(120_000);
    expect(providerLease.postCommitProviderLeaseMs).toBeLessThan(
      timeouts.drainMs,
    );
    expect(providerLease.providerLeaseStampMs).toBeGreaterThan(
      timeouts.drainMs,
    );
    expect(providerLease.providerLeaseStampMs).toBeLessThan(timeouts.stopMs);
    expect(
      timeouts.drainMs + timeouts.poolCloseMs + timeouts.shutdownMarginMs,
    ).toBeLessThan(
      timeouts.stopMs,
    );
    expect(worstSafeShutdownPathMs).toBeLessThan(timeouts.stopMs);
    expect(worstSafeShutdownPathMs).toBeGreaterThan(60_000);
    expect(timeouts.stopMs).toBeLessThan(timeouts.platformStopMs);
    expect(timeouts.platformStopMs).toBe(135_000);

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
      postCommitProviderLeaseMs: 100_000,
    })).toThrow(/provider lease must finish before the drain timeout/i);
    expect(() => planMailDispatchRuntime({
      shutdownMarginMs: 0,
    })).toThrow(/shutdown margin/i);
    expect(() => planMailDispatchRuntime({
      stopTimeoutMs: 110_000,
    })).toThrow(/drain, pool close, and shutdown margin must finish before stop timeout/i);
    expect(() => planMailDispatchRuntime({
      platformStopMs: 120_000,
    })).toThrow(/process stop must finish before the platform stop/i);
    expect(() => planMailDispatchRuntime({
      platformStopMs: 135_001,
    })).toThrow(/platform stop/i);
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
        idleInTransactionProofBudgetMs: 35_000,
      } as never)).toThrow(/unknown mail dispatch runtime override/i);
      expect(() => planMailDispatchRuntime({
        tx2ProofBudgetMs: 50_000,
      } as never)).toThrow(/unknown mail dispatch runtime override/i);
      expect(() => planMailDispatchRuntime({
        idleInTransactionSessionTimeoutMs: 35_000,
      } as never)).toThrow(/unknown mail dispatch runtime override/i);
      expect(() => planMailDispatchRuntime({
        tx2TransactionTimeoutMs: 60_000,
      } as never)).toThrow(/unknown mail dispatch runtime override/i);
      expect(() => planMailDispatchRuntime({
        providerLeaseMs: 95_000,
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
