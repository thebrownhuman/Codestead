export const MAIL_DISPATCH_RUNTIME_LIMITS = Object.freeze({
  minimumConcurrency: 1,
  maximumConcurrency: 10,
  schedulerReserveConnections: 1,
  maintenanceReserveConnections: 1,
  gmailReconciliationServerReserveConnections: 1,
  maximumProviderRequestMs: 20_000,
  maximumProviderAbortSettlementMs: 5_000,
  maximumProviderTerminationMs: 5_000,
  exclusiveMaximumProviderLeaseMs: 300_000,
  maximumDrainMs: 105_000,
  maximumStopMs: 120_000,
});

export const MAIL_DISPATCH_RUNTIME_DEFAULTS = Object.freeze({
  concurrency: 1,
  schedulerReserveConnections: 1,
  maintenanceReserveConnections: 1,
  gmailReconciliationServerReserveConnections: 1,
  oauthDeadlineMs: 20_000,
  guardedSendDeadlineMs: 20_000,
  providerAbortSettlementTimeoutMs: 5_000,
  providerTerminationTimeoutMs: 5_000,
  tx1TimeoutMs: 15_000,
  tx2TimeoutMs: 50_000,
  statementTimeoutMs: 5_000,
  idleInTransactionSessionTimeoutMs: 35_000,
  providerLeaseMs: 100_000,
  drainTimeoutMs: 105_000,
  poolCloseTimeoutMs: 5_000,
  stopTimeoutMs: 120_000,
});

export type MailDispatchRuntimeOverrides = Readonly<{
  concurrency?: number;
  poolMaximumConnections?: number;
  schedulerReserveConnections?: number;
  maintenanceReserveConnections?: number;
  gmailReconciliationServerReserveConnections?: number;
  oauthDeadlineMs?: number;
  guardedSendDeadlineMs?: number;
  providerAbortSettlementTimeoutMs?: number;
  providerTerminationTimeoutMs?: number;
  tx1TimeoutMs?: number;
  tx2TimeoutMs?: number;
  statementTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
  providerLeaseMs?: number;
  drainTimeoutMs?: number;
  poolCloseTimeoutMs?: number;
  stopTimeoutMs?: number;
}>;

export type MailDispatchRuntimePlan = Readonly<{
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
    /** Minimum capacity retained outside this pool at the database server. */
    serverGlobalReserve: Readonly<{
      gmailReconciliationConnections: number;
    }>;
  }>;
  timeouts: Readonly<{
    oauthDeadlineMs: number;
    guardedSendDeadlineMs: number;
    providerAbortSettlementMs: number;
    providerTerminationMs: number;
    tx1Ms: number;
    tx2Ms: number;
    statementMs: number;
    idleInTransactionSessionMs: number;
    providerLeaseMs: number;
    drainMs: number;
    poolCloseMs: number;
    stopMs: number;
  }>;
}>;

const OVERRIDE_KEYS = Object.freeze([
  "concurrency",
  "poolMaximumConnections",
  "schedulerReserveConnections",
  "maintenanceReserveConnections",
  "gmailReconciliationServerReserveConnections",
  "oauthDeadlineMs",
  "guardedSendDeadlineMs",
  "providerAbortSettlementTimeoutMs",
  "providerTerminationTimeoutMs",
  "tx1TimeoutMs",
  "tx2TimeoutMs",
  "statementTimeoutMs",
  "idleInTransactionSessionTimeoutMs",
  "providerLeaseMs",
  "drainTimeoutMs",
  "poolCloseTimeoutMs",
  "stopTimeoutMs",
] as const);

type OverrideKey = (typeof OVERRIDE_KEYS)[number];

function assertKnownOverrides(overrides: MailDispatchRuntimeOverrides): void {
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
  key: Exclude<OverrideKey, "poolMaximumConnections">,
): number {
  return overrides[key] ?? MAIL_DISPATCH_RUNTIME_DEFAULTS[key];
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
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
  const poolMaximumConnections = overrides.poolMaximumConnections
    ?? expectedPoolMaximum;
  if (
    !Number.isSafeInteger(poolMaximumConnections)
    || poolMaximumConnections !== expectedPoolMaximum
  ) {
    throw new Error(
      "Mail dispatch pool maximum must equal concurrency plus two reserves.",
    );
  }

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

  const providerTerminationTimeoutMs = configured(
    overrides,
    "providerTerminationTimeoutMs",
  );
  assertPositiveInteger(
    providerTerminationTimeoutMs,
    "Mail provider termination timeout",
  );
  if (
    providerTerminationTimeoutMs
    > MAIL_DISPATCH_RUNTIME_LIMITS.maximumProviderTerminationMs
  ) {
    throw new Error(
      "Mail provider termination timeout must not exceed 5000ms.",
    );
  }

  const tx1TimeoutMs = configured(overrides, "tx1TimeoutMs");
  const tx2TimeoutMs = configured(overrides, "tx2TimeoutMs");
  const statementTimeoutMs = configured(overrides, "statementTimeoutMs");
  const idleInTransactionSessionTimeoutMs = configured(
    overrides,
    "idleInTransactionSessionTimeoutMs",
  );
  const providerLeaseMs = configured(overrides, "providerLeaseMs");
  const drainTimeoutMs = configured(overrides, "drainTimeoutMs");
  const poolCloseTimeoutMs = configured(overrides, "poolCloseTimeoutMs");
  const stopTimeoutMs = configured(overrides, "stopTimeoutMs");

  for (const [label, value] of [
    ["Mail TX1 timeout", tx1TimeoutMs],
    ["Mail TX2 timeout", tx2TimeoutMs],
    ["Mail statement timeout", statementTimeoutMs],
    [
      "Mail idle-in-transaction session timeout",
      idleInTransactionSessionTimeoutMs,
    ],
    ["Mail provider lease", providerLeaseMs],
    ["Mail drain timeout", drainTimeoutMs],
    ["Mail pool close timeout", poolCloseTimeoutMs],
    ["Mail stop timeout", stopTimeoutMs],
  ] as const) {
    assertPositiveInteger(value, label);
  }

  if (
    providerLeaseMs
    >= MAIL_DISPATCH_RUNTIME_LIMITS.exclusiveMaximumProviderLeaseMs
  ) {
    throw new Error("Mail provider lease must be less than 300000ms.");
  }
  if (
    statementTimeoutMs >= tx1TimeoutMs
    || statementTimeoutMs >= tx2TimeoutMs
  ) {
    throw new Error("Mail statement timeout must finish inside TX1 and TX2.");
  }
  if (
    idleInTransactionSessionTimeoutMs >= tx2TimeoutMs
  ) {
    throw new Error(
      "Mail idle-in-transaction timeout must finish inside TX2.",
    );
  }
  const guardedTeardownMs = guardedSendDeadlineMs
    + providerAbortSettlementTimeoutMs
    + providerTerminationTimeoutMs;
  if (
    !Number.isSafeInteger(guardedTeardownMs)
    || guardedTeardownMs >= idleInTransactionSessionTimeoutMs
  ) {
    throw new Error(
      "Mail guarded send, abort settlement, and termination must finish before the idle-in-transaction timeout.",
    );
  }

  const completeDispatchPathMs = tx1TimeoutMs
    + oauthDeadlineMs
    + tx2TimeoutMs;
  if (
    !Number.isSafeInteger(completeDispatchPathMs)
    || completeDispatchPathMs >= providerLeaseMs
  ) {
    throw new Error(
      "Mail dispatch path must finish before the provider lease.",
    );
  }
  if (drainTimeoutMs > MAIL_DISPATCH_RUNTIME_LIMITS.maximumDrainMs) {
    throw new Error("Mail drain timeout must not exceed 105000ms.");
  }
  if (stopTimeoutMs > MAIL_DISPATCH_RUNTIME_LIMITS.maximumStopMs) {
    throw new Error("Mail stop timeout must not exceed 120000ms.");
  }
  if (providerLeaseMs > drainTimeoutMs) {
    throw new Error("Mail provider lease must fit inside the drain timeout.");
  }
  const cleanupPathMs = drainTimeoutMs + poolCloseTimeoutMs;
  if (
    !Number.isSafeInteger(cleanupPathMs)
    || cleanupPathMs >= stopTimeoutMs
  ) {
    throw new Error(
      "Mail drain and pool close must finish before stop timeout.",
    );
  }

  const dispatch = Object.freeze({
    concurrency,
    maximumParallelSends: concurrency,
  });
  const localReserves = Object.freeze({
    schedulerConnections: schedulerReserveConnections,
    maintenanceConnections: maintenanceReserveConnections,
    totalConnections: reservedConnections,
  });
  const serverGlobalReserve = Object.freeze({
    gmailReconciliationConnections:
      gmailReconciliationServerReserveConnections,
  });
  const pool = Object.freeze({
    maximumConnections: poolMaximumConnections,
    dispatchConnections: concurrency,
    localReserves,
    serverGlobalReserve,
  });
  const timeouts = Object.freeze({
    oauthDeadlineMs,
    guardedSendDeadlineMs,
    providerAbortSettlementMs: providerAbortSettlementTimeoutMs,
    providerTerminationMs: providerTerminationTimeoutMs,
    tx1Ms: tx1TimeoutMs,
    tx2Ms: tx2TimeoutMs,
    statementMs: statementTimeoutMs,
    idleInTransactionSessionMs: idleInTransactionSessionTimeoutMs,
    providerLeaseMs,
    drainMs: drainTimeoutMs,
    poolCloseMs: poolCloseTimeoutMs,
    stopMs: stopTimeoutMs,
  });

  return Object.freeze({ dispatch, pool, timeouts });
}
