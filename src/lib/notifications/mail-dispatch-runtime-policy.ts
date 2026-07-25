export const MAIL_DISPATCH_RUNTIME_LIMITS = Object.freeze({
  minimumConcurrency: 1,
  maximumConcurrency: 10,
  schedulerReserveConnections: 1,
  maintenanceReserveConnections: 1,
  gmailReconciliationServerReserveConnections: 1,
  maximumPoolAcquireMs: 5_000,
  maximumPoolIdleMs: 30_000,
  maximumLockMs: 5_000,
  maximumStatementMs: 10_000,
  maximumQueryMs: 15_000,
  maximumTx1Ms: 60_000,
  maximumPostProviderInitiationTransactionTimeoutMs: 60_000,
  maximumPostProviderInitiationIdleInTransactionSessionTimeoutMs: 60_000,
  maximumAggregateTx2PhaseMs: 15_000,
  maximumWatchdogArmAckMs: 2_000,
  maximumWatchdogDisarmDeliveryMs: 2_000,
  maximumHardWatchdogMs: 55_000,
  maximumProviderRequestMs: 20_000,
  maximumProviderAbortSettlementMs: 5_000,
  maximumFatalExitMarginMs: 5_000,
  maximumPersistenceMarginMs: 10_000,
  exclusiveMaximumPostCommitProviderLeaseMs: 300_000,
  exclusiveMaximumProviderLeaseStampMs: 300_000,
  exclusiveMaximumDrainMs: 105_000,
  maximumPoolCloseMs: 15_000,
  maximumShutdownMarginMs: 15_000,
  maximumStopMs: 120_000,
  maximumPlatformStopMs: 135_000,
});

export const MAIL_DISPATCH_RUNTIME_DEFAULTS = Object.freeze({
  concurrency: 1,
  schedulerReserveConnections: 1,
  maintenanceReserveConnections: 1,
  gmailReconciliationServerReserveConnections: 1,
  serverMaximumConnections: 100,
  serverAdminReserveConnections: 3,
  otherProcessPoolMaximumConnections: 80,
  poolAcquireTimeoutMs: 5_000,
  poolIdleTimeoutMs: 30_000,
  lockTimeoutMs: 2_000,
  statementTimeoutMs: 5_000,
  queryTimeoutMs: 6_000,
  tx1TimeoutMs: 15_000,
  oauthDeadlineMs: 20_000,
  guardedSendDeadlineMs: 20_000,
  providerAbortSettlementTimeoutMs: 5_000,
  fatalExitMarginMs: 5_000,
  preProviderInitiationIdleInTransactionSessionTimeoutMs: 0,
  preProviderInitiationTransactionTimeoutMs: 0,
  postProviderInitiationIdleInTransactionSessionTimeoutMs: 35_000,
  postProviderInitiationTransactionTimeoutMs: 60_000,
  preProviderTx2PhaseBudgetMs: 6_000,
  postProviderTx2PhaseBudgetMs: 6_000,
  watchdogArmAckTimeoutMs: 2_000,
  watchdogDisarmDeliveryTimeoutMs: 2_000,
  hardWatchdogMs: 55_000,
  persistenceMarginMs: 5_000,
  postCommitProviderLeaseMs: 95_000,
  providerLeaseStampMs: 110_000,
  drainTimeoutMs: 100_000,
  poolCloseTimeoutMs: 5_000,
  shutdownMarginMs: 5_000,
  stopTimeoutMs: 120_000,
  platformStopMs: 135_000,
});

export type MailDispatchRuntimeOverrides = Readonly<{
  concurrency?: number;
  poolMaximumConnections?: number;
  schedulerReserveConnections?: number;
  maintenanceReserveConnections?: number;
  gmailReconciliationServerReserveConnections?: number;
  serverMaximumConnections?: number;
  serverAdminReserveConnections?: number;
  otherProcessPoolMaximumConnections?: number;
  poolAcquireTimeoutMs?: number;
  poolIdleTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
  tx1TimeoutMs?: number;
  oauthDeadlineMs?: number;
  guardedSendDeadlineMs?: number;
  providerAbortSettlementTimeoutMs?: number;
  fatalExitMarginMs?: number;
  preProviderInitiationIdleInTransactionSessionTimeoutMs?: number;
  preProviderInitiationTransactionTimeoutMs?: number;
  postProviderInitiationIdleInTransactionSessionTimeoutMs?: number;
  postProviderInitiationTransactionTimeoutMs?: number;
  preProviderTx2PhaseBudgetMs?: number;
  postProviderTx2PhaseBudgetMs?: number;
  watchdogArmAckTimeoutMs?: number;
  watchdogDisarmDeliveryTimeoutMs?: number;
  hardWatchdogMs?: number;
  persistenceMarginMs?: number;
  postCommitProviderLeaseMs?: number;
  providerLeaseStampMs?: number;
  drainTimeoutMs?: number;
  poolCloseTimeoutMs?: number;
  shutdownMarginMs?: number;
  stopTimeoutMs?: number;
  platformStopMs?: number;
}>;

export type MailDispatchRuntimePlan = Readonly<{
  phases: Readonly<{
    effectiveProviderLeaseStartsAfterTx1Commit: true;
    poolAcquireWithinTransactionBudget: false;
    poolAcquireWithinHardWatchdogBudget: true;
    shouldStopGateBeforeOauth: true;
    oauthDeadlineIsAggregateRequestAndAbortSettlement: true;
    oauthWithinTx2: false;
    shouldStopGateBeforeTx2: true;
    guardedSendWithinTx2: true;
    hardWatchdogIsMainEventLoopIndependent: true;
    hardWatchdogArmedAndReadyBeforeTx2: true;
    perDispatchWatchdogArmAckRequiredBeforePoolAcquire: true;
    hardWatchdogTimerStartsBeforeArmedAck: true;
    watchdogArmAckTimeoutIsBounded: true;
    preProviderInitiationDatabaseTimeoutsDisabled: true;
    preProviderTx2PhaseBudgetIsAggregateDeadline: true;
    tx2LocksAndFinalLiveFenceBeforeProviderInitiation: true;
    physicalProviderFetchInitiatedSynchronously: true;
    postProviderInitiationDatabaseTimeoutsArmedBeforeAwait: true;
    postProviderTx2PhaseBudgetIsAggregateDeadline: true;
    postProviderInitiationTimeoutArmFailureIsFatalUnknown: true;
    postProviderInitiationDatabaseTimeoutsAreStarvationFallback: true;
    hardWatchdogKillsProcessOnExpiry: true;
    hardWatchdogClosesDatabaseAndProviderOnExpiry: true;
    postReleaseWatchdogDisarmDeliveryIsBounded: true;
    hardWatchdogDisarmSentOnlyAfterSafeTx2CompletionAndRelease: true;
    hardWatchdogTimerClearedAfterBoundedDisarmDelivery: true;
    synchronousFatalExitBeforeNormalTx2Unlock: true;
    tx1ProviderBindingPreventsReclaimAndRetry: true;
    revocationOrderedAfterProviderStart: true;
    tx2FallbackRequiresDatabaseOnlyReconciliation: true;
  }>;
  liveProviderTx2PhaseOrder: readonly [
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
  ];
  dispatch: Readonly<{
    concurrency: number;
    maximumParallelSends: number;
  }>;
  pool: Readonly<{
    /** Applies only to the mail worker pool, not the reconciler process. */
    maximumConnections: number;
    dispatchConnections: number;
    localReserves: Readonly<{
      schedulerConnections: number;
      maintenanceConnections: number;
      totalConnections: number;
    }>;
    /**
     * Proves capacity at the shared PostgreSQL server. The Gmail reconciler is
     * a separate process/pool and consumes the explicitly retained reserve.
     */
    serverCapacity: Readonly<{
      maximumConnections: number;
      adminReservedConnections: number;
      otherProcessPoolMaximumConnections: number;
      sumProcessPoolMaximumConnections: number;
      gmailReconciliationReserveConnections: number;
      remainingConnections: number;
    }>;
  }>;
  /**
   * SET LOCAL values are exactly zero through TX2 lock acquisition and the
   * final live fence, so a database timer cannot open a pre-call revocation
   * seam. Physical fetch initiation is a direct synchronous call, never a
   * deferred Promise callback. Immediately after initiation, finite
   * starvation fallbacks are armed before awaiting the already-live request.
   * PostgreSQL 16 uses the post-initiation idle timeout plus finite query
   * guards; transaction_timeout is additionally applied on PostgreSQL 17+.
   *
   * A main-event-loop-independent child starts the hard watchdog timer before
   * acknowledging each per-dispatch ARM. The parent must receive ARMED within
   * the returned ARM/ACK bound before pool checkout. It kills the process and
   * closes database/provider transports if the main loop freezes before
   * post-initiation timers are armed. Failure to arm those timers after
   * provider initiation is fatal/unknown and cannot retry. The watchdog
   * covers both bounded control-plane deliveries, the bounded pool checkout,
   * and TX2. The pre-provider and post-provider phase budgets are aggregate
   * runtime deadlines, not aliases for a per-query timeout; integration must
   * enforce each across all statements in its phase.
   *
   * The PostgreSQL 17 transaction timer begins when the finite value is SET
   * after provider initiation, not at BEGIN or fetch; the independent watchdog
   * remains the authoritative hard cap.
   *
   * The parent sends DISARM only after safe TX2 completion, COMMIT, and client
   * release. The child must receive it and clear the timer within the returned
   * DISARM delivery bound.
   *
   * oauthDeadlineMs is the aggregate OAuth request-and-abort-settlement
   * deadline. Integration must enforce one absolute deadline across both
   * portions; it must not add the abort-settlement allowance after the
   * returned OAuth deadline.
   *
   * The durable TX1 started/binding state prevents reclaim or retry; late
   * outcome handling is database-only reconciliation, with revocation ordered
   * after provider start rather than blocked.
   */
  liveProviderTx2DatabaseTimeouts: Readonly<{
    preProviderInitiation: Readonly<{
      idleInTransactionSessionTimeoutMs: 0;
      transactionTimeoutMs: 0;
    }>;
    postProviderInitiation: Readonly<{
      idleInTransactionSessionTimeoutMs: number;
      transactionTimeoutMs: number;
      transactionTimeoutMinimumPostgresMajor: 17;
    }>;
  }>;
  /**
   * The physical stamp is persisted inside TX1. Including the full TX1
   * commit-ack allowance guarantees the effective lease after COMMIT without
   * a second write: stamp = TX1 allowance + post-COMMIT lease.
   * Every configured stamp must also expire strictly before process stop, so
   * no accepted override can outlive either process or platform termination.
   */
  providerLease: Readonly<{
    postCommitProviderLeaseMs: number;
    tx1CommitAckAllowanceMs: number;
    providerLeaseStampMs: number;
  }>;
  timeouts: Readonly<{
    poolAcquireMs: number;
    poolIdleMs: number;
    lockMs: number;
    statementMs: number;
    queryMs: number;
    tx1Ms: number;
    /**
     * Aggregate OAuth request plus abort-settlement deadline.
     */
    oauthDeadlineMs: number;
    guardedSendDeadlineMs: number;
    providerAbortSettlementMs: number;
    fatalExitMarginMs: number;
    persistenceMarginMs: number;
    preProviderTx2PhaseBudgetMs: number;
    postProviderTx2PhaseBudgetMs: number;
    watchdogArmAckMs: number;
    watchdogDisarmDeliveryMs: number;
    hardWatchdogMs: number;
    drainMs: number;
    poolCloseMs: number;
    shutdownMarginMs: number;
    stopMs: number;
    platformStopMs: number;
  }>;
}>;

const OVERRIDE_KEYS = Object.freeze([
  "concurrency",
  "poolMaximumConnections",
  "schedulerReserveConnections",
  "maintenanceReserveConnections",
  "gmailReconciliationServerReserveConnections",
  "serverMaximumConnections",
  "serverAdminReserveConnections",
  "otherProcessPoolMaximumConnections",
  "poolAcquireTimeoutMs",
  "poolIdleTimeoutMs",
  "lockTimeoutMs",
  "statementTimeoutMs",
  "queryTimeoutMs",
  "tx1TimeoutMs",
  "oauthDeadlineMs",
  "guardedSendDeadlineMs",
  "providerAbortSettlementTimeoutMs",
  "fatalExitMarginMs",
  "preProviderInitiationIdleInTransactionSessionTimeoutMs",
  "preProviderInitiationTransactionTimeoutMs",
  "postProviderInitiationIdleInTransactionSessionTimeoutMs",
  "postProviderInitiationTransactionTimeoutMs",
  "preProviderTx2PhaseBudgetMs",
  "postProviderTx2PhaseBudgetMs",
  "watchdogArmAckTimeoutMs",
  "watchdogDisarmDeliveryTimeoutMs",
  "hardWatchdogMs",
  "persistenceMarginMs",
  "postCommitProviderLeaseMs",
  "providerLeaseStampMs",
  "drainTimeoutMs",
  "poolCloseTimeoutMs",
  "shutdownMarginMs",
  "stopTimeoutMs",
  "platformStopMs",
] as const);

type OverrideKey = (typeof OVERRIDE_KEYS)[number];
type DefaultKey = keyof typeof MAIL_DISPATCH_RUNTIME_DEFAULTS;

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertKnownOverrides(overrides: MailDispatchRuntimeOverrides): void {
  if (
    overrides === null
    || typeof overrides !== "object"
    || Array.isArray(overrides)
  ) {
    throw new Error(
      "Mail dispatch runtime overrides must be a plain own-property object.",
    );
  }

  const prototype = Object.getPrototypeOf(overrides);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Mail dispatch runtime inherited overrides are forbidden.");
  }

  for (const key of Reflect.ownKeys(overrides)) {
    if (
      typeof key !== "string"
      || !OVERRIDE_KEYS.includes(key as OverrideKey)
    ) {
      throw new Error(`Unknown mail dispatch runtime override: ${String(key)}.`);
    }
  }
}

function configured(
  overrides: MailDispatchRuntimeOverrides,
  key: DefaultKey,
): number {
  if (!hasOwn(overrides, key)) {
    return MAIL_DISPATCH_RUNTIME_DEFAULTS[key];
  }

  return (overrides as Record<string, unknown>)[key] as number;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertMaximum(
  value: number,
  maximum: number,
  label: string,
): void {
  if (value > maximum) {
    throw new Error(`${label} must not exceed ${maximum}ms.`);
  }
}

/**
 * Resolves only explicit, non-secret numeric inputs. Environment parsing and
 * process lifecycle effects belong to the composition layer.
 */
export function planMailDispatchRuntime(
  overrides: MailDispatchRuntimeOverrides = {},
): MailDispatchRuntimePlan {
  assertKnownOverrides(overrides);

  const concurrency = configured(overrides, "concurrency");
  if (
    !Number.isSafeInteger(concurrency)
    || concurrency < MAIL_DISPATCH_RUNTIME_LIMITS.minimumConcurrency
    || concurrency > MAIL_DISPATCH_RUNTIME_LIMITS.maximumConcurrency
  ) {
    throw new Error("Mail dispatch concurrency must be an integer from 1 to 10.");
  }

  const schedulerReserveConnections = configured(
    overrides,
    "schedulerReserveConnections",
  );
  if (
    schedulerReserveConnections
    !== MAIL_DISPATCH_RUNTIME_LIMITS.schedulerReserveConnections
  ) {
    throw new Error("Mail scheduler reserve must be exactly one connection.");
  }
  const maintenanceReserveConnections = configured(
    overrides,
    "maintenanceReserveConnections",
  );
  if (
    maintenanceReserveConnections
    !== MAIL_DISPATCH_RUNTIME_LIMITS.maintenanceReserveConnections
  ) {
    throw new Error(
      "Mail maintenance reserve must be exactly one connection.",
    );
  }
  const gmailReconciliationServerReserveConnections = configured(
    overrides,
    "gmailReconciliationServerReserveConnections",
  );
  if (
    gmailReconciliationServerReserveConnections
    !== MAIL_DISPATCH_RUNTIME_LIMITS
      .gmailReconciliationServerReserveConnections
  ) {
    throw new Error(
      "Mail server-global Gmail reconciliation reserve must be exactly one connection.",
    );
  }

  const reservedConnections = schedulerReserveConnections
    + maintenanceReserveConnections;
  const expectedPoolMaximum = concurrency + reservedConnections;
  const poolMaximumConnections = hasOwn(overrides, "poolMaximumConnections")
    ? (overrides as Record<string, unknown>).poolMaximumConnections as number
    : expectedPoolMaximum;
  if (
    !Number.isSafeInteger(poolMaximumConnections)
    || poolMaximumConnections !== expectedPoolMaximum
  ) {
    throw new Error(
      "Mail dispatch pool maximum must equal concurrency plus two reserves.",
    );
  }

  const serverMaximumConnections = configured(
    overrides,
    "serverMaximumConnections",
  );
  const serverAdminReserveConnections = configured(
    overrides,
    "serverAdminReserveConnections",
  );
  const otherProcessPoolMaximumConnections = configured(
    overrides,
    "otherProcessPoolMaximumConnections",
  );
  for (const [label, value] of [
    ["Mail server maximum connections", serverMaximumConnections],
    ["Mail server admin reserve connections", serverAdminReserveConnections],
    [
      "Mail other-process pool maximum connections",
      otherProcessPoolMaximumConnections,
    ],
  ] as const) {
    assertPositiveInteger(value, label);
  }

  const sumProcessPoolMaximumConnections =
    otherProcessPoolMaximumConnections + poolMaximumConnections;
  const remainingConnections = serverMaximumConnections
    - serverAdminReserveConnections
    - sumProcessPoolMaximumConnections
    - gmailReconciliationServerReserveConnections;
  if (
    !Number.isSafeInteger(sumProcessPoolMaximumConnections)
    || !Number.isSafeInteger(remainingConnections)
    || remainingConnections < 0
  ) {
    throw new Error(
      "Mail server capacity must retain the Gmail reconciliation reserve.",
    );
  }

  const poolAcquireTimeoutMs = configured(overrides, "poolAcquireTimeoutMs");
  const poolIdleTimeoutMs = configured(overrides, "poolIdleTimeoutMs");
  const lockTimeoutMs = configured(overrides, "lockTimeoutMs");
  const statementTimeoutMs = configured(overrides, "statementTimeoutMs");
  const queryTimeoutMs = configured(overrides, "queryTimeoutMs");
  const tx1TimeoutMs = configured(overrides, "tx1TimeoutMs");
  const oauthDeadlineMs = configured(
    overrides,
    "oauthDeadlineMs",
  );
  assertPositiveInteger(
    oauthDeadlineMs,
    "Mail OAuth deadline",
  );
  if (
    oauthDeadlineMs
    > MAIL_DISPATCH_RUNTIME_LIMITS.maximumProviderRequestMs
  ) {
    throw new Error("Mail OAuth deadline must not exceed 20000ms.");
  }

  const guardedSendDeadlineMs = configured(
    overrides,
    "guardedSendDeadlineMs",
  );
  assertPositiveInteger(
    guardedSendDeadlineMs,
    "Mail guarded send deadline",
  );
  if (
    guardedSendDeadlineMs
    > MAIL_DISPATCH_RUNTIME_LIMITS.maximumProviderRequestMs
  ) {
    throw new Error("Mail guarded send deadline must not exceed 20000ms.");
  }

  const providerAbortSettlementTimeoutMs = configured(
    overrides,
    "providerAbortSettlementTimeoutMs",
  );
  assertPositiveInteger(
    providerAbortSettlementTimeoutMs,
    "Mail provider abort settlement timeout",
  );
  if (
    providerAbortSettlementTimeoutMs
    > MAIL_DISPATCH_RUNTIME_LIMITS.maximumProviderAbortSettlementMs
  ) {
    throw new Error(
      "Mail provider abort settlement timeout must not exceed 5000ms.",
    );
  }

  const fatalExitMarginMs = configured(overrides, "fatalExitMarginMs");
  assertPositiveInteger(
    fatalExitMarginMs,
    "Mail fatal exit margin",
  );
  if (
    fatalExitMarginMs
    > MAIL_DISPATCH_RUNTIME_LIMITS.maximumFatalExitMarginMs
  ) {
    throw new Error("Mail fatal exit margin must not exceed 5000ms.");
  }

  const preProviderInitiationIdleInTransactionSessionTimeoutMs = configured(
    overrides,
    "preProviderInitiationIdleInTransactionSessionTimeoutMs",
  );
  const preProviderInitiationTransactionTimeoutMs = configured(
    overrides,
    "preProviderInitiationTransactionTimeoutMs",
  );
  const postProviderInitiationTransactionTimeoutMs = configured(
    overrides,
    "postProviderInitiationTransactionTimeoutMs",
  );
  const postProviderInitiationIdleInTransactionSessionTimeoutMs = configured(
    overrides,
    "postProviderInitiationIdleInTransactionSessionTimeoutMs",
  );
  const preProviderTx2PhaseBudgetMs = configured(
    overrides,
    "preProviderTx2PhaseBudgetMs",
  );
  const postProviderTx2PhaseBudgetMs = configured(
    overrides,
    "postProviderTx2PhaseBudgetMs",
  );
  const watchdogArmAckTimeoutMs = configured(
    overrides,
    "watchdogArmAckTimeoutMs",
  );
  const watchdogDisarmDeliveryTimeoutMs = configured(
    overrides,
    "watchdogDisarmDeliveryTimeoutMs",
  );
  const hardWatchdogMs = configured(overrides, "hardWatchdogMs");
  const persistenceMarginMs = configured(overrides, "persistenceMarginMs");
  const postCommitProviderLeaseMs = configured(
    overrides,
    "postCommitProviderLeaseMs",
  );
  const drainTimeoutMs = configured(overrides, "drainTimeoutMs");
  const poolCloseTimeoutMs = configured(overrides, "poolCloseTimeoutMs");
  const shutdownMarginMs = configured(overrides, "shutdownMarginMs");
  const stopTimeoutMs = configured(overrides, "stopTimeoutMs");
  const platformStopMs = configured(overrides, "platformStopMs");

  if (preProviderInitiationIdleInTransactionSessionTimeoutMs !== 0) {
    throw new Error(
      "Mail pre-provider idle timeout must be exactly zero.",
    );
  }
  if (preProviderInitiationTransactionTimeoutMs !== 0) {
    throw new Error(
      "Mail pre-provider transaction timeout must be exactly zero.",
    );
  }

  for (const [label, value] of [
    ["Mail pool acquire timeout", poolAcquireTimeoutMs],
    ["Mail pool idle timeout", poolIdleTimeoutMs],
    ["Mail lock timeout", lockTimeoutMs],
    ["Mail statement timeout", statementTimeoutMs],
    ["Mail query timeout", queryTimeoutMs],
    ["Mail TX1 timeout", tx1TimeoutMs],
    [
      "Mail post-provider transaction timeout",
      postProviderInitiationTransactionTimeoutMs,
    ],
    [
      "Mail post-provider idle-in-transaction session timeout",
      postProviderInitiationIdleInTransactionSessionTimeoutMs,
    ],
    ["Mail pre-provider aggregate TX2 phase budget", preProviderTx2PhaseBudgetMs],
    ["Mail post-provider aggregate TX2 phase budget", postProviderTx2PhaseBudgetMs],
    [
      "Mail watchdog ARM acknowledgement timeout",
      watchdogArmAckTimeoutMs,
    ],
    [
      "Mail watchdog DISARM delivery timeout",
      watchdogDisarmDeliveryTimeoutMs,
    ],
    ["Mail hard watchdog", hardWatchdogMs],
    ["Mail persistence margin", persistenceMarginMs],
    ["Mail post-COMMIT provider lease", postCommitProviderLeaseMs],
    ["Mail drain timeout", drainTimeoutMs],
    ["Mail pool close timeout", poolCloseTimeoutMs],
    ["Mail shutdown margin", shutdownMarginMs],
    ["Mail stop timeout", stopTimeoutMs],
    ["Mail platform stop", platformStopMs],
  ] as const) {
    assertPositiveInteger(value, label);
  }

  const expectedProviderLeaseStampMs = tx1TimeoutMs
    + postCommitProviderLeaseMs;
  if (!Number.isSafeInteger(expectedProviderLeaseStampMs)) {
    throw new Error(
      "Mail provider lease stamp calculation must be a safe integer.",
    );
  }
  const providerLeaseStampMs = hasOwn(overrides, "providerLeaseStampMs")
    ? (overrides as Record<string, unknown>).providerLeaseStampMs as number
    : expectedProviderLeaseStampMs;
  assertPositiveInteger(providerLeaseStampMs, "Mail provider lease stamp");
  if (providerLeaseStampMs !== expectedProviderLeaseStampMs) {
    throw new Error(
      "Mail provider lease stamp must equal TX1 plus the post-COMMIT provider lease.",
    );
  }

  assertMaximum(
    poolAcquireTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumPoolAcquireMs,
    "Mail pool acquire timeout",
  );
  assertMaximum(
    poolIdleTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumPoolIdleMs,
    "Mail pool idle timeout",
  );
  assertMaximum(
    lockTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumLockMs,
    "Mail lock timeout",
  );
  assertMaximum(
    statementTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumStatementMs,
    "Mail statement timeout",
  );
  assertMaximum(
    queryTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumQueryMs,
    "Mail query timeout",
  );
  assertMaximum(
    tx1TimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumTx1Ms,
    "Mail TX1 timeout",
  );
  assertMaximum(
    postProviderInitiationTransactionTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS
      .maximumPostProviderInitiationTransactionTimeoutMs,
    "Mail post-provider transaction timeout",
  );
  assertMaximum(
    postProviderInitiationIdleInTransactionSessionTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS
      .maximumPostProviderInitiationIdleInTransactionSessionTimeoutMs,
    "Mail post-provider idle-in-transaction session timeout",
  );
  assertMaximum(
    preProviderTx2PhaseBudgetMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumAggregateTx2PhaseMs,
    "Mail pre-provider aggregate TX2 phase budget",
  );
  assertMaximum(
    postProviderTx2PhaseBudgetMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumAggregateTx2PhaseMs,
    "Mail post-provider aggregate TX2 phase budget",
  );
  assertMaximum(
    watchdogArmAckTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumWatchdogArmAckMs,
    "Mail watchdog ARM acknowledgement timeout",
  );
  assertMaximum(
    watchdogDisarmDeliveryTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumWatchdogDisarmDeliveryMs,
    "Mail watchdog DISARM delivery timeout",
  );
  assertMaximum(
    hardWatchdogMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumHardWatchdogMs,
    "Mail hard watchdog",
  );
  assertMaximum(
    persistenceMarginMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumPersistenceMarginMs,
    "Mail persistence margin",
  );
  assertMaximum(
    poolCloseTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumPoolCloseMs,
    "Mail pool close timeout",
  );
  assertMaximum(
    shutdownMarginMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumShutdownMarginMs,
    "Mail shutdown margin",
  );

  assertMaximum(
    platformStopMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumPlatformStopMs,
    "Mail platform stop",
  );
  if (lockTimeoutMs >= statementTimeoutMs) {
    throw new Error(
      "Mail lock timeout must finish before statement timeout.",
    );
  }
  if (statementTimeoutMs >= queryTimeoutMs) {
    throw new Error(
      "Mail statement timeout must finish before query timeout.",
    );
  }
  if (
    queryTimeoutMs >= tx1TimeoutMs
    || queryTimeoutMs >= postProviderInitiationTransactionTimeoutMs
  ) {
    throw new Error("Mail query timeout must finish inside TX1 and TX2.");
  }

  const lockedProviderWindowMs = guardedSendDeadlineMs
    + providerAbortSettlementTimeoutMs
    + fatalExitMarginMs;
  if (
    !Number.isSafeInteger(lockedProviderWindowMs)
    || lockedProviderWindowMs
      >= postProviderInitiationIdleInTransactionSessionTimeoutMs
  ) {
    throw new Error(
      "Mail locked provider window must finish before the idle-in-transaction session timeout.",
    );
  }
  if (
    postProviderInitiationIdleInTransactionSessionTimeoutMs
    >= postProviderInitiationTransactionTimeoutMs
  ) {
    throw new Error(
      "Mail idle-in-transaction session timeout must finish inside the TX2 transaction timeout.",
    );
  }

  const tx2PathMs = preProviderTx2PhaseBudgetMs
    + lockedProviderWindowMs
    + postProviderTx2PhaseBudgetMs;
  const watchedPathMs = poolAcquireTimeoutMs + tx2PathMs;
  const watchdogControlPathMs = watchdogArmAckTimeoutMs
    + watchedPathMs
    + watchdogDisarmDeliveryTimeoutMs;
  if (
    !Number.isSafeInteger(tx2PathMs)
    || !Number.isSafeInteger(watchedPathMs)
    || !Number.isSafeInteger(watchdogControlPathMs)
    || watchdogControlPathMs >= hardWatchdogMs
  ) {
    throw new Error(
      "Mail watchdog control path must finish before the hard watchdog.",
    );
  }
  if (hardWatchdogMs >= postProviderInitiationTransactionTimeoutMs) {
    throw new Error(
      "Mail hard watchdog must fire before the post-provider transaction timeout.",
    );
  }

  const leasedDispatchPathMs = oauthDeadlineMs
    + watchdogArmAckTimeoutMs
    + poolAcquireTimeoutMs
    + postProviderInitiationTransactionTimeoutMs
    + persistenceMarginMs;
  if (
    !Number.isSafeInteger(leasedDispatchPathMs)
    || leasedDispatchPathMs >= postCommitProviderLeaseMs
  ) {
    throw new Error(
      "Mail dispatch path must finish before the provider lease.",
    );
  }
  if (
    postCommitProviderLeaseMs
    >= MAIL_DISPATCH_RUNTIME_LIMITS.exclusiveMaximumPostCommitProviderLeaseMs
  ) {
    throw new Error("Mail provider lease must be less than 300000ms.");
  }
  if (
    providerLeaseStampMs
    >= MAIL_DISPATCH_RUNTIME_LIMITS.exclusiveMaximumProviderLeaseStampMs
  ) {
    throw new Error("Mail provider lease stamp must be less than 300000ms.");
  }
  if (
    drainTimeoutMs
    >= MAIL_DISPATCH_RUNTIME_LIMITS.exclusiveMaximumDrainMs
  ) {
    throw new Error("Mail drain timeout must be less than 105000ms.");
  }
  if (stopTimeoutMs > MAIL_DISPATCH_RUNTIME_LIMITS.maximumStopMs) {
    throw new Error("Mail stop timeout must not exceed 120000ms.");
  }
  if (postCommitProviderLeaseMs >= drainTimeoutMs) {
    throw new Error(
      "Mail provider lease must finish before the drain timeout.",
    );
  }

  const cleanupPathMs = drainTimeoutMs
    + poolCloseTimeoutMs
    + shutdownMarginMs;
  if (
    !Number.isSafeInteger(cleanupPathMs)
    || cleanupPathMs >= stopTimeoutMs
  ) {
    throw new Error(
      "Mail drain, pool close, and shutdown margin must finish before stop timeout.",
    );
  }
  if (providerLeaseStampMs >= stopTimeoutMs) {
    throw new Error(
      "Mail provider lease stamp must finish before stop timeout.",
    );
  }
  if (stopTimeoutMs >= platformStopMs) {
    throw new Error(
      "Mail process stop must finish before the platform stop.",
    );
  }

  const phases = Object.freeze({
    effectiveProviderLeaseStartsAfterTx1Commit: true as const,
    poolAcquireWithinTransactionBudget: false as const,
    poolAcquireWithinHardWatchdogBudget: true as const,
    shouldStopGateBeforeOauth: true as const,
    oauthDeadlineIsAggregateRequestAndAbortSettlement: true as const,
    oauthWithinTx2: false as const,
    shouldStopGateBeforeTx2: true as const,
    guardedSendWithinTx2: true as const,
    hardWatchdogIsMainEventLoopIndependent: true as const,
    hardWatchdogArmedAndReadyBeforeTx2: true as const,
    perDispatchWatchdogArmAckRequiredBeforePoolAcquire: true as const,
    hardWatchdogTimerStartsBeforeArmedAck: true as const,
    watchdogArmAckTimeoutIsBounded: true as const,
    preProviderInitiationDatabaseTimeoutsDisabled: true as const,
    preProviderTx2PhaseBudgetIsAggregateDeadline: true as const,
    tx2LocksAndFinalLiveFenceBeforeProviderInitiation: true as const,
    physicalProviderFetchInitiatedSynchronously: true as const,
    postProviderInitiationDatabaseTimeoutsArmedBeforeAwait: true as const,
    postProviderTx2PhaseBudgetIsAggregateDeadline: true as const,
    postProviderInitiationTimeoutArmFailureIsFatalUnknown: true as const,
    postProviderInitiationDatabaseTimeoutsAreStarvationFallback: true as const,
    hardWatchdogKillsProcessOnExpiry: true as const,
    hardWatchdogClosesDatabaseAndProviderOnExpiry: true as const,
    postReleaseWatchdogDisarmDeliveryIsBounded: true as const,
    hardWatchdogDisarmSentOnlyAfterSafeTx2CompletionAndRelease: true as const,
    hardWatchdogTimerClearedAfterBoundedDisarmDelivery: true as const,
    synchronousFatalExitBeforeNormalTx2Unlock: true as const,
    tx1ProviderBindingPreventsReclaimAndRetry: true as const,
    revocationOrderedAfterProviderStart: true as const,
    tx2FallbackRequiresDatabaseOnlyReconciliation: true as const,
  });
  const liveProviderTx2PhaseOrder = Object.freeze([
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
  ] as const);
  const dispatch = Object.freeze({
    concurrency,
    maximumParallelSends: concurrency,
  });
  const localReserves = Object.freeze({
    schedulerConnections: schedulerReserveConnections,
    maintenanceConnections: maintenanceReserveConnections,
    totalConnections: reservedConnections,
  });
  const serverCapacity = Object.freeze({
    maximumConnections: serverMaximumConnections,
    adminReservedConnections: serverAdminReserveConnections,
    otherProcessPoolMaximumConnections,
    sumProcessPoolMaximumConnections,
    gmailReconciliationReserveConnections:
      gmailReconciliationServerReserveConnections,
    remainingConnections,
  });
  const pool = Object.freeze({
    maximumConnections: poolMaximumConnections,
    dispatchConnections: concurrency,
    localReserves,
    serverCapacity,
  });
  const preProviderInitiation = Object.freeze({
    idleInTransactionSessionTimeoutMs: 0 as const,
    transactionTimeoutMs: 0 as const,
  });
  const postProviderInitiation = Object.freeze({
    idleInTransactionSessionTimeoutMs:
      postProviderInitiationIdleInTransactionSessionTimeoutMs,
    transactionTimeoutMs: postProviderInitiationTransactionTimeoutMs,
    transactionTimeoutMinimumPostgresMajor: 17 as const,
  });
  const liveProviderTx2DatabaseTimeouts = Object.freeze({
    preProviderInitiation,
    postProviderInitiation,
  });
  const providerLease = Object.freeze({
    postCommitProviderLeaseMs,
    tx1CommitAckAllowanceMs: tx1TimeoutMs,
    providerLeaseStampMs,
  });
  const timeouts = Object.freeze({
    poolAcquireMs: poolAcquireTimeoutMs,
    poolIdleMs: poolIdleTimeoutMs,
    lockMs: lockTimeoutMs,
    statementMs: statementTimeoutMs,
    queryMs: queryTimeoutMs,
    tx1Ms: tx1TimeoutMs,
    oauthDeadlineMs,
    guardedSendDeadlineMs,
    providerAbortSettlementMs: providerAbortSettlementTimeoutMs,
    fatalExitMarginMs,
    persistenceMarginMs,
    preProviderTx2PhaseBudgetMs,
    postProviderTx2PhaseBudgetMs,
    watchdogArmAckMs: watchdogArmAckTimeoutMs,
    watchdogDisarmDeliveryMs: watchdogDisarmDeliveryTimeoutMs,
    hardWatchdogMs,
    drainMs: drainTimeoutMs,
    poolCloseMs: poolCloseTimeoutMs,
    shutdownMarginMs,
    stopMs: stopTimeoutMs,
    platformStopMs,
  });

  return Object.freeze({
    phases,
    liveProviderTx2PhaseOrder,
    dispatch,
    pool,
    liveProviderTx2DatabaseTimeouts,
    providerLease,
    timeouts,
  });
}
