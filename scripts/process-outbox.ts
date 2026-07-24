import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { pool } from "../src/lib/db/client";
import { materializeDeliveryVariables } from "../src/lib/notifications/delivery-variables";
import { scheduleInactivityReminders } from "../src/lib/notifications/inactivity";
import {
  classifyMailDeliveryError,
  sendEmail,
  type OutgoingEmail,
} from "../src/lib/notifications/mailer";
import type { EmailTemplate } from "../src/lib/notifications/outbox";
import {
  PostgresOutboxStore,
  type EmailOutboxPayload,
} from "../src/lib/notifications/postgres-outbox-store";
import { scheduleSmartReminders } from "../src/lib/notifications/smart-reminders";
import {
  processOutboxBatch,
  type ItemOutcome,
  type ProcessOutboxBatchResult,
} from "../src/lib/notifications/outbox-worker";
import { operationalErrorCode } from "../src/lib/security/operational-code";
import { createWorkerHealthReporter } from "./lib/worker-health";

const BATCH_SIZE = 10;
const MATERIALIZE_LEASE_MS = 60_000;
const PROVIDER_LEASE_MS = 300_000;
const MAX_MATERIALIZE_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;
const TERMINAL_PERSISTENCE_ATTEMPTS = 3;
const FENCED_WORKER_MODE = "fenced-postgres-v1";

class OutboxWorkerModeError extends Error {
  constructor() {
    super(`OUTBOX_WORKER_MODE must be exactly ${FENCED_WORKER_MODE}.`);
    this.name = "OUTBOX_WORKER_MODE_INVALID";
  }
}
const POOL_SHUTDOWN_TIMEOUT_MS = 5_000;
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT"] as const;

const workerHost = hostname()
  .replace(/[^A-Za-z0-9._:-]/g, "-")
  .slice(0, 60);
const claimOwner =
  `mail-worker:${workerHost}:${process.pid}:${randomUUID()}`.slice(0, 128);

let healthReporter: ReturnType<typeof createWorkerHealthReporter> | undefined;
let stopping = false;
let finishPollWait: (() => void) | undefined;

class PoolShutdownTimeoutError extends Error {
  constructor() {
    super("Mail worker pool shutdown timed out.");
    this.name = "PoolShutdownTimeoutError";
  }
}

function requestStop() {
  if (stopping) return;
  stopping = true;
  finishPollWait?.();
}

function installTerminationHandlers() {
  for (const signal of TERMINATION_SIGNALS) {
    process.once(signal, requestStop);
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

async function endPoolWithinDeadline() {
  const deadline = performance.now() + POOL_SHUTDOWN_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve().then(() => pool.end());
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new PoolShutdownTimeoutError()),
      POOL_SHUTDOWN_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([close, expired]);
    if (performance.now() >= deadline) {
      throw new PoolShutdownTimeoutError();
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function cleanup() {
  removeTerminationHandlers();
  try {
    await endPoolWithinDeadline();
  } catch (error) {
    process.exitCode = 1;
    console.error(
      JSON.stringify({
        event: "email.worker_cleanup_failed",
        code: error instanceof PoolShutdownTimeoutError
          ? "POOL_SHUTDOWN_TIMEOUT"
          : "POOL_SHUTDOWN_FAILED",
      }),
    );
    if (error instanceof PoolShutdownTimeoutError) {
      process.exit(1);
    }
  }
}

function configuredAdapter(): "console" | "gmail" {
  const adapter = process.env.MAIL_ADAPTER ?? "console";
  if (adapter !== "console" && adapter !== "gmail") {
    throw new Error("MAIL_ADAPTER must be either console or gmail.");
  }
  return adapter;
}

function retryMaterialization(input: {
  attempt: number;
  now: Date;
}): (
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

async function processBatch(
  store: PostgresOutboxStore,
  adapter: "console" | "gmail",
) {
  return processOutboxBatch<EmailOutboxPayload, OutgoingEmail>({
    store,
    materialize: async (claim) => {
      const template = claim.payload.template as EmailTemplate;
      const variables = await materializeDeliveryVariables({
        template,
        variables: { ...claim.payload.variables },
        now: new Date(),
      });
      if (!variables) {
        return {
          kind: "suppressed",
          code: "DELIVERY_PROOF_UNAVAILABLE",
        };
      }
      return {
        kind: "ready",
        message: {
          to: claim.payload.to,
          template,
          variables,
        },
      };
    },
    provider: {
      adapter,
      send: async (message, context) => {
        try {
          const receipt = await sendEmail(message, {
            messageId: context.messageId,
          });
          return {
            kind: "accepted" as const,
            providerMessageId: receipt.providerId,
          };
        } catch (error) {
          const failure = classifyMailDeliveryError(error);
          return failure.kind === "definitely-rejected"
            ? {
                kind: "definitely-rejected" as const,
                code: failure.code,
              }
            : {
                kind: "ambiguous" as const,
                code: failure.code,
              };
        }
      },
    },
    claimOwner,
    newClaimToken: randomUUID,
    shouldStop: () => stopping,
    clock: { now: () => new Date() },
    retryPolicy: {
      unexpectedMaterializeError: ({ attempt, now }) =>
        retryMaterialization({ attempt, now }),
    },
    policy: {
      batchSize: BATCH_SIZE,
      materializeLeaseMs: MATERIALIZE_LEASE_MS,
      providerLeaseMs: PROVIDER_LEASE_MS,
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

  const pollSeconds = Number.parseInt(
    process.env.OUTBOX_POLL_SECONDS ?? "10",
    10,
  );
  if (
    !Number.isInteger(pollSeconds)
    || pollSeconds < 1
    || pollSeconds > 3_600
  ) {
    throw new Error("OUTBOX_POLL_SECONDS must be an integer from 1 to 3600.");
  }
  const inactivityScheduleSeconds = Number.parseInt(
    process.env.INACTIVITY_SCHEDULE_SECONDS ?? "60",
    10,
  );
  if (
    !Number.isInteger(inactivityScheduleSeconds)
    || inactivityScheduleSeconds < 10
    || inactivityScheduleSeconds > 3_600
  ) {
    throw new Error(
      "INACTIVITY_SCHEDULE_SECONDS must be an integer from 10 to 3600.",
    );
  }
  const adapter = configuredAdapter();
  const store = new PostgresOutboxStore(pool);
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
      const schedule = await scheduleInactivityReminders(new Date(scheduleAt));
      lastInactivityScheduleAt = scheduleAt;
      console.info(JSON.stringify({ event: "inactivity.schedule", ...schedule }));
    }
    if (stopping) break;
    if (
      scheduleAt - lastSmartReminderScheduleAt
      >= inactivityScheduleSeconds * 1_000
    ) {
      const schedule = await scheduleSmartReminders(new Date(scheduleAt));
      lastSmartReminderScheduleAt = scheduleAt;
      console.info(
        JSON.stringify({ event: "smart_reminder.schedule", ...schedule }),
      );
    }
    if (stopping) break;
    const result = await processBatch(store, adapter);
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
    console.error(
      JSON.stringify({
        event: "email.worker_failed",
        code: operationalErrorCode(error),
      }),
    );
    process.exitCode = 1;
  })
  .finally(cleanup);
