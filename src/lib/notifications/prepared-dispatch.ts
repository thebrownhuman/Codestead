import { createHash } from "node:crypto";

import { outboxMessageId } from "./provider-correlation";
import {
  PRODUCTION_EMAIL_TEMPLATES,
  resolveEmailTemplateAuthorityPolicy,
  type EmailTemplate,
} from "./template-authority-policy";
import { renderEmail } from "./templates";

export interface OutgoingEmail {
  to: string;
  template: EmailTemplate;
  templateVersion?: string;
  variables: Record<string, string>;
}

export type AuthoritativeOutgoingEmail = OutgoingEmail & Readonly<{
  templateVersion: string;
}>;

export interface MailProviderContext {
  messageId: string;
}

export type MailAdapter = "console" | "gmail";

type DispatchAuthority<SourceDigest extends string> = Readonly<{
  id: string;
  operationId: string;
  claimToken: string;
  claimOwner: string;
  claimVersion: number;
  deliveryScopeKey: string;
  sourceAuthoritySha256: SourceDigest;
  recipient: string;
  template: EmailTemplate;
  templateVersion: string;
}>;

export type MailDispatchAuthority =
  DispatchAuthority<SourceAuthoritySha256>;
export type CompatibilityMailDispatchAuthority =
  DispatchAuthority<CompatibilitySourceAuthoritySha256>;
export type PreparedMailDispatchAuthority =
  | MailDispatchAuthority
  | CompatibilityMailDispatchAuthority;

export type MailPreparationContext = Readonly<{
  adapter: MailAdapter;
  from: string;
  messageId: string;
  authority: PreparedMailDispatchAuthority;
}>;

declare const providerPayloadSha256Brand: unique symbol;
declare const authoritySealSha256Brand: unique symbol;
declare const sourceAuthoritySha256Brand: unique symbol;
declare const compatibilitySourceAuthoritySha256Brand: unique symbol;

export type ProviderPayloadSha256 = string & Readonly<{
  [providerPayloadSha256Brand]: "ProviderPayloadSha256";
}>;

export type AuthoritySealSha256 = string & Readonly<{
  [authoritySealSha256Brand]: "AuthoritySealSha256";
}>;

export type SourceAuthoritySha256 = string & Readonly<{
  [sourceAuthoritySha256Brand]: "SourceAuthoritySha256";
}>;

export type CompatibilitySourceAuthoritySha256 = string & Readonly<{
  [compatibilitySourceAuthoritySha256Brand]:
    "CompatibilitySourceAuthoritySha256";
}>;
export type DispatchBinding = Readonly<{
  bindingVersion: "gmail-raw-v1" | "console-json-v1";
  bindingSha256: ProviderPayloadSha256;
}>;

export type PreparedGmailEmail = Readonly<{
  adapter: "gmail";
  bindingVersion: "gmail-raw-v1";
  bindingSha256: ProviderPayloadSha256;
  authorityBindingVersion: "prepared-authority-v1";
  authorityBindingSha256: AuthoritySealSha256;
  messageId: string;
  rfc822: string;
  raw: string;
  requestBody: string;
}>;

export type PreparedConsoleEmail = Readonly<{
  adapter: "console";
  bindingVersion: "console-json-v1";
  bindingSha256: ProviderPayloadSha256;
  authorityBindingVersion: "prepared-authority-v1";
  authorityBindingSha256: AuthoritySealSha256;
  eventLine: string;
  eventBytes: string;
  requestBody: string;
  providerId: string;
}>;

export type PreparedEmail = PreparedGmailEmail | PreparedConsoleEmail;

const OUTBOX_MESSAGE_ID =
  /^<codestead\.outbox\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@mail\.codestead\.invalid>$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const AUTHORITY_BINDING_DOMAIN = "codestead.mail.prepared-authority.v1";
const AUTHORITY_BINDING_VERSION = "prepared-authority-v1";

function assertMailAdapter(value: unknown): asserts value is MailAdapter {
  if (value !== "console" && value !== "gmail") {
    throw new Error("Invalid mail adapter.");
  }
}

function assertEmailTemplate(
  value: unknown,
): asserts value is EmailTemplate {
  if (
    typeof value !== "string"
    || !PRODUCTION_EMAIL_TEMPLATES.some(
      (template) => template === value,
    )
  ) {
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

function assertAuthority(authority: PreparedMailDispatchAuthority) {
  assertBindingText(authority.id, "ID", 200);
  assertBindingText(authority.operationId, "operation ID", 200);
  assertBindingText(authority.claimToken, "claim token", 200);
  assertBindingText(authority.claimOwner, "claim owner", 128);
  assertBindingText(authority.deliveryScopeKey, "delivery scope", 512);
  if (!SHA256_HEX.test(authority.sourceAuthoritySha256)) {
    throw new Error("Invalid mail dispatch source authority SHA-256.");
  }
  const recipient = assertBindingText(
    authority.recipient,
    "recipient",
    320,
  );
  headerValue(recipient, "authoritative recipient");
  assertEmailTemplate(authority.template);
  assertBindingText(authority.templateVersion, "template version", 64);
  if (
    !Number.isSafeInteger(authority.claimVersion)
    || authority.claimVersion <= 0
  ) {
    throw new Error("Invalid mail dispatch claim version.");
  }
  if (!resolveEmailTemplateAuthorityPolicy(
    authority.template,
    authority.templateVersion,
  )) {
    throw new Error("Invalid mail dispatch template version.");
  }
  outboxMessageId(authority.operationId);
}

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: string,
) {
  const byteLength = Buffer.byteLength(value, "utf8");
  hash.update(`${byteLength}:`, "utf8");
  hash.update(value, "utf8");
}

type PreparedWithoutAuthorityBinding =
  | Omit<PreparedGmailEmail, "authorityBindingSha256">
  | Omit<PreparedConsoleEmail, "authorityBindingSha256">;

function payloadBindingSha256(
  prepared:
    | Pick<PreparedGmailEmail, "adapter" | "rfc822">
    | Pick<PreparedConsoleEmail, "adapter" | "eventBytes">,
) {
  const bytes = prepared.adapter === "gmail"
    ? prepared.rfc822
    : prepared.eventBytes;
  return createHash("sha256")
    .update(bytes, "utf8")
    .digest("hex") as ProviderPayloadSha256;
}

function authorityBindingSha256(
  prepared: PreparedWithoutAuthorityBinding,
  authority: PreparedMailDispatchAuthority,
) {
  assertAuthority(authority);
  const hash = createHash("sha256");
  updateLengthFramed(hash, AUTHORITY_BINDING_DOMAIN);
  updateLengthFramed(hash, prepared.authorityBindingVersion);
  updateLengthFramed(hash, prepared.adapter);
  updateLengthFramed(hash, prepared.bindingVersion);
  updateLengthFramed(hash, prepared.bindingSha256);
  updateLengthFramed(hash, authority.id);
  updateLengthFramed(hash, authority.operationId);
  updateLengthFramed(hash, authority.claimToken);
  updateLengthFramed(hash, authority.claimOwner);
  updateLengthFramed(hash, String(authority.claimVersion));
  updateLengthFramed(hash, authority.deliveryScopeKey);
  updateLengthFramed(hash, authority.sourceAuthoritySha256);
  updateLengthFramed(hash, authority.recipient);
  updateLengthFramed(hash, authority.template);
  updateLengthFramed(hash, authority.templateVersion);
  if (prepared.adapter === "gmail") {
    updateLengthFramed(hash, prepared.messageId);
    updateLengthFramed(hash, prepared.rfc822);
    updateLengthFramed(hash, prepared.raw);
    updateLengthFramed(hash, prepared.requestBody);
  } else {
    updateLengthFramed(hash, prepared.eventLine);
    updateLengthFramed(hash, prepared.eventBytes);
    updateLengthFramed(hash, prepared.requestBody);
    updateLengthFramed(hash, prepared.providerId);
  }
  return hash.digest("hex") as AuthoritySealSha256;
}

export function dispatchBinding(prepared: PreparedEmail): DispatchBinding {
  return Object.freeze({
    bindingVersion: prepared.bindingVersion,
    bindingSha256: prepared.bindingSha256,
  });
}

function mimeMessage(
  input: AuthoritativeOutgoingEmail,
  fromHeader: string,
  authoritativeMessageId: string,
) {
  const rendered = renderEmail(input.template, input.variables);
  const boundary = `learncoding-${crypto.randomUUID()}`;
  const from = headerValue(fromHeader, "From");
  const to = headerValue(input.to, "To");
  const subject = headerValue(rendered.subject, "Subject");
  const messageId = gmailCorrelationHeader(authoritativeMessageId);
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
  input: AuthoritativeOutgoingEmail,
  context: MailPreparationContext,
): PreparedEmail {
  assertMailAdapter(context.adapter);
  assertEmailTemplate(input.template);
  headerValue(input.to, "To");
  assertAuthority(context.authority);
  if (input.to !== context.authority.recipient) {
    throw new Error("Mail recipient does not match dispatch authority.");
  }
  if (input.template !== context.authority.template) {
    throw new Error("Mail template does not match dispatch authority.");
  }
  if (input.templateVersion !== context.authority.templateVersion) {
    throw new Error("Mail template version does not match dispatch authority.");
  }
  if (!resolveEmailTemplateAuthorityPolicy(
    input.template,
    input.templateVersion,
  )) {
    throw new Error("Invalid email template version.");
  }
  const messageId = gmailCorrelationHeader(context.messageId);
  const expectedMessageId = outboxMessageId(context.authority.operationId);
  if (messageId !== expectedMessageId) {
    throw new Error("Message-ID does not match mail dispatch authority.");
  }
  assertNoBackupArchive(input);

  if (context.adapter === "console") {
    const eventLine =
      `{"event":"email.console_delivery","template":"${input.template}"}`;
    const eventBytes = `${eventLine}\n`;
    const payload = Object.freeze({
      adapter: "console" as const,
      bindingVersion: "console-json-v1" as const,
      eventLine,
      eventBytes,
      requestBody: eventBytes,
      providerId: `console-${crypto.randomUUID()}`,
    });
    const withoutAuthorityBinding = Object.freeze({
      ...payload,
      bindingSha256: payloadBindingSha256(payload),
      authorityBindingVersion: AUTHORITY_BINDING_VERSION,
    });
    return Object.freeze({
      ...withoutAuthorityBinding,
      authorityBindingSha256: authorityBindingSha256(
        withoutAuthorityBinding,
        context.authority,
      ),
    });
  }

  const rfc822 = mimeMessage(input, context.from, expectedMessageId);
  const raw = Buffer.from(rfc822, "utf8").toString("base64url");
  const requestBody = `{"raw":"${raw}"}`;
  const payload = Object.freeze({
    adapter: "gmail" as const,
    bindingVersion: "gmail-raw-v1" as const,
    messageId: expectedMessageId,
    rfc822,
    raw,
    requestBody,
  });
  const withoutAuthorityBinding = Object.freeze({
    ...payload,
    bindingSha256: payloadBindingSha256(payload),
    authorityBindingVersion: AUTHORITY_BINDING_VERSION,
  });
  return Object.freeze({
    ...withoutAuthorityBinding,
    authorityBindingSha256: authorityBindingSha256(
      withoutAuthorityBinding,
      context.authority,
    ),
  });
}

export function preparedEmailBindingMatches(
  prepared: PreparedEmail,
  authority: PreparedMailDispatchAuthority,
) {
  try {
    if (
      !SHA256_HEX.test(prepared.bindingSha256)
      || !SHA256_HEX.test(prepared.authorityBindingSha256)
      || prepared.authorityBindingVersion !== AUTHORITY_BINDING_VERSION
    ) {
      return false;
    }
    assertAuthority(authority);
    if (prepared.adapter === "gmail") {
      if (
        prepared.bindingVersion !== "gmail-raw-v1"
        || prepared.messageId !== outboxMessageId(authority.operationId)
        || prepared.raw
          !== Buffer.from(prepared.rfc822, "utf8").toString("base64url")
        || prepared.requestBody !== `{"raw":"${prepared.raw}"}`
        || prepared.bindingSha256 !== payloadBindingSha256(prepared)
      ) {
        return false;
      }
      const withoutAuthorityBinding = {
        adapter: prepared.adapter,
        bindingVersion: prepared.bindingVersion,
        bindingSha256: prepared.bindingSha256,
        authorityBindingVersion: prepared.authorityBindingVersion,
        messageId: prepared.messageId,
        rfc822: prepared.rfc822,
        raw: prepared.raw,
        requestBody: prepared.requestBody,
      };
      return authorityBindingSha256(
        withoutAuthorityBinding,
        authority,
      ) === prepared.authorityBindingSha256;
    }

    if (
      prepared.bindingVersion !== "console-json-v1"
      || /[\r\n]/.test(prepared.eventLine)
      || prepared.eventBytes !== `${prepared.eventLine}\n`
      || prepared.requestBody !== prepared.eventBytes
      || prepared.bindingSha256 !== payloadBindingSha256(prepared)
    ) {
      return false;
    }
    const withoutAuthorityBinding = {
        adapter: prepared.adapter,
        bindingVersion: prepared.bindingVersion,
        bindingSha256: prepared.bindingSha256,
        authorityBindingVersion: prepared.authorityBindingVersion,
        eventLine: prepared.eventLine,
        eventBytes: prepared.eventBytes,
        requestBody: prepared.requestBody,
        providerId: prepared.providerId,
    };
    return authorityBindingSha256(
      withoutAuthorityBinding,
      authority,
    ) === prepared.authorityBindingSha256;
  } catch {
    return false;
  }
}
