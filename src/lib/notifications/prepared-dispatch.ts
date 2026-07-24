import { createHash } from "node:crypto";

import type { EmailTemplate } from "./outbox";
import { renderEmail } from "./templates";

export interface OutgoingEmail {
  to: string;
  template: EmailTemplate;
  variables: Record<string, string>;
}

export interface MailProviderContext {
  messageId: string;
}

export type MailAdapter = "console" | "gmail";

export type MailDispatchAuthority = Readonly<{
  id: string;
  operationId: string;
  claimToken: string;
  claimOwner: string;
  claimVersion: number;
}>;

export type MailPreparationContext = Readonly<{
  adapter: MailAdapter;
  from: string;
  messageId: string;
  authority: MailDispatchAuthority;
}>;

export type PreparedGmailEmail = Readonly<{
  adapter: "gmail";
  bindingVersion: "gmail-raw-v1";
  bindingSha256: string;
  messageId: string;
  rfc822: string;
  raw: string;
  requestBody: string;
}>;

export type PreparedConsoleEmail = Readonly<{
  adapter: "console";
  bindingVersion: "console-json-v1";
  bindingSha256: string;
  eventLine: string;
  requestBody: string;
  providerId: string;
}>;

export type PreparedEmail = PreparedGmailEmail | PreparedConsoleEmail;

const OUTBOX_MESSAGE_ID =
  /^<codestead\.outbox\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@mail\.codestead\.invalid>$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DISPATCH_BINDING_DOMAIN = "codestead.mail.dispatch-binding.v1";
const EMAIL_TEMPLATES: readonly EmailTemplate[] = Object.freeze([
  "verify-email",
  "reset-password",
  "invitation",
  "access-request-admin",
  "lost-device-proof",
  "access-rejected",
  "learning-request-updated",
  "new-device",
  "session-revocation-requested",
  "session-revocation-updated",
  "session-revoked",
  "account-deleted",
  "credential-changed",
  "credential-revealed",
  "fallback-grant-changed",
  "learning-plan-changed",
  "storage-quota-changed",
  "inactivity-reminder",
  "inactivity-reminder-followup",
  "inactivity-admin-notice",
  "daily-study-reminder",
  "revision-reminder",
  "goal-reminder",
  "challenge-reminder",
  "exam-result",
  "mastery-awarded",
  "appeal-updated",
  "assessment-corrected",
  "weekly-summary",
  "backup-status",
]);

function assertMailAdapter(value: unknown): asserts value is MailAdapter {
  if (value !== "console" && value !== "gmail") {
    throw new Error("Invalid mail adapter.");
  }
}

function assertEmailTemplate(value: unknown): asserts value is EmailTemplate {
  if (!EMAIL_TEMPLATES.includes(value as EmailTemplate)) {
    throw new Error("Invalid email template.");
  }
}

function headerValue(value: string, name: string) {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${name} header.`);
  }
  return value;
}

export function gmailCorrelationHeader(messageId: string) {
  const header = headerValue(messageId, "Message-ID");
  if (!OUTBOX_MESSAGE_ID.test(header)) {
    throw new Error("Invalid Message-ID header.");
  }
  return header;
}

function assertBindingText(value: string, name: string, maximumLength: number) {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximumLength
    || /[\u0000]/.test(value)
  ) {
    throw new Error(`Invalid mail dispatch ${name}.`);
  }
  return value;
}

function assertAuthority(authority: MailDispatchAuthority) {
  assertBindingText(authority.id, "ID", 200);
  assertBindingText(authority.operationId, "operation ID", 200);
  assertBindingText(authority.claimToken, "claim token", 200);
  assertBindingText(authority.claimOwner, "claim owner", 128);
  if (
    !Number.isSafeInteger(authority.claimVersion)
    || authority.claimVersion <= 0
  ) {
    throw new Error("Invalid mail dispatch claim version.");
  }
}

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: string,
) {
  const byteLength = Buffer.byteLength(value, "utf8");
  hash.update(`${byteLength}:`, "utf8");
  hash.update(value, "utf8");
}

function bindingSha256(
  prepared: Omit<PreparedGmailEmail, "bindingSha256">
    | Omit<PreparedConsoleEmail, "bindingSha256">,
  authority: MailDispatchAuthority,
) {
  assertAuthority(authority);
  const hash = createHash("sha256");
  updateLengthFramed(hash, DISPATCH_BINDING_DOMAIN);
  updateLengthFramed(hash, prepared.bindingVersion);
  updateLengthFramed(hash, prepared.adapter);
  updateLengthFramed(hash, authority.id);
  updateLengthFramed(hash, authority.operationId);
  updateLengthFramed(hash, authority.claimToken);
  updateLengthFramed(hash, authority.claimOwner);
  updateLengthFramed(hash, String(authority.claimVersion));
  if (prepared.adapter === "gmail") {
    updateLengthFramed(hash, prepared.messageId);
    updateLengthFramed(hash, prepared.rfc822);
    updateLengthFramed(hash, prepared.raw);
    updateLengthFramed(hash, prepared.requestBody);
  } else {
    updateLengthFramed(hash, prepared.eventLine);
    updateLengthFramed(hash, prepared.requestBody);
    updateLengthFramed(hash, prepared.providerId);
  }
  return hash.digest("hex");
}

function mimeMessage(
  input: OutgoingEmail,
  context: MailPreparationContext,
) {
  const rendered = renderEmail(input.template, input.variables);
  const boundary = `learncoding-${crypto.randomUUID()}`;
  const from = headerValue(context.from, "From");
  const to = headerValue(input.to, "To");
  const subject = headerValue(rendered.subject, "Subject");
  const messageId = gmailCorrelationHeader(context.messageId);
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    rendered.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    rendered.html,
    `--${boundary}--`,
  ].join("\r\n");
}

function assertNoBackupArchive(input: OutgoingEmail) {
  if (
    input.template === "backup-status"
    && /archive|\.sql|\.tar|\.zip/i.test(input.variables.url ?? "")
  ) {
    throw new Error("Backup archives may not be emailed.");
  }
}

export function prepareEmail(
  input: OutgoingEmail,
  context: MailPreparationContext,
): PreparedEmail {
  assertMailAdapter(context.adapter);
  assertEmailTemplate(input.template);
  assertNoBackupArchive(input);
  assertAuthority(context.authority);
  if (context.adapter === "console") {
    const eventLine =
      `{"event":"email.console_delivery","template":"${input.template}"}`;
    const withoutBinding = Object.freeze({
      adapter: "console" as const,
      bindingVersion: "console-json-v1" as const,
      eventLine,
      requestBody: eventLine,
      providerId: `console-${crypto.randomUUID()}`,
    });
    return Object.freeze({
      ...withoutBinding,
      bindingSha256: bindingSha256(withoutBinding, context.authority),
    });
  }

  const messageId = gmailCorrelationHeader(context.messageId);
  const rfc822 = mimeMessage(input, context);
  const raw = Buffer.from(rfc822, "utf8").toString("base64url");
  const requestBody = `{"raw":"${raw}"}`;
  const withoutBinding = Object.freeze({
    adapter: "gmail" as const,
    bindingVersion: "gmail-raw-v1" as const,
    messageId,
    rfc822,
    raw,
    requestBody,
  });
  return Object.freeze({
    ...withoutBinding,
    bindingSha256: bindingSha256(withoutBinding, context.authority),
  });
}

export function preparedEmailBindingMatches(
  prepared: PreparedEmail,
  authority: MailDispatchAuthority,
) {
  try {
    if (!SHA256_HEX.test(prepared.bindingSha256)) return false;
    const withoutBinding = prepared.adapter === "gmail"
      ? {
        adapter: prepared.adapter,
        bindingVersion: prepared.bindingVersion,
        messageId: prepared.messageId,
        rfc822: prepared.rfc822,
        raw: prepared.raw,
        requestBody: prepared.requestBody,
      }
      : {
        adapter: prepared.adapter,
        bindingVersion: prepared.bindingVersion,
        eventLine: prepared.eventLine,
        requestBody: prepared.requestBody,
        providerId: prepared.providerId,
      };
    return (
      bindingSha256(withoutBinding, authority)
      === prepared.bindingSha256
    );
  } catch {
    return false;
  }
}
