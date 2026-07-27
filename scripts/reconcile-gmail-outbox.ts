import { createMailDispatchBootstrapResources } from
  "../src/lib/notifications/mail-dispatch-pool";
import {
  inspectMailDispatchRuntime,
  type MailDispatchRuntimeStartupInspection,
} from "../src/lib/notifications/mail-dispatch-runtime-startup";
import {
  findGmailMessageByMessageId,
} from "../src/lib/notifications/gmail-correlation-lookup";
import { assertGmailReconciliationOAuthScopes } from "../src/lib/notifications/gmail-oauth-scopes";
import {
  reconcileGmailDelivery,
} from "../src/lib/notifications/gmail-reconciliation";
import {
  isFatalProviderTransportError,
} from "../src/lib/notifications/provider-dispatch-contract";
import {
  captureMailDispatchApplicationOrigin,
  mailDispatchApplicationUrl,
  PostgresOutboxStore,
} from "../src/lib/notifications/postgres-outbox-store";
import {
  allowlistedOperationalErrorCode,
} from "../src/lib/security/operational-code";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FALLBACK_POOL_CLOSE_TIMEOUT_MS = 5_000;
const resources = createMailDispatchBootstrapResources();
let startupInspection: MailDispatchRuntimeStartupInspection | undefined;

const GMAIL_RECONCILIATION_ERROR_CODE_VALUES = [
  "GMAIL_RECONCILIATION_ADAPTER_INVALID",
  "GMAIL_RECONCILIATION_DISABLED",
  "GMAIL_RECONCILIATION_FAILED",
  "GMAIL_RECONCILIATION_INPUT_INVALID",
  "GMAIL_RECONCILIATION_OAUTH_SCOPE_INVALID",
  "GMAIL_RECONCILIATION_POOL_CLOSE_FAILED",
] as const;
type GmailReconciliationErrorCode =
  (typeof GMAIL_RECONCILIATION_ERROR_CODE_VALUES)[number];
const GMAIL_RECONCILIATION_ERROR_CODES = new Set(
  GMAIL_RECONCILIATION_ERROR_CODE_VALUES,
);

class GmailReconciliationOperationalError extends Error {
  readonly code: GmailReconciliationErrorCode;

  constructor(code: GmailReconciliationErrorCode) {
    super(code);
    this.name = "GmailReconciliationOperationalError";
    this.code = code;
  }
}

class GmailReconciliationPoolCloseTimeoutError extends Error {
  constructor() {
    super("Gmail reconciliation pool close timed out.");
    this.name = "GmailReconciliationPoolCloseTimeoutError";
  }
}

function failReconciliation(code: GmailReconciliationErrorCode): never {
  throw new GmailReconciliationOperationalError(code);
}

function reconciliationErrorCode(error: unknown) {
  return allowlistedOperationalErrorCode(
    error,
    GMAIL_RECONCILIATION_ERROR_CODES,
  ) ?? "GMAIL_RECONCILIATION_FAILED";
}

function commandInput(args: readonly string[]) {
  let operationId: string | undefined;
  let confirmOperationId: string | undefined;
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (apply) {
        failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
      }
      apply = true;
      continue;
    }
    if (
      argument === "--operation-id"
      || argument === "--confirm-operation-id"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
      }
      index += 1;
      if (argument === "--operation-id") {
        if (operationId !== undefined) {
          failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
        }
        operationId = value;
      } else {
        if (confirmOperationId !== undefined) {
          failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
        }
        confirmOperationId = value;
      }
      continue;
    }
    failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
  }

  if (!operationId || !UUID.test(operationId)) {
    failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
  }
  if (confirmOperationId !== undefined && !UUID.test(confirmOperationId)) {
    failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
  }
  if (apply && confirmOperationId !== operationId) {
    failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
  }
  if (!apply && confirmOperationId !== undefined) {
    failReconciliation("GMAIL_RECONCILIATION_INPUT_INVALID");
  }
  return { operationId, apply, confirmOperationId };
}

async function main() {
  if (process.env.GMAIL_RECONCILIATION_ENABLED !== "true") {
    failReconciliation("GMAIL_RECONCILIATION_DISABLED");
  }
  if (process.env.MAIL_ADAPTER !== "gmail") {
    failReconciliation("GMAIL_RECONCILIATION_ADAPTER_INVALID");
  }
  const input = commandInput(process.argv.slice(2));
  startupInspection = await inspectMailDispatchRuntime(resources.pool);
  if (
    startupInspection.plan.pool.serverCapacity
      .gmailReconciliationReserveConnections !== resources.pool.options.max
  ) {
    throw new Error("Gmail reconciliation server capacity is invalid.");
  }
  const applicationOrigin = captureMailDispatchApplicationOrigin(
    startupInspection,
  );
  mailDispatchApplicationUrl(applicationOrigin);
  const store = new PostgresOutboxStore(
    resources.pool,
    startupInspection,
    applicationOrigin,
  );
  try {
    assertGmailReconciliationOAuthScopes(process.env.GMAIL_OAUTH_SCOPES);
  } catch {
    failReconciliation("GMAIL_RECONCILIATION_OAUTH_SCOPE_INVALID");
  }
  const result = await reconcileGmailDelivery(input, {
    store,
    gmail: { findByMessageId: findGmailMessageByMessageId },
  });
  console.info(JSON.stringify({
    event: "email.gmail_reconciliation",
    outcome: result.kind,
    applied: result.kind === "applied" || result.kind === "already-applied",
  }));
  if (input.apply && result.kind !== "applied" && result.kind !== "already-applied") {
    process.exitCode = 2;
  }
}

async function closePoolWithinDeadline() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const close = Promise.resolve()
    .then(() => resources.pool.end())
    .then(
      () => ({ kind: "closed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
  const deadlineMs = startupInspection?.plan.timeouts.poolCloseMs
    ?? FALLBACK_POOL_CLOSE_TIMEOUT_MS;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new GmailReconciliationPoolCloseTimeoutError()),
      deadlineMs,
    );
  });

  try {
    const outcome = await Promise.race([close, expired]);
    if (outcome.kind === "failed") throw outcome.error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function closePool() {
  try {
    await closePoolWithinDeadline();
  } catch (error) {
    console.error(JSON.stringify({
      event: "email.gmail_reconciliation_cleanup_failed",
      code: "GMAIL_RECONCILIATION_POOL_CLOSE_FAILED",
    }));
    process.exitCode = 1;
    if (error instanceof GmailReconciliationPoolCloseTimeoutError) {
      process.exit(1);
      await new Promise<never>(() => undefined);
    }
  }
}

export const gmailReconciliationCommand = main()
  .then(
    () => false,
    (error) => {
      const transportFatal = isFatalProviderTransportError(error);
      console.error(JSON.stringify({
        event: "email.gmail_reconciliation_failed",
        code: transportFatal
          ? "GMAIL_RECONCILIATION_TRANSPORT_FATAL"
          : reconciliationErrorCode(error),
      }));
      process.exitCode = 1;
      return transportFatal;
    },
  )
  .finally(closePool)
  .then(async (transportFatal) => {
    if (!transportFatal) return;
    process.exit(1);
    await new Promise<never>(() => undefined);
  });
