import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";

import { db } from "@/lib/db/client";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";

import {
  isProductionEmailTemplate,
  isSpecializedAccountEmailTemplate,
  TEMPLATE_AUTHORITY_POLICIES,
  type EmailTemplate as AuthorityEmailTemplate,
  type SpecializedAccountEmailTemplate,
} from "./template-authority-policy";
import {
  accountMailEventIdempotencyKey,
  MAIL_IDEMPOTENCY_AUTHORITY_VERSION,
  systemMailEventIdempotencyKey,
} from "./idempotency-authority";

export type EmailTemplate = AuthorityEmailTemplate;

export type AccountEmailTemplate = Exclude<
  EmailTemplate,
  | "account-deleted"
  | "invitation"
  | "access-rejected"
  | "access-request-admin"
  | SpecializedAccountEmailTemplate
>;

type EmailInput = {
  to: string;
  variables: Record<string, string>;
  idempotencySeed: string;
};

export type SystemEmailProducer =
  | "access-request-admin"
  | "access-request-approved"
  | "access-request-rejected";

type AccountEmailInput = EmailInput & {
  template: AccountEmailTemplate;
  userId: string;
  systemProducer?: never;
};

type SystemEmailInput = EmailInput & {
  audienceId: string;
  sourceId: string;
  userId?: never;
} & (
    | {
        template: "access-request-admin";
        systemProducer: "access-request-admin";
      }
    | {
        template: "invitation";
        systemProducer: "access-request-approved";
      }
    | {
        template: "access-rejected";
        systemProducer: "access-request-rejected";
      }
  );

export type EnqueueEmailInput = AccountEmailInput | SystemEmailInput;
export class EmailOutboxReplayConflictError extends Error {
  readonly code = "EMAIL_OUTBOX_REPLAY_CONFLICT";

  constructor() {
    super("Email outbox replay conflicts with durable authority.");
    this.name = "EmailOutboxReplayConflictError";
  }
}

export class EmailOutboxPersistenceError extends Error {
  readonly code = "EMAIL_OUTBOX_PERSISTENCE_FAILED";

  constructor() {
    super("Email outbox persistence failed.");
    this.name = "EmailOutboxPersistenceError";
  }
}

export class EmailOutboxReleaseReceiptError extends Error {
  readonly code = "EMAIL_OUTBOX_RELEASE_RECEIPT_INVALID";

  constructor() {
    super("Email outbox delivery release receipt is invalid.");
    this.name = "EmailOutboxReleaseReceiptError";
  }
}

type EmailOutboxReleaseResult = Readonly<{
  rowCount: number | null;
  rows: readonly unknown[];
}>;

type ExpectedEmailOutboxRelease = Readonly<{
  outboxId: string;
  operationId: string;
}>;

export function assertEmailOutboxDeliveryRelease(
  result: EmailOutboxReleaseResult,
  expected: ExpectedEmailOutboxRelease,
): void {
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new EmailOutboxReleaseReceiptError();
  }

  try {
    const [row] = result.rows;
    if (
      row === null
      || typeof row !== "object"
      || Reflect.get(row, "outbox_id") !== expected.outboxId
      || Reflect.get(row, "operation_id") !== expected.operationId
    ) {
      throw new EmailOutboxReleaseReceiptError();
    }
  } catch (error) {
    if (error instanceof EmailOutboxReleaseReceiptError) throw error;
    throw new EmailOutboxReleaseReceiptError();
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OutboxTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type InsertedEmailOutboxRelease = Readonly<{
  id: string;
  operation_id: string;
  idempotency_authority_sha256: string;
  idempotency_original_payload_sha256: string;
  delivery_hold_version: string;
}>;

function isDurableReplayConflict(error: unknown): boolean {
  try {
    if (!(error instanceof DrizzleQueryError)) return false;
    const cause = error.cause;
    if (cause === null || typeof cause !== "object") return false;
    return (
      Reflect.get(cause, "code") === "23505" &&
      Reflect.get(cause, "constraint") ===
        "email_outbox_idempotency_authority_pkey"
    );
  } catch {
    return false;
  }
}

function normalizeOutboxPersistenceError(error: unknown) {
  return isDurableReplayConflict(error)
    ? new EmailOutboxReplayConflictError()
    : new EmailOutboxPersistenceError();
}

function queuedEmail(input: EnqueueEmailInput) {
  const recipient = input.to.trim().toLowerCase();
  if (!recipient || !/^[\x00-\x7f]+$/u.test(recipient)) {
    throw new Error("Email recipient must be canonical ASCII.");
  }
  const operationId = randomUUID();
  const systemInput = "sourceId" in input ? input : undefined;
  const accountInput = systemInput ? undefined : (input as AccountEmailInput);
  const systemProducer = systemInput?.systemProducer;
  if (!isProductionEmailTemplate(input.template)) {
    throw new Error(
      "Email template is not registered for production delivery.",
    );
  }
  const policy = TEMPLATE_AUTHORITY_POLICIES[input.template];
  if (
    systemProducer &&
    (policy.scope !== "system" || policy.producer !== systemProducer)
  ) {
    throw new Error("System email producer/template pair is not allowed.");
  }
  if (!systemProducer && policy.scope !== "account") {
    throw new Error(
      "Account email template is not allowed for the generic producer.",
    );
  }
  if (!systemProducer && input.template === "backup-status") {
    throw new Error(
      "Email template backup-status requires its specialized producer.",
    );
  }
  if (!systemProducer && isSpecializedAccountEmailTemplate(input.template)) {
    throw new Error(
      `Email template ${input.template} requires its specialized producer.`,
    );
  }
  if (policy.versions.length !== 1) {
    throw new Error(
      `Email template ${input.template} must resolve to exactly one production version.`,
    );
  }
  if (systemInput && !UUID.test(systemInput.sourceId)) {
    throw new Error("System email source ID must be a UUID.");
  }
  if (
    !systemProducer &&
    (!input.userId || input.userId.trim() !== input.userId)
  ) {
    throw new Error("Account email user ID must be nonblank and canonical.");
  }
  const idempotencyKey = systemInput
    ? systemMailEventIdempotencyKey({
        eventId: input.idempotencySeed,
        audienceId: systemInput.audienceId,
        producer: systemInput.systemProducer,
        sourceId: systemInput.sourceId,
        template: input.template,
      })
    : accountMailEventIdempotencyKey({
        eventId: input.idempotencySeed,
        template: input.template,
        userId: accountInput!.userId,
      });

  return {
    operationId,
    userId: systemProducer ? null : accountInput!.userId,
    deliveryScopeKey: systemProducer
      ? `s:${operationId}`
      : `a:${accountInput!.userId}`,
    toEmail: recipient,
    template: input.template,
    templateVersion: policy.versions[0],
    variables: systemProducer
      ? {
          ...input.variables,
          _mailOperationId: operationId,
          _mailRecipient: recipient,
          _mailProducer: systemProducer,
          _mailSourceId: systemInput!.sourceId,
          _mailAudienceId: systemInput!.audienceId,
        }
      : input.variables,
    idempotencyKey,
    idempotencyAuthorityVersion: MAIL_IDEMPOTENCY_AUTHORITY_VERSION,
  };
}

function queuedEmailInsert(row: ReturnType<typeof queuedEmail>) {
  const accountAuthorityKey = row.userId
    ? userAuthorityLockKey(row.userId)
    : "";
  return sql<InsertedEmailOutboxRelease>`
    INSERT INTO public.email_outbox (
      operation_id,
      user_id,
      delivery_scope_key,
      to_email,
      template,
      template_version,
      variables,
      idempotency_key,
      idempotency_authority_version,
      status,
      next_attempt_at
    ) SELECT
      ${row.operationId},
      ${row.userId},
      ${row.deliveryScopeKey},
      ${row.toEmail},
      ${row.template},
      ${row.templateVersion},
      ${JSON.stringify(row.variables)}::pg_catalog.jsonb,
      ${row.idempotencyKey},
      ${row.idempotencyAuthorityVersion},
      'pending',
      pg_catalog.now()
    FROM (
      SELECT CASE
        WHEN ${row.userId}::pg_catalog.text IS NULL THEN true
        ELSE pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtext(${accountAuthorityKey})::pg_catalog.int8
        )
      END AS locked
    ) account_authority
    LEFT JOIN public."user" authority_user
      ON authority_user.id = ${row.userId}
    WHERE ${row.userId}::pg_catalog.text IS NULL
       OR (
         account_authority.locked
         AND authority_user.id IS NOT NULL
         AND authority_user.status NOT IN ('deletion_pending', 'deleted')
         AND pg_catalog.lower(pg_catalog.btrim(authority_user.email)) = ${row.toEmail}
       )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING
      id::pg_catalog.text AS id,
      operation_id::pg_catalog.text AS operation_id,
      idempotency_authority_sha256,
      idempotency_original_payload_sha256,
      delivery_hold_version
  `;
}
async function persistQueuedEmail(
  tx: OutboxTransaction,
  row: ReturnType<typeof queuedEmail>,
) {
  const inserted = await tx.execute<InsertedEmailOutboxRelease>(
    queuedEmailInsert(row),
  );
  const release = inserted.rows[0];
  if (!release) {
    if (row.userId !== null) {
      const replay = await tx.execute<{ id: string }>(sql`
        SELECT id::pg_catalog.text AS id
          FROM public.email_outbox
         WHERE idempotency_key = ${row.idempotencyKey}
         LIMIT 1
      `);
      if (!replay.rows[0]) {
        throw new Error("Account email authority is unavailable.");
      }
    }
    return;
  }
  const released = await tx.execute(sql<{
    outbox_id: string;
    operation_id: string;
  }>`
    SELECT released.outbox_id::pg_catalog.text AS outbox_id,
           released.operation_id::pg_catalog.text AS operation_id
      FROM public.release_email_outbox_delivery(
        ${release.id}::pg_catalog.uuid,
        ${release.operation_id}::pg_catalog.uuid,
        ${release.idempotency_authority_sha256}::pg_catalog.text,
        ${release.idempotency_original_payload_sha256}::pg_catalog.text,
        ${release.delivery_hold_version}::pg_catalog.text
      ) AS released
  `);
  assertEmailOutboxDeliveryRelease(released, {
    outboxId: release.id,
    operationId: release.operation_id,
  });
}

export async function enqueueEmailInTransaction(
  tx: OutboxTransaction,
  input: EnqueueEmailInput,
) {
  const row = queuedEmail(input);
  try {
    await persistQueuedEmail(tx, row);
  } catch (error) {
    throw normalizeOutboxPersistenceError(error);
  }
}

export async function enqueueEmail(input: EnqueueEmailInput) {
  const row = queuedEmail(input);
  try {
    await db.transaction((tx) => persistQueuedEmail(tx, row));
  } catch (error) {
    throw normalizeOutboxPersistenceError(error);
  }
}
