import { createHash, randomUUID } from "node:crypto";

import type { Database } from "@/lib/db/client";
import { emailOutbox } from "@/lib/db/schema";

import {
  isProductionEmailTemplate,
  isSpecializedAccountEmailTemplate,
  TEMPLATE_AUTHORITY_POLICIES,
  type EmailTemplate as AuthorityEmailTemplate,
  type SpecializedAccountEmailTemplate,
} from "./template-authority-policy";

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

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OutboxTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

function queuedEmail(input: EnqueueEmailInput) {
  const recipient = input.to.toLowerCase();
  const operationId = randomUUID();
  const systemInput = "sourceId" in input ? input : undefined;
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
  const idempotencyKey = createHash("sha256")
    .update(`${input.template}:${recipient}:${input.idempotencySeed}`)
    .digest("hex");

  return {
    operationId,
    userId: systemProducer ? null : input.userId,
    deliveryScopeKey: systemProducer ? `s:${operationId}` : `a:${input.userId}`,
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
        }
      : input.variables,
    idempotencyKey,
  };
}

export async function enqueueEmailInTransaction(
  tx: OutboxTransaction,
  input: EnqueueEmailInput,
) {
  const row = queuedEmail(input);
  await tx
    .insert(emailOutbox)
    .values(row)
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey });
}

export async function enqueueEmail(input: EnqueueEmailInput) {
  const { db } = await import("@/lib/db/client");
  const row = queuedEmail(input);
  await db
    .insert(emailOutbox)
    .values(row)
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey });
}
