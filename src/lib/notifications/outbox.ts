import { createHash } from "node:crypto";

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

export type EnqueueEmailInput = {
  to: string;
  template: EmailTemplate;
  variables: Record<string, string>;
  userId?: string;
  idempotencySeed: string;
};

type OutboxTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function queuedEmail(input: EnqueueEmailInput) {
  const idempotencyKey = createHash("sha256")
    .update(`${input.template}:${input.to.toLowerCase()}:${input.idempotencySeed}`)
    .digest("hex");

  return {
    userId: input.userId,
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
  await tx
    .insert(emailOutbox)
    .values(queuedEmail(input))
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey });
}

export async function enqueueEmail(input: EnqueueEmailInput) {
  await db
    .insert(emailOutbox)
    .values(queuedEmail(input))
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey });
}
