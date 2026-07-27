import { createHash, randomBytes } from "node:crypto";

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

export type AuthoritativeOutgoingEmail = OutgoingEmail &
  Readonly<{
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

export type MailDispatchAuthority = DispatchAuthority<SourceAuthoritySha256>;
export type CompatibilityMailDispatchAuthority =
  DispatchAuthority<CompatibilitySourceAuthoritySha256>;
export type PreparedMailDispatchAuthority =
  MailDispatchAuthority | CompatibilityMailDispatchAuthority;

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

export type ProviderPayloadSha256 = string &
  Readonly<{
    [providerPayloadSha256Brand]: "ProviderPayloadSha256";
  }>;

export type AuthoritySealSha256 = string &
  Readonly<{
    [authoritySealSha256Brand]: "AuthoritySealSha256";
  }>;

export type SourceAuthoritySha256 = string &
  Readonly<{
    [sourceAuthoritySha256Brand]: "SourceAuthoritySha256";
  }>;

export type CompatibilitySourceAuthoritySha256 = string &
  Readonly<{
    [compatibilitySourceAuthoritySha256Brand]: "CompatibilitySourceAuthoritySha256";
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
  requestBodySha256: string;
  requestBodyLength: number;
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
  requestBodySha256: string;
  requestBodyLength: number;
  providerId: string;
}>;

export type PreparedEmail = PreparedGmailEmail | PreparedConsoleEmail;

declare const materializedGmailPreparationBrand: unique symbol;

export type MaterializedGmailPreparation = Readonly<{
  [materializedGmailPreparationBrand]: "MaterializedGmailPreparation";
}>;

const MATERIALIZED_GMAIL_PREPARATIONS = new WeakMap<
  MaterializedGmailPreparation,
  PreparedGmailEmail
>();

const OUTBOX_MESSAGE_ID =
  /^<codestead\.outbox\.v1\.[A-Za-z0-9_-]{43}@mail\.codestead\.invalid>$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DISPATCH_EVIDENCE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const AUTHORITY_BINDING_DOMAIN = "codestead.mail.prepared-authority.v1";
const AUTHORITY_BINDING_VERSION = "prepared-authority-v1";

function assertMailAdapter(value: unknown): asserts value is MailAdapter {
  if (value !== "console" && value !== "gmail") {
    throw new Error("Invalid mail adapter.");
  }
}

function assertEmailTemplate(value: unknown): asserts value is EmailTemplate {
  if (
    typeof value !== "string" ||
    !PRODUCTION_EMAIL_TEMPLATES.some((template) => template === value)
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
function dispatchEvidenceHeader(token: unknown) {
  if (typeof token !== "string" || !DISPATCH_EVIDENCE_TOKEN.test(token)) {
    throw new Error("Invalid dispatch evidence token.");
  }
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== token) {
    throw new Error("Invalid dispatch evidence token.");
  }
  return `X-Codestead-Dispatch-Evidence: v1.${token}`;
}

function hasCanonicalDispatchEvidenceHeader(rfc822: string) {
  const separator = rfc822.indexOf("\r\n\r\n");
  if (separator < 0) return false;
  const evidenceHeaders = rfc822
    .slice(0, separator)
    .split("\r\n")
    .filter((line) => /^x-codestead-dispatch-evidence:/iu.test(line));
  return (
    evidenceHeaders.length === 1 &&
    /^X-Codestead-Dispatch-Evidence: v1\.[A-Za-z0-9_-]{43}$/u.test(
      evidenceHeaders[0]!,
    )
  );
}

function assertBindingText(value: string, name: string, maximumLength: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximumLength ||
    /[\u0000]/.test(value)
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
  const recipient = assertBindingText(authority.recipient, "recipient", 320);
  headerValue(recipient, "authoritative recipient");
  assertEmailTemplate(authority.template);
  assertBindingText(authority.templateVersion, "template version", 64);
  if (
    !Number.isSafeInteger(authority.claimVersion) ||
    authority.claimVersion <= 0
  ) {
    throw new Error("Invalid mail dispatch claim version.");
  }
  if (
    !resolveEmailTemplateAuthorityPolicy(
      authority.template,
      authority.templateVersion,
    )
  ) {
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
  const bytes =
    prepared.adapter === "gmail" ? prepared.rfc822 : prepared.eventBytes;
  return createHash("sha256")
    .update(bytes, "utf8")
    .digest("hex") as ProviderPayloadSha256;
}

function requestBodyBinding(requestBody: string) {
  return Object.freeze({
    requestBodySha256: createHash("sha256")
      .update(requestBody, "utf8")
      .digest("hex"),
    requestBodyLength: Buffer.byteLength(requestBody, "utf8"),
  });
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
    updateLengthFramed(hash, prepared.requestBodySha256);
    updateLengthFramed(hash, String(prepared.requestBodyLength));
  } else {
    updateLengthFramed(hash, prepared.eventLine);
    updateLengthFramed(hash, prepared.eventBytes);
    updateLengthFramed(hash, prepared.requestBody);
    updateLengthFramed(hash, prepared.requestBodySha256);
    updateLengthFramed(hash, String(prepared.requestBodyLength));
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
  dispatchEvidenceToken: string,
) {
  const rendered = renderEmail(input.template, input.variables);
  const boundary = `learncoding-${crypto.randomUUID()}`;
  const from = headerValue(fromHeader, "From");
  const to = headerValue(input.to, "To");
  const subject = headerValue(rendered.subject, "Subject");
  const messageId = gmailCorrelationHeader(authoritativeMessageId);
  const evidenceHeader = dispatchEvidenceHeader(dispatchEvidenceToken);
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    evidenceHeader,
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
    input.template === "backup-status" &&
    /archive|\.sql|\.tar|\.zip/i.test(input.variables.url ?? "")
  ) {
    throw new Error("Backup archives may not be emailed.");
  }
}

function prepareEmailInternal(
  input: AuthoritativeOutgoingEmail,
  context: MailPreparationContext,
  dispatchEvidenceToken?: string,
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
  if (
    !resolveEmailTemplateAuthorityPolicy(input.template, input.templateVersion)
  ) {
    throw new Error("Invalid email template version.");
  }
  const messageId = gmailCorrelationHeader(context.messageId);
  const expectedMessageId = outboxMessageId(context.authority.operationId);
  if (messageId !== expectedMessageId) {
    throw new Error("Message-ID does not match mail dispatch authority.");
  }
  assertNoBackupArchive(input);

  if (context.adapter === "console") {
    if (dispatchEvidenceToken !== undefined) {
      throw new Error("Console dispatch evidence token is not permitted.");
    }
    const eventLine = `{"event":"email.console_delivery","template":"${input.template}"}`;
    const eventBytes = `${eventLine}\n`;
    const requestBody = eventBytes;
    const payload = Object.freeze({
      adapter: "console" as const,
      bindingVersion: "console-json-v1" as const,
      eventLine,
      eventBytes,
      requestBody,
      ...requestBodyBinding(requestBody),
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

  const rfc822 = mimeMessage(
    input,
    context.from,
    expectedMessageId,
    dispatchEvidenceToken ?? "",
  );
  const raw = Buffer.from(rfc822, "utf8").toString("base64url");
  const requestBody = `{"raw":"${raw}"}`;
  const payload = Object.freeze({
    adapter: "gmail" as const,
    bindingVersion: "gmail-raw-v1" as const,
    messageId: expectedMessageId,
    rfc822,
    raw,
    requestBody,
    ...requestBodyBinding(requestBody),
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

export function prepareEmail(
  input: AuthoritativeOutgoingEmail,
  context: MailPreparationContext,
): PreparedEmail {
  assertMailAdapter(context.adapter);
  if (context.adapter === "gmail") {
    throw new Error("Gmail preparation requires trusted materialization.");
  }
  return prepareEmailInternal(input, context);
}

/**
 * Issues a one-shot, empty preparation capability. The evidence token and
 * constructor stay module-local; a production import inventory restricts the
 * issue/consume pair to the trusted materializer.
 */
export function issueMaterializedGmailPreparation(
  input: AuthoritativeOutgoingEmail,
  context: MailPreparationContext & Readonly<{ adapter: "gmail" }>,
): MaterializedGmailPreparation {
  const evidenceToken = randomBytes(32).toString("base64url");
  const prepared = prepareEmailInternal(
    input,
    context,
    evidenceToken,
  ) as PreparedGmailEmail;
  const capability = Object.freeze({}) as MaterializedGmailPreparation;
  MATERIALIZED_GMAIL_PREPARATIONS.set(capability, prepared);
  return capability;
}

export function consumeMaterializedGmailPreparation(
  capability: MaterializedGmailPreparation,
): PreparedGmailEmail | null {
  if (
    !capability ||
    (typeof capability !== "object" && typeof capability !== "function") ||
    !Object.isFrozen(capability)
  )
    return null;
  const prepared = MATERIALIZED_GMAIL_PREPARATIONS.get(capability) ?? null;
  MATERIALIZED_GMAIL_PREPARATIONS.delete(capability);
  return prepared;
}
export function preparedEmailBindingMatches(
  prepared: PreparedEmail,
  authority: PreparedMailDispatchAuthority,
) {
  try {
    if (
      !SHA256_HEX.test(prepared.requestBodySha256) ||
      !Number.isSafeInteger(prepared.requestBodyLength) ||
      prepared.requestBodyLength < 0 ||
      requestBodyBinding(prepared.requestBody).requestBodySha256 !==
        prepared.requestBodySha256 ||
      Buffer.byteLength(prepared.requestBody, "utf8") !==
        prepared.requestBodyLength ||
      !SHA256_HEX.test(prepared.bindingSha256) ||
      !SHA256_HEX.test(prepared.authorityBindingSha256) ||
      prepared.authorityBindingVersion !== AUTHORITY_BINDING_VERSION
    ) {
      return false;
    }
    assertAuthority(authority);
    if (prepared.adapter === "gmail") {
      if (
        prepared.bindingVersion !== "gmail-raw-v1" ||
        prepared.messageId !== outboxMessageId(authority.operationId) ||
        !hasCanonicalDispatchEvidenceHeader(prepared.rfc822) ||
        prepared.raw !==
          Buffer.from(prepared.rfc822, "utf8").toString("base64url") ||
        prepared.requestBody !== `{"raw":"${prepared.raw}"}` ||
        prepared.bindingSha256 !== payloadBindingSha256(prepared)
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
        requestBodySha256: prepared.requestBodySha256,
        requestBodyLength: prepared.requestBodyLength,
      };
      return (
        authorityBindingSha256(withoutAuthorityBinding, authority) ===
        prepared.authorityBindingSha256
      );
    }

    if (
      prepared.bindingVersion !== "console-json-v1" ||
      /[\r\n]/.test(prepared.eventLine) ||
      prepared.eventBytes !== `${prepared.eventLine}\n` ||
      prepared.requestBody !== prepared.eventBytes ||
      prepared.bindingSha256 !== payloadBindingSha256(prepared)
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
      requestBodySha256: prepared.requestBodySha256,
      requestBodyLength: prepared.requestBodyLength,
      providerId: prepared.providerId,
    };
    return (
      authorityBindingSha256(withoutAuthorityBinding, authority) ===
      prepared.authorityBindingSha256
    );
  } catch {
    return false;
  }
}
