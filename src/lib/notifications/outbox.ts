import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";

import { db } from "@/lib/db/client";

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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OutboxTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function isDurableReplayConflict(error: unknown): boolean {
  try {
    if (!(error instanceof DrizzleQueryError)) return false;
    const cause = error.cause;
    if (cause === null || typeof cause !== "object") return false;
    return (
      Reflect.get(cause, "code") === "23505"
      && Reflect.get(cause, "constraint")
        === "email_outbox_idempotency_authority_pkey"
    );
  } catch {
    return false;
  }
}

function normalizeOutboxInsertError(error: unknown) {
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
  const accountInput = systemInput
    ? undefined
    : (input as AccountEmailInput);
  const systemProducer = systemInput?.systemProducer;
  if (!isProductionEmailTemplate(input.template)) {
    throw new Error("Email template is not registered for production delivery.");
  }
  const policy = TEMPLATE_AUTHORITY_POLICIES[input.template];
  if (systemProducer && (
    policy.scope !== "system"
    || policy.producer !== systemProducer
  )) {
    throw new Error("System email producer/template pair is not allowed.");
  }
  if (!systemProducer && policy.scope !== "account") {
    throw new Error("Account email template is not allowed for the generic producer.");
  }
  if (
    !systemProducer
    && input.template === "backup-status"
  ) {
    throw new Error(
      "Email template backup-status requires its specialized producer.",
    );
  }
  if (
    !systemProducer
    && isSpecializedAccountEmailTemplate(input.template)
  ) {
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
  return sql`
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
    ) VALUES (
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
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `;
}

export async function enqueueEmailInTransaction(
  tx: OutboxTransaction,
  input: EnqueueEmailInput,
) {
  const row = queuedEmail(input);
  try {
    await tx.execute(queuedEmailInsert(row));
  } catch (error) {
    throw normalizeOutboxInsertError(error);
  }
}

export async function enqueueEmail(input: EnqueueEmailInput) {
  const row = queuedEmail(input);
  try {
    await db.execute(queuedEmailInsert(row));
  } catch (error) {
    throw normalizeOutboxInsertError(error);
  }
}
