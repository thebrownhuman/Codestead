import { pool } from "../src/lib/db/client";
import { assertGmailReconciliationOAuthScopes } from "../src/lib/notifications/gmail-oauth-scopes";
import {
  reconcileGmailDelivery,
} from "../src/lib/notifications/gmail-reconciliation";
import { findGmailMessageByMessageId } from "../src/lib/notifications/mailer";
import { PostgresOutboxStore } from "../src/lib/notifications/postgres-outbox-store";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function commandInput(args: readonly string[]) {
  let operationId: string | undefined;
  let confirmOperationId: string | undefined;
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (apply) throw new Error("--apply may be provided only once.");
      apply = true;
      continue;
    }
    if (
      argument === "--operation-id"
      || argument === "--confirm-operation-id"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a UUID.`);
      }
      index += 1;
      if (argument === "--operation-id") {
        if (operationId !== undefined) {
          throw new Error("--operation-id may be provided only once.");
        }
        operationId = value;
      } else {
        if (confirmOperationId !== undefined) {
          throw new Error("--confirm-operation-id may be provided only once.");
        }
        confirmOperationId = value;
      }
      continue;
    }
    throw new Error(`Unknown Gmail reconciliation argument: ${argument ?? ""}`);
  }

  if (!operationId || !UUID.test(operationId)) {
    throw new Error("--operation-id must be a UUID.");
  }
  if (confirmOperationId !== undefined && !UUID.test(confirmOperationId)) {
    throw new Error("--confirm-operation-id must be a UUID.");
  }
  if (apply && confirmOperationId !== operationId) {
    throw new Error(
      "--apply requires --confirm-operation-id to exactly match --operation-id.",
    );
  }
  if (!apply && confirmOperationId !== undefined) {
    throw new Error("--confirm-operation-id is valid only with --apply.");
  }
  return { operationId, apply, confirmOperationId };
}

async function main() {
  if (process.env.GMAIL_RECONCILIATION_ENABLED !== "true") {
    throw new Error("Gmail reconciliation is not explicitly enabled.");
  }
  if (process.env.MAIL_ADAPTER !== "gmail") {
    throw new Error("Gmail reconciliation requires MAIL_ADAPTER=gmail.");
  }
  assertGmailReconciliationOAuthScopes(process.env.GMAIL_OAUTH_SCOPES);
  const input = commandInput(process.argv.slice(2));
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

main()
  .catch((error) => {
    console.error(JSON.stringify({
      event: "email.gmail_reconciliation_failed",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
