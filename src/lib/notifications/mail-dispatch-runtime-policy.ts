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
  maximumTx2TransactionTimeoutMs: 60_000,
  maximumIdleInTransactionSessionTimeoutMs: 60_000,
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
  idleInTransactionSessionTimeoutMs: 35_000,
  tx2TransactionTimeoutMs: 50_000,
  persistenceMarginMs: 5_000,
  postCommitProviderLeaseMs: 90_000,
  providerLeaseStampMs: 105_000,
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
  idleInTransactionSessionTimeoutMs?: number;
  tx2TransactionTimeoutMs?: number;
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
    shouldStopGateBeforeOauth: true;
    oauthWithinTx2: false;
    shouldStopGateBeforeTx2: true;
    guardedSendWithinTx2: true;
    liveProviderTx2DatabaseTimeoutsAreStarvationFallback: true;
    synchronousFatalExitBeforeNormalTx2Unlock: true;
    tx1ProviderBindingPreventsReclaimAndRetry: true;
    revocationOrderedAfterProviderStart: true;
    tx2FallbackRequiresDatabaseOnlyReconciliation: true;
  }>;
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
   * Finite SET LOCAL starvation fallbacks while provider I/O retains TX2
   * locks. Normal bounded callback teardown completes first. PostgreSQL 16
   * uses the idle timeout plus finite query guards; transaction_timeout is
   * additionally applied on PostgreSQL 17 and newer.
   * If a fallback fires, the durable TX1 started/binding state prevents
   * reclaim or retry; late outcome handling is database-only reconciliation,
   * with revocation ordered after provider start rather than blocked.
   */
  liveProviderTx2DatabaseTimeouts: Readonly<{
    idleInTransactionSessionTimeoutMs: number;
    transactionTimeoutMs: number;
    transactionTimeoutMinimumPostgresMajor: 17;
  }>;
  /**
   * The physical stamp is persisted inside TX1. Including the full TX1
   * commit-ack allowance guarantees the effective lease after COMMIT without
   * a second write: stamp = TX1 allowance + post-COMMIT lease.
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
    oauthDeadlineMs: number;
    guardedSendDeadlineMs: number;
    providerAbortSettlementMs: number;
    fatalExitMarginMs: number;
    persistenceMarginMs: number;
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
  "idleInTransactionSessionTimeoutMs",
  "tx2TransactionTimeoutMs",
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

  const tx2TransactionTimeoutMs = configured(
    overrides,
    "tx2TransactionTimeoutMs",
  );
  const idleInTransactionSessionTimeoutMs = configured(
    overrides,
    "idleInTransactionSessionTimeoutMs",
  );
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

  for (const [label, value] of [
    ["Mail pool acquire timeout", poolAcquireTimeoutMs],
    ["Mail pool idle timeout", poolIdleTimeoutMs],
    ["Mail lock timeout", lockTimeoutMs],
    ["Mail statement timeout", statementTimeoutMs],
    ["Mail query timeout", queryTimeoutMs],
    ["Mail TX1 timeout", tx1TimeoutMs],
    ["Mail TX2 transaction timeout", tx2TransactionTimeoutMs],
    [
      "Mail idle-in-transaction session timeout",
      idleInTransactionSessionTimeoutMs,
    ],
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
    tx2TransactionTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumTx2TransactionTimeoutMs,
    "Mail TX2 transaction timeout",
  );
  assertMaximum(
    idleInTransactionSessionTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumIdleInTransactionSessionTimeoutMs,
    "Mail idle-in-transaction session timeout",
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
    || queryTimeoutMs >= tx2TransactionTimeoutMs
  ) {
    throw new Error("Mail query timeout must finish inside TX1 and TX2.");
  }

  const lockedProviderWindowMs = guardedSendDeadlineMs
    + providerAbortSettlementTimeoutMs
    + fatalExitMarginMs;
  if (
    !Number.isSafeInteger(lockedProviderWindowMs)
    || lockedProviderWindowMs >= idleInTransactionSessionTimeoutMs
  ) {
    throw new Error(
      "Mail locked provider window must finish before the idle-in-transaction session timeout.",
    );
  }
  if (
    idleInTransactionSessionTimeoutMs >= tx2TransactionTimeoutMs
  ) {
    throw new Error(
      "Mail idle-in-transaction session timeout must finish inside the TX2 transaction timeout.",
    );
  }

  const tx2PathMs = queryTimeoutMs
    + lockedProviderWindowMs
    + queryTimeoutMs;
  if (
    !Number.isSafeInteger(tx2PathMs)
    || tx2PathMs >= tx2TransactionTimeoutMs
  ) {
    throw new Error(
      "Mail TX2 path must finish before the TX2 transaction timeout.",
    );
  }

  const leasedDispatchPathMs = oauthDeadlineMs
    + tx2TransactionTimeoutMs
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
  if (stopTimeoutMs >= platformStopMs) {
    throw new Error(
      "Mail process stop must finish before the platform stop.",
    );
  }

  const phases = Object.freeze({
    effectiveProviderLeaseStartsAfterTx1Commit: true as const,
    poolAcquireWithinTransactionBudget: false as const,
    shouldStopGateBeforeOauth: true as const,
    oauthWithinTx2: false as const,
    shouldStopGateBeforeTx2: true as const,
    guardedSendWithinTx2: true as const,
    liveProviderTx2DatabaseTimeoutsAreStarvationFallback: true as const,
    synchronousFatalExitBeforeNormalTx2Unlock: true as const,
    tx1ProviderBindingPreventsReclaimAndRetry: true as const,
    revocationOrderedAfterProviderStart: true as const,
    tx2FallbackRequiresDatabaseOnlyReconciliation: true as const,
  });
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
  const liveProviderTx2DatabaseTimeouts = Object.freeze({
    idleInTransactionSessionTimeoutMs,
    transactionTimeoutMs: tx2TransactionTimeoutMs,
    transactionTimeoutMinimumPostgresMajor: 17 as const,
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
    drainMs: drainTimeoutMs,
    poolCloseMs: poolCloseTimeoutMs,
    shutdownMarginMs,
    stopMs: stopTimeoutMs,
    platformStopMs,
  });

  return Object.freeze({
    phases,
    dispatch,
    pool,
    liveProviderTx2DatabaseTimeouts,
    providerLease,
    timeouts,
  });
}
