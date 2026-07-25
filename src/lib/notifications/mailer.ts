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

function deliveryError(
  error: unknown,
  failure: MailDeliveryFailure,
) {
  if (error instanceof MailDeliveryError) return error;
  const message = error instanceof Error
    ? error.message
    : "Mail delivery failed.";
  return new MailDeliveryError(message, failure);
}

const DEFAULT_GMAIL_REQUEST_TIMEOUT_MS = 10_000;
const MIN_GMAIL_REQUEST_TIMEOUT_MS = 1_000;
const MAX_GMAIL_REQUEST_TIMEOUT_MS = 25_000;
const EVIDENCE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function gmailRequestTimeoutMs() {
  const configured = process.env.GMAIL_REQUEST_TIMEOUT_MS?.trim();
  if (!configured) return DEFAULT_GMAIL_REQUEST_TIMEOUT_MS;
  const value = Number(configured);
  if (
    !/^[0-9]+$/.test(configured)
    || !Number.isSafeInteger(value)
    || value < MIN_GMAIL_REQUEST_TIMEOUT_MS
    || value > MAX_GMAIL_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      "GMAIL_REQUEST_TIMEOUT_MS must be an integer from 1000 to 25000.",
    );
  }
  return value;
}

async function withGmailRequestDeadline<T>(
  stage: "OAuth" | "delivery",
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Gmail ${stage} request timed out.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function headerValue(value: string, name: string) {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${name} header.`);
  }
  return value;
}

function configuredAdapter(): MailAdapter {
  const adapter = process.env.MAIL_ADAPTER ?? "console";
  if (adapter !== "console" && adapter !== "gmail") {
    throw new Error("MAIL_ADAPTER must be either console or gmail.");
  }
  return adapter;
}

function exactMessageId(context: MailProviderContext) {
  if (
    !context
    || typeof context.operationId !== "string"
    || typeof context.messageId !== "string"
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
    input.template === "backup-status"
    && /archive|\.sql|\.tar|\.zip/i.test(input.variables.url ?? "")
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
    providerCorrelationVersion:
      OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
    providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
    providerEvidenceSha256: dispatchEvidenceSha256({
      operationId,
      providerCorrelationVersion:
        OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
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
      const providerDispatch = Object.freeze({
        adapter: "console" as const,
        dispatchBindingVersion: "console-json-v1" as const,
        dispatchBindingSha256: sha256(eventBytes),
        providerCorrelationVersion:
          OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
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
    return Object.freeze({
      adapter: "gmail" as const,
      operationId: context.operationId,
      messageId,
      rfc822,
      raw,
      requestBody,
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

function exactEvidenceHeader(prepared: PreparedGmailEmail) {
  if (
    !EVIDENCE_TOKEN.test(prepared.evidenceToken)
    || Buffer.from(prepared.evidenceToken, "base64url").length !== 32
  ) return false;
  const header =
    `X-Codestead-Dispatch-Evidence: v1.${prepared.evidenceToken}`;
  const headers = prepared.rfc822.split("\r\n")
    .filter((line) => line.toLowerCase().startsWith(
      "x-codestead-dispatch-evidence:",
    ));
  return headers.length === 1 && headers[0] === header;
}

function validPreparedEmail(prepared: PreparedEmail) {
  if (
    !Object.isFrozen(prepared)
    || !Object.isFrozen(prepared.providerDispatch)
  ) return false;
  let expectedMessageId: string;
  try {
    expectedMessageId = outboxMessageId(prepared.operationId);
  } catch {
    return false;
  }
  if (
    prepared.messageId !== expectedMessageId
    || prepared.providerDispatch.adapter !== prepared.adapter
    || prepared.providerDispatch.providerCorrelationVersion
      !== OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION
    || !SHA256_HEX.test(prepared.providerDispatch.dispatchBindingSha256)
  ) return false;

  if (prepared.adapter === "console") {
    const expectedLine = JSON.stringify({
      event: "email.console_delivery",
      template: prepared.template,
    });
    return (
      prepared.eventLine === expectedLine
      && prepared.eventBytes === `${expectedLine}\n`
      && prepared.providerDispatch.dispatchBindingVersion
        === "console-json-v1"
      && prepared.providerDispatch.dispatchBindingSha256
        === sha256(prepared.eventBytes)
      && prepared.providerDispatch.providerEvidenceVersion === null
      && prepared.providerDispatch.providerEvidenceSha256 === null
      && /^console-[0-9a-f-]{36}$/i.test(prepared.providerId)
    );
  }

  const dispatchBindingSha256 = sha256(prepared.rfc822);
  if (
    prepared.raw
      !== Buffer.from(prepared.rfc822, "utf8").toString("base64url")
    || prepared.requestBody !== JSON.stringify({ raw: prepared.raw })
    || prepared.providerDispatch.dispatchBindingVersion !== "gmail-raw-v1"
    || prepared.providerDispatch.dispatchBindingSha256
      !== dispatchBindingSha256
    || prepared.providerDispatch.providerEvidenceVersion
      !== PROVIDER_EVIDENCE_VERSION
    || !exactEvidenceHeader(prepared)
    || prepared.requestTimeoutMs < MIN_GMAIL_REQUEST_TIMEOUT_MS
    || prepared.requestTimeoutMs > MAX_GMAIL_REQUEST_TIMEOUT_MS
  ) return false;
  try {
    return prepared.providerDispatch.providerEvidenceSha256
      === dispatchEvidenceSha256({
        operationId: prepared.operationId,
        providerCorrelationVersion:
          OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
        providerCorrelationToken:
          outboxCorrelationToken(prepared.operationId),
        dispatchBindingVersion: "gmail-raw-v1",
        adapterPayloadSha256: dispatchBindingSha256,
        providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
        evidenceToken: prepared.evidenceToken,
      });
  } catch {
    return false;
  }
}

async function gmailAccessToken(timeoutMs: number) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Gmail OAuth is not configured.");
  }
  return withGmailRequestDeadline("OAuth", timeoutMs, async (signal) => {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(`Gmail token exchange failed (${response.status}).`);
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error("Gmail token exchange returned no access token.");
    }
    return body.access_token;
  });
}

export async function sendPreparedEmail(prepared: PreparedEmail) {
  if (!validPreparedEmail(prepared)) {
    throw new MailDeliveryError(
      "Prepared mail payload does not match its dispatch evidence.",
      { kind: "definitely-rejected", code: "PAYLOAD_DIGEST_MISMATCH" },
    );
  }
  if (prepared.adapter === "console") {
    process.stdout.write(prepared.eventBytes);
    return { providerId: prepared.providerId };
  }

  let accessToken: string;
  try {
    accessToken = await gmailAccessToken(prepared.requestTimeoutMs);
  } catch (error) {
    throw deliveryError(error, {
      kind: "definitely-rejected",
      code: "GMAIL_OAUTH_FAILED",
    });
  }

  try {
    return await withGmailRequestDeadline(
      "delivery",
      prepared.requestTimeoutMs,
      async (signal) => {
        const response = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: prepared.requestBody,
            cache: "no-store",
            signal,
          },
        );
        if (!response.ok) {
          const error = new Error(
            `Gmail delivery failed (${response.status}).`,
          );
          if (
            [400, 401, 403, 404, 405, 410, 413, 415, 422]
              .includes(response.status)
          ) {
            throw new MailDeliveryError(
              error.message,
              {
                kind: "definitely-rejected",
                code: "GMAIL_DELIVERY_REJECTED",
              },
            );
          }
          throw error;
        }
        const body = (await response.json()) as { id?: string };
        const providerId = body.id?.trim();
        if (!providerId) {
          throw new Error("Gmail delivery returned no message ID.");
        }
        return { providerId };
      },
    );
  } catch (error) {
    throw deliveryError(error, {
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  }
}

export async function sendEmail(
  input: OutgoingEmail,
  context: MailProviderContext,
) {
  let adapter: MailAdapter;
  try {
    adapter = configuredAdapter();
  } catch (error) {
    throw deliveryError(error, {
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
  }
  const prepared = prepareEmail(input, { ...context, adapter });
  return sendPreparedEmail(prepared);
}
