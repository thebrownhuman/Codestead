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
  maximumTransactionMs: 60_000,
  maximumIdleInTransactionSessionMs: 60_000,
  maximumProviderRequestMs: 20_000,
  maximumProviderAbortSettlementMs: 5_000,
  maximumFatalExitMarginMs: 5_000,
  maximumPersistenceMarginMs: 10_000,
  exclusiveMaximumProviderLeaseMs: 300_000,
  exclusiveMaximumDrainMs: 105_000,
  maximumPoolCloseMs: 15_000,
  maximumShutdownMarginMs: 15_000,
  maximumStopMs: 120_000,
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
  tx2TimeoutMs: 50_000,
  persistenceMarginMs: 5_000,
  providerLeaseMs: 90_000,
  drainTimeoutMs: 100_000,
  poolCloseTimeoutMs: 5_000,
  shutdownMarginMs: 5_000,
  stopTimeoutMs: 120_000,
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
  tx2TimeoutMs?: number;
  persistenceMarginMs?: number;
  providerLeaseMs?: number;
  drainTimeoutMs?: number;
  poolCloseTimeoutMs?: number;
  shutdownMarginMs?: number;
  stopTimeoutMs?: number;
}>;

export type MailDispatchRuntimePlan = Readonly<{
  phases: Readonly<{
    providerLeaseStartsAfterTx1Commit: true;
    poolAcquireWithinTransactionBudget: false;
    oauthWithinTx2: false;
    guardedSendWithinTx2: true;
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
    idleInTransactionSessionMs: number;
    tx2Ms: number;
    persistenceMarginMs: number;
    providerLeaseMs: number;
    drainMs: number;
    poolCloseMs: number;
    shutdownMarginMs: number;
    stopMs: number;
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
  "tx2TimeoutMs",
  "persistenceMarginMs",
  "providerLeaseMs",
  "drainTimeoutMs",
  "poolCloseTimeoutMs",
  "shutdownMarginMs",
  "stopTimeoutMs",
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

  const tx2TimeoutMs = configured(overrides, "tx2TimeoutMs");
  const idleInTransactionSessionTimeoutMs = configured(
    overrides,
    "idleInTransactionSessionTimeoutMs",
  );
  const persistenceMarginMs = configured(overrides, "persistenceMarginMs");
  const providerLeaseMs = configured(overrides, "providerLeaseMs");
  const drainTimeoutMs = configured(overrides, "drainTimeoutMs");
  const poolCloseTimeoutMs = configured(overrides, "poolCloseTimeoutMs");
  const shutdownMarginMs = configured(overrides, "shutdownMarginMs");
  const stopTimeoutMs = configured(overrides, "stopTimeoutMs");

  for (const [label, value] of [
    ["Mail pool acquire timeout", poolAcquireTimeoutMs],
    ["Mail pool idle timeout", poolIdleTimeoutMs],
    ["Mail lock timeout", lockTimeoutMs],
    ["Mail statement timeout", statementTimeoutMs],
    ["Mail query timeout", queryTimeoutMs],
    ["Mail TX1 timeout", tx1TimeoutMs],
    ["Mail TX2 timeout", tx2TimeoutMs],
    [
      "Mail idle-in-transaction session timeout",
      idleInTransactionSessionTimeoutMs,
    ],
    ["Mail persistence margin", persistenceMarginMs],
    ["Mail provider lease", providerLeaseMs],
    ["Mail drain timeout", drainTimeoutMs],
    ["Mail pool close timeout", poolCloseTimeoutMs],
    ["Mail shutdown margin", shutdownMarginMs],
    ["Mail stop timeout", stopTimeoutMs],
  ] as const) {
    assertPositiveInteger(value, label);
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
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumTransactionMs,
    "Mail TX1 timeout",
  );
  assertMaximum(
    tx2TimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumTransactionMs,
    "Mail TX2 timeout",
  );
  assertMaximum(
    idleInTransactionSessionTimeoutMs,
    MAIL_DISPATCH_RUNTIME_LIMITS.maximumIdleInTransactionSessionMs,
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
  if (queryTimeoutMs >= tx1TimeoutMs || queryTimeoutMs >= tx2TimeoutMs) {
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
      "Mail locked provider window must finish before idle-in-transaction timeout.",
    );
  }
  if (
    idleInTransactionSessionTimeoutMs >= tx2TimeoutMs
  ) {
    throw new Error(
      "Mail idle-in-transaction timeout must finish inside TX2.",
    );
  }

  const tx2PathMs = queryTimeoutMs
    + lockedProviderWindowMs
    + queryTimeoutMs;
  if (
    !Number.isSafeInteger(tx2PathMs)
    || tx2PathMs >= tx2TimeoutMs
  ) {
    throw new Error("Mail TX2 path must finish before the TX2 timeout.");
  }

  const leasedDispatchPathMs = oauthDeadlineMs
    + tx2TimeoutMs
    + persistenceMarginMs;
  if (
    !Number.isSafeInteger(leasedDispatchPathMs)
    || leasedDispatchPathMs >= providerLeaseMs
  ) {
    throw new Error(
      "Mail dispatch path must finish before the provider lease.",
    );
  }
  if (
    providerLeaseMs
    >= MAIL_DISPATCH_RUNTIME_LIMITS.exclusiveMaximumProviderLeaseMs
  ) {
    throw new Error("Mail provider lease must be less than 300000ms.");
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
  if (providerLeaseMs >= drainTimeoutMs) {
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

  const phases = Object.freeze({
    providerLeaseStartsAfterTx1Commit: true as const,
    poolAcquireWithinTransactionBudget: false as const,
    oauthWithinTx2: false as const,
    guardedSendWithinTx2: true as const,
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
    idleInTransactionSessionMs: idleInTransactionSessionTimeoutMs,
    tx2Ms: tx2TimeoutMs,
    persistenceMarginMs,
    providerLeaseMs,
    drainMs: drainTimeoutMs,
    poolCloseMs: poolCloseTimeoutMs,
    shutdownMarginMs,
    stopMs: stopTimeoutMs,
  });

  return Object.freeze({ phases, dispatch, pool, timeouts });
}
