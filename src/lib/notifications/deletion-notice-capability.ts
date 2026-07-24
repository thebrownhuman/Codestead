import { createHash, createHmac } from "node:crypto";

export const ACCOUNT_DELETION_NOTICE_TEMPLATE = "account-deleted";
export const ACCOUNT_DELETION_NOTICE_TEMPLATE_VERSION = "1";

export type AccountDeletionNoticeVariables = Readonly<{
  backupRetentionUntil: string;
  tombstoneId: string;
  deletionRunId: string;
}>;

export type AccountDeletionNoticeDigestBinding = Readonly<{
  recipientHmacSha256: string;
  payloadSha256: string;
}>;

function frame(value: string) {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function deletionNoticeSecret() {
  const value = process.env.DELETION_TOMBSTONE_KEY
    ?? (process.env.NODE_ENV === "production" ? undefined : process.env.BETTER_AUTH_SECRET);
  if (!value || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("DELETION_TOMBSTONE_KEY must contain at least 32 bytes.");
  }
  return value;
}

export function accountDeletionNoticeBinding(input: Readonly<{
  recipient: string;
  variables: AccountDeletionNoticeVariables;
  secret: string;
}>): AccountDeletionNoticeDigestBinding {
  if (Buffer.byteLength(input.secret, "utf8") < 32) {
    throw new Error("Deletion notice HMAC key is too short.");
  }
  const recipient = input.recipient.trim().toLowerCase();
  if (!recipient) throw new Error("Deletion notice recipient is required.");

  const recipientHmacSha256 = createHmac("sha256", input.secret)
    .update("learncoding:account-deletion-notice-recipient:v1\0", "utf8")
    .update(frame(input.variables.tombstoneId), "utf8")
    .update("|", "utf8")
    .update(frame(recipient), "utf8")
    .digest("hex");
  const payloadSha256 = createHash("sha256")
    .update([
      "learncoding:account-deletion-notice-payload:v1",
      ACCOUNT_DELETION_NOTICE_TEMPLATE,
      ACCOUNT_DELETION_NOTICE_TEMPLATE_VERSION,
      input.variables.backupRetentionUntil,
      input.variables.tombstoneId,
      input.variables.deletionRunId,
    ].map(frame).join("|"), "utf8")
    .digest("hex");

  return { recipientHmacSha256, payloadSha256 };
}
