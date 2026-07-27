import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  dispatchEvidenceSha256,
  PROVIDER_EVIDENCE_VERSION,
  type ProviderDispatchTuple,
} from "./dispatch-evidence";
import type { EmailTemplate } from "./outbox";
import {
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
  outboxCorrelationToken,
  outboxMessageId,
} from "./provider-correlation";
import { renderEmail } from "./templates";

export interface OutgoingEmail {
  to: string;
  template: EmailTemplate;
  variables: Record<string, string>;
}

export type MailAdapter = "console" | "gmail";

export interface MailProviderContext {
  operationId: string;
  messageId: string;
}

export type PreparedGmailEmail = Readonly<{
  adapter: "gmail";
  operationId: string;
  messageId: string;
  rfc822: string;
  raw: string;
  requestBody: string;
  requestBodySha256: string;
  requestBodyLength: number;
  evidenceToken: string;
  requestTimeoutMs: number;
  providerDispatch: Extract<ProviderDispatchTuple, { adapter: "gmail" }>;
}>;

export type PreparedConsoleEmail = Readonly<{
  adapter: "console";
  operationId: string;
  messageId: string;
  template: EmailTemplate;
  eventLine: string;
  eventBytes: string;
  requestBody: string;
  requestBodySha256: string;
  requestBodyLength: number;
  providerId: string;
  providerDispatch: Extract<ProviderDispatchTuple, { adapter: "console" }>;
}>;

export type PreparedEmail = PreparedGmailEmail | PreparedConsoleEmail;

export type MailDeliveryFailure = Readonly<{
  kind: "definitely-rejected" | "ambiguous";
  code: string;
}>;

export class MailDeliveryError extends Error {
  constructor(
    message: string,
    readonly failure: MailDeliveryFailure,
  ) {
    super(message);
    this.name = "MailDeliveryError";
  }
}

export function classifyMailDeliveryError(error: unknown): MailDeliveryFailure {
  return error instanceof MailDeliveryError
    ? error.failure
    : { kind: "ambiguous", code: "PROVIDER_OUTCOME_AMBIGUOUS" };
}

function deliveryError(error: unknown, failure: MailDeliveryFailure) {
  if (error instanceof MailDeliveryError) return error;
  const message =
    error instanceof Error ? error.message : "Mail delivery failed.";
  return new MailDeliveryError(message, failure);
}

const DEFAULT_GMAIL_REQUEST_TIMEOUT_MS = 10_000;
const MIN_GMAIL_REQUEST_TIMEOUT_MS = 1_000;
const MAX_GMAIL_REQUEST_TIMEOUT_MS = 25_000;

function gmailRequestTimeoutMs() {
  const configured = process.env.GMAIL_REQUEST_TIMEOUT_MS?.trim();
  if (!configured) return DEFAULT_GMAIL_REQUEST_TIMEOUT_MS;
  const value = Number(configured);
  if (
    !/^[0-9]+$/.test(configured) ||
    !Number.isSafeInteger(value) ||
    value < MIN_GMAIL_REQUEST_TIMEOUT_MS ||
    value > MAX_GMAIL_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      "GMAIL_REQUEST_TIMEOUT_MS must be an integer from 1000 to 25000.",
    );
  }
  return value;
}

function headerValue(value: string, name: string) {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${name} header.`);
  }
  return value;
}

function exactMessageId(context: MailProviderContext) {
  if (
    !context ||
    typeof context.operationId !== "string" ||
    typeof context.messageId !== "string"
  ) {
    throw new Error("Invalid Message-ID header.");
  }
  const expected = outboxMessageId(context.operationId);
  const supplied = headerValue(context.messageId, "Message-ID");
  if (supplied !== expected) {
    throw new Error("Invalid Message-ID header.");
  }
  return expected;
}

function assertNoBackupArchive(input: OutgoingEmail) {
  if (
    input.template === "backup-status" &&
    /archive|\.sql|\.tar|\.zip/i.test(input.variables.url ?? "")
  ) {
    throw new Error("Backup archives may not be emailed.");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mimeMessage(
  input: OutgoingEmail,
  messageId: string,
  evidenceToken: string,
) {
  const rendered = renderEmail(input.template, input.variables);
  const boundary = `learncoding-${randomUUID()}`;
  const from = headerValue(
    process.env.MAIL_FROM ?? "Codestead <noreply@example.com>",
    "From",
  );
  const to = headerValue(input.to, "To");
  const subject = headerValue(rendered.subject, "Subject");
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `X-Codestead-Dispatch-Evidence: v1.${evidenceToken}`,
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

function gmailProviderDispatch(
  operationId: string,
  dispatchBindingSha256: string,
  evidenceToken: string,
) {
  return Object.freeze({
    adapter: "gmail" as const,
    dispatchBindingVersion: "gmail-raw-v1" as const,
    dispatchBindingSha256,
    providerCorrelationVersion: OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
    providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
    providerEvidenceSha256: dispatchEvidenceSha256({
      operationId,
      providerCorrelationVersion: OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
      providerCorrelationToken: outboxCorrelationToken(operationId),
      dispatchBindingVersion: "gmail-raw-v1",
      adapterPayloadSha256: dispatchBindingSha256,
      providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
      evidenceToken,
    }),
  });
}

export function prepareEmail(
  input: OutgoingEmail,
  context: MailProviderContext & Readonly<{ adapter: MailAdapter }>,
): PreparedEmail {
  try {
    assertNoBackupArchive(input);
    const messageId = exactMessageId(context);
    if (context.adapter === "console") {
      const eventLine = JSON.stringify({
        event: "email.console_delivery",
        template: input.template,
      });
      const eventBytes = `${eventLine}\n`;
      const requestBody = eventBytes;
      const requestBodySha256 = sha256(requestBody);
      const requestBodyLength = Buffer.byteLength(requestBody, "utf8");
      const providerDispatch = Object.freeze({
        adapter: "console" as const,
        dispatchBindingVersion: "console-json-v1" as const,
        dispatchBindingSha256: sha256(eventBytes),
        providerCorrelationVersion: OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
        providerEvidenceVersion: null,
        providerEvidenceSha256: null,
      });
      return Object.freeze({
        adapter: "console" as const,
        operationId: context.operationId,
        messageId,
        template: input.template,
        eventLine,
        eventBytes,
        requestBody,
        requestBodySha256,
        requestBodyLength,
        providerId: `console-${randomUUID()}`,
        providerDispatch,
      });
    }
    if (context.adapter !== "gmail") {
      throw new Error("MAIL_ADAPTER must be either console or gmail.");
    }
    const requestTimeoutMs = gmailRequestTimeoutMs();
    const evidenceToken = randomBytes(32).toString("base64url");
    const rfc822 = mimeMessage(input, messageId, evidenceToken);
    const raw = Buffer.from(rfc822, "utf8").toString("base64url");
    const requestBody = JSON.stringify({ raw });
    const dispatchBindingSha256 = sha256(rfc822);
    const requestBodySha256 = sha256(requestBody);
    const requestBodyLength = Buffer.byteLength(requestBody, "utf8");
    return Object.freeze({
      adapter: "gmail" as const,
      operationId: context.operationId,
      messageId,
      rfc822,
      raw,
      requestBody,
      requestBodySha256,
      requestBodyLength,
      evidenceToken,
      requestTimeoutMs,
      providerDispatch: gmailProviderDispatch(
        context.operationId,
        dispatchBindingSha256,
        evidenceToken,
      ),
    });
  } catch (error) {
    throw deliveryError(error, {
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
  }
}
