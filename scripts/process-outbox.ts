import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import {
  materializeDeliveryWithAuthorityEvidence,
} from "../src/lib/notifications/delivery-variables";
import {
  createMaterializedDispatch,
  type PreparedDispatchRuntimePlan,
} from "../src/lib/notifications/guarded-prepared-dispatch";
import { scheduleInactivityReminders } from
  "../src/lib/notifications/inactivity";
import {
  startMailDispatchHardWatchdog,
  type MailDispatchHardWatchdog,
} from "../src/lib/notifications/mail-dispatch-hard-watchdog";
import {
  createMailDispatchBootstrapResources,
  type MailDispatchBootstrapResources,
} from "../src/lib/notifications/mail-dispatch-pool";
import { planMailDispatchRuntime } from
  "../src/lib/notifications/mail-dispatch-runtime-policy";
import {
  inspectMailDispatchRuntime,
  type MailDispatchRuntimeStartupInspection,
} from "../src/lib/notifications/mail-dispatch-runtime-startup";
import {
  captureMailTransportConfiguration,
  type MailAdapter,
  type MailTransportConfiguration,
} from "../src/lib/notifications/mailer-transport-internal";
import { outboxMessageId } from
  "../src/lib/notifications/provider-correlation";
import {
  authorizeCommittedPreparedDispatch,
  captureMailDispatchApplicationOrigin,
  discardCommittedPreparedDispatchReceipt,
  discardGuardedPreparedDispatch,
  mailDispatchApplicationUrl,
  mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore,
  type EmailOutboxPayload,
} from "../src/lib/notifications/postgres-outbox-store";
import {
  scheduleSmartRemindersWithDatabase,
} from "../src/lib/notifications/smart-reminders";
import {
  resolveEmailTemplateAuthorityPolicy,
} from "../src/lib/notifications/template-authority-policy";
import {
  processOutboxBatch,
  type ItemOutcome,
  type ProcessOutboxBatchResult,
} from "../src/lib/notifications/outbox-worker";
import {
  allowlistedOperationalErrorCode,
} from "../src/lib/security/operational-code";
import { createWorkerHealthReporter } from "./lib/worker-health";

const BATCH_SIZE = 10;
const MATERIALIZE_LEASE_MS = 60_000;
const MAX_MATERIALIZE_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;
const TERMINAL_PERSISTENCE_ATTEMPTS = 3;
const FENCED_WORKER_MODE = "fenced-postgres-v1";
const DEFAULT_MAIL_FROM = "Codestead <noreply@example.com>";
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT"] as const;
const APPLICATION_DRAIN_TIMEOUT_CODE = "APPLICATION_DRAIN_TIMEOUT";
const APPLICATION_STOP_TIMEOUT_CODE = "APPLICATION_STOP_TIMEOUT";
const FALLBACK_SHUTDOWN_TIMEOUTS = planMailDispatchRuntime().timeouts;
const MAIL_WORKER_ERROR_CODES = new Set([
  "MAIL_WORKER_FAILED",
  "OUTBOX_WORKER_MODE_INVALID",
  "POOL_SHUTDOWN_FAILED",
  "POOL_SHUTDOWN_TIMEOUT",
  "WATCHDOG_SHUTDOWN_FAILED",
] as const);

const workerHost = hostname()
  .replace(/[^A-Za-z0-9._:-]/g, "-")
  .slice(0, 60);
const claimOwner =
  `mail-worker:${workerHost}:${process.pid}:${randomUUID()}`.slice(0, 128);

let healthReporter: ReturnType<typeof createWorkerHealthReporter> | undefined;
let resources: MailDispatchBootstrapResources | undefined;
let startupInspection: MailDispatchRuntimeStartupInspection | undefined;
let watchdog: MailDispatchHardWatchdog | undefined;
let stopping = false;
let finishPollWait: (() => void) | undefined;
let drainDeadline: ReturnType<typeof setTimeout> | undefined;
let applicationStopDeadline: ReturnType<typeof setTimeout> | undefined;
let cleanupPromise: Promise<void> | undefined;
let applicationDrainTimedOut = false;

const terminationRuntime = Object.freeze({
  schedule(callback: () => void, timeoutMs: number) {
    return setTimeout(callback, timeoutMs);
  },
  cancel(timer: ReturnType<typeof setTimeout>) {
    clearTimeout(timer);
  },
  failStop() {
    process.exit(1);
  },
});

class OutboxWorkerModeError extends Error {
  constructor() {
    super(`OUTBOX_WORKER_MODE must be exactly ${FENCED_WORKER_MODE}.`);
    this.name = "OUTBOX_WORKER_MODE_INVALID";
  }
}

class PoolShutdownTimeoutError extends Error {
  constructor() {
    super("Mail worker pool shutdown timed out.");
    this.name = "PoolShutdownTimeoutError";
  }
}

function mailWorkerErrorCode(error: unknown) {
  return allowlistedOperationalErrorCode(
    error,
    MAIL_WORKER_ERROR_CODES,
  ) ?? "MAIL_WORKER_FAILED";
}

function shutdownTimeouts() {
  return startupInspection?.plan.timeouts ?? FALLBACK_SHUTDOWN_TIMEOUTS;
}

function beginCleanup() {
  cleanupPromise ??= cleanup();
  return cleanupPromise;
}

function finishApplicationLifecycle() {
  if (drainDeadline !== undefined) {
    terminationRuntime.cancel(drainDeadline);
    drainDeadline = undefined;
  }
  if (applicationStopDeadline !== undefined) {
    terminationRuntime.cancel(applicationStopDeadline);
    applicationStopDeadline = undefined;
  }
  removeTerminationHandlers();
}

function markApplicationDrainTimeout() {
  if (applicationDrainTimedOut) return;
  applicationDrainTimedOut = true;
  process.exitCode = 1;
  console.error(JSON.stringify({
    event: "email.worker_drain_timeout",
    code: APPLICATION_DRAIN_TIMEOUT_CODE,
  }));
}
function failStopApplication() {
  applicationStopDeadline = undefined;
  process.exitCode = 1;
  console.error(JSON.stringify({
    event: "email.worker_stop_timeout",
    code: APPLICATION_STOP_TIMEOUT_CODE,
  }));
  removeTerminationHandlers();
  terminationRuntime.failStop();
}

function startApplicationStopDeadlines() {
  const timeouts = shutdownTimeouts();
  drainDeadline = terminationRuntime.schedule(() => {
    drainDeadline = undefined;
    markApplicationDrainTimeout();
    void beginCleanup();
  }, timeouts.drainMs);
  applicationStopDeadline = terminationRuntime.schedule(
    failStopApplication,
    timeouts.stopMs,
  );
}

function requestStop() {
  if (stopping) return;
  stopping = true;
  finishPollWait?.();
  startApplicationStopDeadlines();
}

function installTerminationHandlers() {
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, requestStop);
  }
}

function removeTerminationHandlers() {
  for (const signal of TERMINATION_SIGNALS) {
    process.off(signal, requestStop);
  }
}

function waitForNextPoll(milliseconds: number) {
  if (stopping) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (finishPollWait === finish) finishPollWait = undefined;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    finishPollWait = finish;
    if (stopping) finish();
  });
}

function configuredSeconds(input: Readonly<{
  name: "OUTBOX_POLL_SECONDS" | "INACTIVITY_SCHEDULE_SECONDS";
  fallback: string;
  minimum: number;
  maximum: number;
}>) {
  const raw = process.env[input.name] ?? input.fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      `${input.name} must be an integer from ${input.minimum} to ${input.maximum}.`,
    );
  }
  const seconds = Number(raw);
  if (
    !Number.isSafeInteger(seconds)
    || seconds < input.minimum
    || seconds > input.maximum
  ) {
    throw new Error(
      `${input.name} must be an integer from ${input.minimum} to ${input.maximum}.`,
    );
  }
  return seconds;
}

function configuredAdapter(): MailAdapter {
  const adapter = process.env.MAIL_ADAPTER ?? "console";
  if (adapter !== "console" && adapter !== "gmail") {
    throw new Error("MAIL_ADAPTER must be either console or gmail.");
  }
  return adapter;
}

function configuredFromAddress() {
  const from = process.env.MAIL_FROM ?? DEFAULT_MAIL_FROM;
  if (
    !from.trim()
    || from.length > 512
    || /[\r\n\0]/.test(from)
  ) {
    throw new Error("MAIL_FROM is invalid.");
  }
  return from;
}

async function endPoolWithinDeadline(
  activeResources: MailDispatchBootstrapResources,
  timeoutMs: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve().then(() => activeResources.pool.end());
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new PoolShutdownTimeoutError()),
      timeoutMs,
    );
  });

  try {
    await Promise.race([close, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function cleanup() {
  let cleanupCode:
    | "WATCHDOG_SHUTDOWN_FAILED"
    | "POOL_SHUTDOWN_TIMEOUT"
    | "POOL_SHUTDOWN_FAILED"
    | undefined;

  if (watchdog) {
    try {
      await watchdog.close();
    } catch {
      cleanupCode = "WATCHDOG_SHUTDOWN_FAILED";
    }
  }

  if (resources) {
    try {
      const poolCloseMs = startupInspection?.plan.timeouts.poolCloseMs ?? 5_000;
      await endPoolWithinDeadline(resources, poolCloseMs);
    } catch (error) {
      cleanupCode = error instanceof PoolShutdownTimeoutError
        ? "POOL_SHUTDOWN_TIMEOUT"
        : "POOL_SHUTDOWN_FAILED";
    }
  }

  if (!cleanupCode) return;
  process.exitCode = 1;
  console.error(JSON.stringify({
    event: "email.worker_cleanup_failed",
    code: cleanupCode,
  }));
  if (cleanupCode === "POOL_SHUTDOWN_TIMEOUT") process.exit(1);
}

function retryMaterialization(input: Readonly<{
  attempt: number;
  now: Date;
}>): (
  | { readonly kind: "retry"; readonly code: string; readonly retryAt: Date }
  | { readonly kind: "failed"; readonly code: string }
) {
  if (input.attempt >= MAX_MATERIALIZE_ATTEMPTS) {
    return { kind: "failed", code: "MATERIALIZATION_ATTEMPTS_EXHAUSTED" };
  }
  const delayMs = Math.min(
    MAX_RETRY_DELAY_MS,
    30_000 * 2 ** Math.min(input.attempt, 16),
  );
  return {
    kind: "retry",
    code: "MATERIALIZATION_FAILED",
    retryAt: new Date(input.now.getTime() + delayMs),
  };
}

function processBatch(input: Readonly<{
  store: PostgresOutboxStore;
  adapter: MailAdapter;
  from: string;
  applicationUrl: string;
  transportConfiguration: MailTransportConfiguration;
  preparedRuntimePlan: PreparedDispatchRuntimePlan;
  watchdog: MailDispatchHardWatchdog;
}>) {
  const clock = Object.freeze({ now: () => new Date() });
  return processOutboxBatch<EmailOutboxPayload>({
    store: input.store,
    materialize: async (claim) => {
      const resolvedPolicy = resolveEmailTemplateAuthorityPolicy(
        claim.payload.template,
        claim.payload.templateVersion,
      );
      if (!resolvedPolicy) {
        return { kind: "suppressed", code: "TEMPLATE_POLICY_INVALID" };
      }

      const sourceVariables = Object.freeze({ ...claim.payload.variables });
      const delivery = await materializeDeliveryWithAuthorityEvidence({
        applicationUrl: input.applicationUrl,
        template: resolvedPolicy.template,
        templateVersion: claim.payload.templateVersion,
        variables: { ...sourceVariables },
        now: clock.now(),
      });
      if (!delivery) {
        return {
          kind: "suppressed",
          code: "DELIVERY_PROOF_UNAVAILABLE",
        };
      }

      const materializedInput = {
        source: Object.freeze({
          applicationUrl: input.applicationUrl,
          outboxId: claim.id,
          operationId: claim.operationId,
          claimToken: claim.claimToken,
          claimOwner: claim.claimOwner,
          claimVersion: claim.claimVersion,
          deliveryScopeKey: claim.deliveryScopeKey,
          recipient: claim.payload.to,
          template: resolvedPolicy.template,
          templateVersion: claim.payload.templateVersion,
          variables: sourceVariables,
        }),
        adapter: input.adapter,
        from: input.from,
        messageId: outboxMessageId(claim.operationId),
        runtimePlan: input.preparedRuntimePlan,
        transportConfiguration: input.transportConfiguration,
        ...(delivery.authorityEvidence === null
          ? {}
          : {
              delivery: Object.freeze({
                authorityEvidence: delivery.authorityEvidence,
                variables: delivery.variables,
              }),
            }),
      };
      return {
        kind: "ready" as const,
        materialized: createMaterializedDispatch(materializedInput),
      };
    },
    adapter: input.adapter,
    authorize: (receipt) =>
      authorizeCommittedPreparedDispatch(input.store, receipt),
    discardReceipt: (permit, receipt) =>
      discardCommittedPreparedDispatchReceipt(
        input.store,
        permit,
        receipt,
      ),
    discardGuard: (permit, guarded) =>
      discardGuardedPreparedDispatch(input.store, permit, guarded),
    watchdog: input.watchdog,
    claimOwner,
    newClaimToken: randomUUID,
    shouldStop: () => stopping,
    clock,
    retryPolicy: {
      unexpectedMaterializeError: ({ attempt, now }) =>
        retryMaterialization({ attempt, now }),
    },
    policy: {
      batchSize: BATCH_SIZE,
      materializeLeaseMs: MATERIALIZE_LEASE_MS,
      maxMaterializeAttempts: MAX_MATERIALIZE_ATTEMPTS,
      maxRetryDelayMs: MAX_RETRY_DELAY_MS,
      terminalPersistenceAttempts: TERMINAL_PERSISTENCE_ATTEMPTS,
    },
  });
}

type OutcomeCounts = {
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
  quarantined: number;
  claimLost: number;
  persistenceUnknown: number;
};

function outcomeCounts(outcomes: readonly ItemOutcome[]): OutcomeCounts {
  const counts: OutcomeCounts = {
    sent: 0,
    retried: 0,
    failed: 0,
    suppressed: 0,
    quarantined: 0,
    claimLost: 0,
    persistenceUnknown: 0,
  };
  for (const item of outcomes) {
    switch (item.kind) {
      case "sent":
        counts.sent += 1;
        break;
      case "retry":
        counts.retried += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "suppressed":
        counts.suppressed += 1;
        break;
      case "quarantined":
        counts.quarantined += 1;
        break;
      case "claim-lost":
        counts.claimLost += 1;
        break;
      case "persistence-unknown":
        counts.persistenceUnknown += 1;
        break;
    }
  }
  return counts;
}

function batchLog(result: ProcessOutboxBatchResult) {
  return {
    event: "email.outbox_batch",
    claimed: result.claimed,
    swept: result.swept,
    ...outcomeCounts(result.outcomes),
  };
}

async function main() {
  if (process.env.OUTBOX_WORKER_MODE !== FENCED_WORKER_MODE) {
    throw new OutboxWorkerModeError();
  }

  const pollSeconds = configuredSeconds({
    name: "OUTBOX_POLL_SECONDS",
    fallback: "10",
    minimum: 1,
    maximum: 3_600,
  });
  const inactivityScheduleSeconds = configuredSeconds({
    name: "INACTIVITY_SCHEDULE_SECONDS",
    fallback: "60",
    minimum: 10,
    maximum: 3_600,
  });

  resources = createMailDispatchBootstrapResources();
  const inspection = await inspectMailDispatchRuntime(resources.pool);
  startupInspection = inspection;
  const applicationOrigin = captureMailDispatchApplicationOrigin(inspection);
  const applicationUrl = mailDispatchApplicationUrl(applicationOrigin);
  const adapter = configuredAdapter();
  const from = configuredFromAddress();
  const transportConfiguration = captureMailTransportConfiguration(adapter);
  const store = new PostgresOutboxStore(
    resources.pool,
    inspection,
    applicationOrigin,
  );
  const preparedRuntimePlan = mailDispatchPreparedRuntimePlan(store);
  watchdog = await startMailDispatchHardWatchdog();

  const once = process.argv.includes("--once");
  healthReporter = createWorkerHealthReporter({ worker: "mail-worker" });
  let lastInactivityScheduleAt = 0;
  let lastSmartReminderScheduleAt = 0;
  do {
    if (stopping) break;
    const scheduleAt = Date.now();
    if (
      scheduleAt - lastInactivityScheduleAt
      >= inactivityScheduleSeconds * 1_000
    ) {
      const schedule = await scheduleInactivityReminders(
        new Date(scheduleAt),
        resources.pool,
      );
      lastInactivityScheduleAt = scheduleAt;
      console.info(JSON.stringify({ event: "inactivity.schedule", ...schedule }));
    }
    if (stopping) break;
    if (
      scheduleAt - lastSmartReminderScheduleAt
      >= inactivityScheduleSeconds * 1_000
    ) {
      const schedule = await scheduleSmartRemindersWithDatabase(
        resources.database,
        new Date(scheduleAt),
      );
      lastSmartReminderScheduleAt = scheduleAt;
      console.info(
        JSON.stringify({ event: "smart_reminder.schedule", ...schedule }),
      );
    }
    if (stopping) break;
    const result = await processBatch({
      store,
      adapter,
      from,
      applicationUrl,
      transportConfiguration,
      preparedRuntimePlan,
      watchdog,
    });
    console.info(JSON.stringify(batchLog(result)));
    healthReporter.success();
    if (once || stopping) break;
    await waitForNextPoll(
      result.claimed ? 1_000 : pollSeconds * 1_000,
    );
  } while (!stopping);
}

installTerminationHandlers();
main()
  .catch((error) => {
    healthReporter?.retry(error);
    healthReporter?.terminalFailure(error);
    console.error(JSON.stringify({
      event: "email.worker_failed",
      code: mailWorkerErrorCode(error),
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await beginCleanup();
    finishApplicationLifecycle();
  });
