import { pool } from "../src/lib/db/client";
import { assertGmailReconciliationOAuthScopes } from "../src/lib/notifications/gmail-oauth-scopes";
import {
  reconcileGmailDelivery,
} from "../src/lib/notifications/gmail-reconciliation";
import { findGmailMessageByMessageId } from "../src/lib/notifications/mailer";
import { PostgresOutboxStore } from "../src/lib/notifications/postgres-outbox-store";
import {
  allowlistedOperationalErrorCode,
} from "../src/lib/security/operational-code";

export const GMAIL_RECONCILIATION_POOL_MAXIMUM_CONNECTIONS = 1;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GMAIL_RECONCILIATION_ERROR_CODE_VALUES = [
  "GMAIL_RECONCILIATION_ADAPTER_INVALID",
  "GMAIL_RECONCILIATION_DISABLED",
  "GMAIL_RECONCILIATION_FAILED",
  "GMAIL_RECONCILIATION_INPUT_INVALID",
  "GMAIL_RECONCILIATION_OAUTH_SCOPE_INVALID",
  "GMAIL_RECONCILIATION_POOL_INVALID",
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

function failReconciliation(code: GmailReconciliationErrorCode): never {
  throw new GmailReconciliationOperationalError(code);
}

function reconciliationErrorCode(error: unknown) {
  return allowlistedOperationalErrorCode(
    error,
    GMAIL_RECONCILIATION_ERROR_CODES,
  ) ?? "GMAIL_RECONCILIATION_FAILED";
}

function hasExactReconciliationPoolOptions(): boolean {
  try {
    const options = pool.options;
    return (
      options?.max
        === GMAIL_RECONCILIATION_POOL_MAXIMUM_CONNECTIONS
      && options.connectionTimeoutMillis === 5_000
      && options.idleTimeoutMillis === 30_000
    );
  } catch {
    return false;
  }
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
  try {
    assertGmailReconciliationOAuthScopes(process.env.GMAIL_OAUTH_SCOPES);
  } catch {
    failReconciliation("GMAIL_RECONCILIATION_OAUTH_SCOPE_INVALID");
  }
  const input = commandInput(process.argv.slice(2));
  if (!hasExactReconciliationPoolOptions()) {
    failReconciliation("GMAIL_RECONCILIATION_POOL_INVALID");
  }
  const store = new PostgresOutboxStore(pool);
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

async function closePool() {
  try {
    await pool.end();
  } catch {
    console.error(JSON.stringify({
      event: "email.gmail_reconciliation_cleanup_failed",
      code: "GMAIL_RECONCILIATION_POOL_CLOSE_FAILED",
    }));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "email.gmail_reconciliation_failed",
      code: reconciliationErrorCode(error),
    }));
    process.exitCode = 1;
  })
  .finally(closePool);
