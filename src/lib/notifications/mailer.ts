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
  const message = error instanceof Error ? error.message : "Mail delivery failed.";
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
  stage: "OAuth" | "delivery" | "reconciliation",
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
  if (!value || /[\r\n]/.test(value)) throw new Error(`Invalid ${name} header.`);
  return value;
}

const OUTBOX_MESSAGE_ID =
  /^<codestead\.outbox\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@mail\.codestead\.invalid>$/i;

function gmailCorrelation(messageId: string) {
  const header = headerValue(messageId, "Message-ID");
  if (!OUTBOX_MESSAGE_ID.test(header)) {
    throw new Error("Invalid Message-ID header.");
  }
  return {
    header,
  };
}

async function gmailAccessToken(timeoutMs: number) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Gmail OAuth is not configured.");
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
    if (!response.ok) throw new Error(`Gmail token exchange failed (${response.status}).`);
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) throw new Error("Gmail token exchange returned no access token.");
    return body.access_token;
  });
}

function mimeMessage(input: OutgoingEmail, context: MailProviderContext) {
  const rendered = renderEmail(input.template, input.variables);
  const boundary = `learncoding-${crypto.randomUUID()}`;
  const from = headerValue(process.env.MAIL_FROM ?? "Codestead <noreply@example.com>", "From");
  const to = headerValue(input.to, "To");
  const subject = headerValue(rendered.subject, "Subject");
  const messageId = gmailCorrelation(context?.messageId ?? "").header;
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

export async function findGmailMessageByMessageId(messageId: string) {
  const correlation = gmailCorrelation(messageId);
  const requestTimeoutMs = gmailRequestTimeoutMs();
  const accessToken = await gmailAccessToken(requestTimeoutMs);
  const listUrl = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  );
  listUrl.searchParams.set("maxResults", "2");
  listUrl.searchParams.set("q", `rfc822msgid:${correlation.header}`);
  listUrl.searchParams.append("labelIds", "SENT");
  const listBody = await withGmailRequestDeadline(
    "reconciliation",
    requestTimeoutMs,
    async (signal) => {
      const response = await fetch(listUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        throw new Error(`Gmail reconciliation search failed (${response.status}).`);
      }
      return response.json() as Promise<unknown>;
    },
  );
  if (
    typeof listBody !== "object"
    || listBody === null
    || Array.isArray(listBody)
  ) {
    return { kind: "ambiguous" as const };
  }
  const listRecord = listBody as Record<string, unknown>;
  const rawMessages = listRecord.messages;
  if (
    (rawMessages !== undefined && !Array.isArray(rawMessages))
    || listRecord.nextPageToken !== undefined
  ) {
    return { kind: "ambiguous" as const };
  }
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  if (messages.some((message) => (
    typeof message !== "object"
    || message === null
    || typeof (message as { id?: unknown }).id !== "string"
  ))) {
    return { kind: "ambiguous" as const };
  }
  const providerIds = messages
    .map((message) => (message as { id: string }).id.trim())
    .filter(Boolean);
  if (messages.length === 0) return { kind: "not-found" as const };
  if (
    providerIds.length !== 1
    || providerIds.length !== messages.length
  ) {
    return { kind: "ambiguous" as const };
  }

  const providerMessageId = providerIds[0]!;
  const metadataUrl = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(providerMessageId)}`,
  );
  metadataUrl.searchParams.set("format", "metadata");
  metadataUrl.searchParams.append("metadataHeaders", "Message-ID");
  const metadata = await withGmailRequestDeadline(
    "reconciliation",
    requestTimeoutMs,
    async (signal) => {
      const response = await fetch(metadataUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        throw new Error(`Gmail reconciliation verification failed (${response.status}).`);
      }
      return response.json() as Promise<unknown>;
    },
  );
  if (
    typeof metadata !== "object"
    || metadata === null
    || Array.isArray(metadata)
  ) {
    return { kind: "ambiguous" as const };
  }
  const metadataRecord = metadata as Record<string, unknown>;
  const rawLabelIds = metadataRecord.labelIds;
  const rawPayload = metadataRecord.payload;
  if (
    !Array.isArray(rawLabelIds)
    || rawLabelIds.some((label) => typeof label !== "string")
    || typeof rawPayload !== "object"
    || rawPayload === null
    || Array.isArray(rawPayload)
  ) {
    return { kind: "ambiguous" as const };
  }
  const rawHeaders = (rawPayload as Record<string, unknown>).headers;
  if (!Array.isArray(rawHeaders)) {
    return { kind: "ambiguous" as const };
  }
  const messageIdHeaders = rawHeaders
    .filter((header): header is Record<string, unknown> => (
      typeof header === "object"
      && header !== null
      && !Array.isArray(header)
    ))
    .filter(({ name }) => (
      typeof name === "string"
      && name.toLowerCase() === "message-id"
    ))
    .map(({ value }) => (typeof value === "string" ? value.trim() : ""));
  if (
    typeof metadataRecord.id !== "string"
    || metadataRecord.id.trim() !== providerMessageId
    || messageIdHeaders.length !== 1
    || !rawLabelIds.includes("SENT")
    || messageIdHeaders[0] !== correlation.header
  ) {
    return { kind: "ambiguous" as const };
  }
  return { kind: "matched" as const, providerMessageId };
}
export async function sendEmail(
  input: OutgoingEmail,
  context: MailProviderContext,
) {
  if (input.template === "backup-status" && /archive|\.sql|\.tar|\.zip/i.test(input.variables.url ?? "")) {
    throw new MailDeliveryError(
      "Backup archives may not be emailed.",
      { kind: "definitely-rejected", code: "MAIL_PRE_SEND_REJECTED" },
    );
  }
  const adapter = process.env.MAIL_ADAPTER ?? "console";
  if (adapter === "console") {
    // Deliberately exclude recipient and variables: activation/reset URLs contain bearer tokens.
    console.info(JSON.stringify({ event: "email.console_delivery", template: input.template }));
    return { providerId: `console-${crypto.randomUUID()}` };
  }
  if (adapter !== "gmail") {
    throw new MailDeliveryError(
      "MAIL_ADAPTER must be either console or gmail.",
      { kind: "definitely-rejected", code: "MAIL_PRE_SEND_REJECTED" },
    );
  }
  let requestTimeoutMs: number;
  let raw: string;
  try {
    requestTimeoutMs = gmailRequestTimeoutMs();
    raw = Buffer.from(mimeMessage(input, context), "utf8").toString("base64url");
  } catch (error) {
    throw deliveryError(error, {
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
  }

  let accessToken: string;
  try {
    accessToken = await gmailAccessToken(requestTimeoutMs);
  } catch (error) {
    throw deliveryError(error, {
      kind: "definitely-rejected",
      code: "GMAIL_OAUTH_FAILED",
    });
  }

  try {
    return await withGmailRequestDeadline("delivery", requestTimeoutMs, async (signal) => {
      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ raw }),
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        const error = new Error(`Gmail delivery failed (${response.status}).`);
        if ([400, 401, 403, 404, 405, 410, 413, 415, 422].includes(response.status)) {
          throw new MailDeliveryError(
            error.message,
            { kind: "definitely-rejected", code: "GMAIL_DELIVERY_REJECTED" },
          );
        }
        throw error;
      }
      const body = (await response.json()) as { id?: string };
      const providerId = body.id?.trim();
      if (!providerId) throw new Error("Gmail delivery returned no message ID.");
      return { providerId };
    });
  } catch (error) {
    throw deliveryError(error, {
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  }
}
