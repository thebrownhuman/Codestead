import { createHash, randomUUID } from "node:crypto";

import { db } from "@/lib/db/client";
import { emailOutbox } from "@/lib/db/schema";

export type EmailTemplate =
  | "verify-email"
  | "reset-password"
  | "invitation"
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

export type AccountEmailTemplate = Exclude<EmailTemplate, "account-deleted">;

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

type SystemEmailInput =
  | EmailInput & {
    template: "invitation";
    systemProducer: "access-request-admin" | "access-request-approved";
    userId?: never;
  }
  | EmailInput & {
    template: "access-rejected";
    systemProducer: "access-request-rejected";
    userId?: never;
  };

export type EnqueueEmailInput = AccountEmailInput | SystemEmailInput;

const SYSTEM_EMAIL_TEMPLATES: Readonly<
  Record<SystemEmailProducer, readonly EmailTemplate[]>
> = {
  "access-request-admin": ["invitation"],
  "access-request-approved": ["invitation"],
  "access-request-rejected": ["access-rejected"],
};

type OutboxTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function queuedEmail(input: EnqueueEmailInput) {
  const operationId = randomUUID();
  const systemProducer = "systemProducer" in input
    ? input.systemProducer
    : undefined;
  if (
    systemProducer
    && !SYSTEM_EMAIL_TEMPLATES[systemProducer]?.includes(input.template)
  ) {
    throw new Error("System email producer/template pair is not allowed.");
  }
  if (!systemProducer && (!input.userId || input.userId.trim() !== input.userId)) {
    throw new Error("Account email user ID must be nonblank and canonical.");
  }
  const idempotencyKey = createHash("sha256")
    .update(`${input.template}:${input.to.toLowerCase()}:${input.idempotencySeed}`)
    .digest("hex");

  return {
    operationId,
    userId: systemProducer ? null : input.userId,
    deliveryScopeKey: systemProducer
      ? `s:${operationId}`
      : `a:${input.userId}`,
    toEmail: input.to.toLowerCase(),
    template: input.template,
    templateVersion: "1",
    variables: input.variables,
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
