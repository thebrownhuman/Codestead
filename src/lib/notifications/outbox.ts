import { createHash, randomUUID } from "node:crypto";

import { db } from "@/lib/db/client";
import { emailOutbox } from "@/lib/db/schema";

export type EmailTemplate =
  | "verify-email"
  | "reset-password"
  | "invitation"
  | "access-request-admin"
  | "lost-device-proof"
  | "access-rejected"
  | "learning-request-updated"
  | "new-device"
  | "session-revocation-requested"
  | "session-revocation-updated"
  | "session-revoked"
  | "account-deleted"
  | "credential-changed"
  | "credential-revealed"
  | "fallback-grant-changed"
  | "learning-plan-changed"
  | "storage-quota-changed"
  | "inactivity-reminder"
  | "inactivity-reminder-followup"
  | "inactivity-admin-notice"
  | "daily-study-reminder"
  | "revision-reminder"
  | "goal-reminder"
  | "challenge-reminder"
  | "exam-result"
  | "mastery-awarded"
  | "appeal-updated"
  | "assessment-corrected"
  | "weekly-summary"
  | "backup-status";

export type AccountEmailTemplate = Exclude<
  EmailTemplate,
  "account-deleted" | "invitation" | "access-rejected" | "access-request-admin"
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

const SYSTEM_EMAIL_TEMPLATES: Readonly<
  Record<SystemEmailProducer, readonly EmailTemplate[]>
> = {
  "access-request-admin": ["access-request-admin"],
  "access-request-approved": ["invitation"],
  "access-request-rejected": ["access-rejected"],
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OutboxTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function queuedEmail(input: EnqueueEmailInput) {
  const recipient = input.to.toLowerCase();
  const operationId = randomUUID();
  const systemInput = "sourceId" in input ? input : undefined;
  const systemProducer = systemInput?.systemProducer;
  if (
    systemProducer &&
    !SYSTEM_EMAIL_TEMPLATES[systemProducer]?.includes(input.template)
  ) {
    throw new Error("System email producer/template pair is not allowed.");
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
    templateVersion: "1",
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
  const row = queuedEmail(input);
  await db
    .insert(emailOutbox)
    .values(row)
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey });
}
