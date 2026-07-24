import {
  gmailCorrelationHeader,
  prepareEmail,
  preparedEmailBindingMatches,
  type MailAdapter,
  type MailDispatchAuthority,
  type MailProviderContext,
  type OutgoingEmail,
  type PreparedEmail,
} from "./prepared-dispatch";

export {
  prepareEmail,
  preparedEmailBindingMatches,
} from "./prepared-dispatch";
export type {
  MailAdapter,
  MailDispatchAuthority,
  MailPreparationContext,
  MailProviderContext,
  OutgoingEmail,
  PreparedConsoleEmail,
  PreparedEmail,
  PreparedGmailEmail,
} from "./prepared-dispatch";
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
const GMAIL_ABORT_SETTLEMENT_RESERVE_MS = 5_000;
const MAX_GMAIL_DELIVERY_REQUEST_TIMEOUT_MS =
  MAX_GMAIL_REQUEST_TIMEOUT_MS - GMAIL_ABORT_SETTLEMENT_RESERVE_MS;

class GmailAbortSettlementError extends Error {
  constructor(stage: "OAuth" | "delivery" | "reconciliation") {
    super(`Gmail ${stage} request did not settle after abort.`);
    this.name = "GmailAbortSettlementError";
  }
}

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
  externalSignal?: AbortSignal,
) {
  const controller = new AbortController();
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  let terminationError: Error | undefined;
  const timeoutError = new Error(`Gmail ${stage} request timed out.`);
  const externalAbortError = new Error(`Gmail ${stage} request aborted.`);
  let rejectTermination!: (error: Error) => void;
  const termination = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const terminate = (error: Error) => {
    if (terminationError) return;
    terminationError = error;
    controller.abort();
    rejectTermination(error);
  };
  const onExternalAbort = () => terminate(externalAbortError);
  if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  if (externalSignal?.aborted) onExternalAbort();

  const operationPromise = Promise.resolve().then(() =>
    operation(controller.signal)
  );
  const requestTimer = setTimeout(() => terminate(timeoutError), timeoutMs);

  try {
    return await Promise.race([operationPromise, termination]);
  } catch (error) {
    if (!terminationError) throw error;
    const settled = await Promise.race([
      operationPromise.then(
        () => true as const,
        () => true as const,
      ),
      new Promise<false>((resolve) => {
        settlementTimer = setTimeout(
          () => resolve(false),
          GMAIL_ABORT_SETTLEMENT_RESERVE_MS,
        );
      }),
    ]);
    if (!settled) {
      throw new GmailAbortSettlementError(stage);
    }
    throw terminationError;
  } finally {
    clearTimeout(requestTimer);
    if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function gmailCorrelation(messageId: string) {
  return {
    header: gmailCorrelationHeader(messageId),
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

export type PreparedEmailAuthorization =
  | Readonly<{ adapter: "console" }>
  | Readonly<{
    adapter: "gmail";
    accessToken: string;
    requestTimeoutMs: number;
  }>;

export async function authorizePreparedEmail(
  prepared: PreparedEmail,
): Promise<PreparedEmailAuthorization> {
  if (prepared.adapter === "console") {
    return Object.freeze({ adapter: "console" as const });
  }

  let requestTimeoutMs: number;
  try {
    requestTimeoutMs = gmailRequestTimeoutMs();
  } catch (error) {
    throw deliveryError(error, {
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
  }

  try {
    const accessToken = await gmailAccessToken(requestTimeoutMs);
    return Object.freeze({
      adapter: "gmail" as const,
      accessToken,
      requestTimeoutMs: Math.min(
        requestTimeoutMs,
        MAX_GMAIL_DELIVERY_REQUEST_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    throw deliveryError(error, {
      kind: "definitely-rejected",
      code: "GMAIL_OAUTH_FAILED",
    });
  }
}

function preparedBindingMismatch() {
  return new MailDeliveryError(
    "Prepared mail dispatch binding does not match its authority.",
    { kind: "definitely-rejected", code: "PAYLOAD_DIGEST_MISMATCH" },
  );
}

function preparedAuthorizationMismatch() {
  return new MailDeliveryError(
    "Prepared mail authorization does not match its adapter.",
    { kind: "definitely-rejected", code: "MAIL_PRE_SEND_REJECTED" },
  );
}

function assertPreparedGmailAuthorization(
  authorization: Extract<PreparedEmailAuthorization, { adapter: "gmail" }>,
) {
  if (
    typeof authorization.accessToken !== "string"
    || !authorization.accessToken.trim()
    || authorization.accessToken.length > 8_192
    || /[\r\n]/.test(authorization.accessToken)
    || !Number.isSafeInteger(authorization.requestTimeoutMs)
    || authorization.requestTimeoutMs < MIN_GMAIL_REQUEST_TIMEOUT_MS
    || authorization.requestTimeoutMs
      > MAX_GMAIL_DELIVERY_REQUEST_TIMEOUT_MS
  ) {
    throw new MailDeliveryError(
      "Prepared Gmail authorization is invalid.",
      { kind: "definitely-rejected", code: "MAIL_PRE_SEND_REJECTED" },
    );
  }
}

export type PreparedEmailSendOptions = Readonly<{
  signal?: AbortSignal;
}>;

export async function sendPreparedEmail(
  prepared: PreparedEmail,
  authority: MailDispatchAuthority,
  authorization: PreparedEmailAuthorization,
  options: PreparedEmailSendOptions = {},
) {
  if (!preparedEmailBindingMatches(prepared, authority)) {
    throw preparedBindingMismatch();
  }

  if (prepared.adapter === "console") {
    if (authorization.adapter !== "console") {
      throw preparedAuthorizationMismatch();
    }
    console.info(prepared.eventLine);
    return { providerId: prepared.providerId };
  }
  if (authorization.adapter !== "gmail") {
    throw preparedAuthorizationMismatch();
  }
  assertPreparedGmailAuthorization(authorization);

  try {
    return await withGmailRequestDeadline(
      "delivery",
      authorization.requestTimeoutMs,
      async (signal) => {
        const response = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${authorization.accessToken}`,
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
      options.signal,
    );
  } catch (error) {
    throw deliveryError(error, {
      kind: "ambiguous",
      code: "GMAIL_DELIVERY_AMBIGUOUS",
    });
  }
}

function configuredAdapter(): MailAdapter {
  const adapter = process.env.MAIL_ADAPTER ?? "console";
  if (adapter !== "console" && adapter !== "gmail") {
    throw new Error("MAIL_ADAPTER must be either console or gmail.");
  }
  return adapter;
}

function compatibilityAuthority(
  context: MailProviderContext | undefined,
): MailDispatchAuthority {
  const correlation = context?.messageId || "console-compatibility";
  return Object.freeze({
    id: correlation,
    operationId: correlation,
    claimToken: "compatibility-wrapper",
    claimOwner: "compatibility-wrapper",
    claimVersion: 1,
  });
}

export async function sendEmail(
  input: OutgoingEmail,
  context: MailProviderContext,
) {
  const authority = compatibilityAuthority(context);
  let prepared: PreparedEmail;
  try {
    prepared = prepareEmail(input, {
      adapter: configuredAdapter(),
      from: process.env.MAIL_FROM ?? "Codestead <noreply@example.com>",
      messageId: context?.messageId ?? "",
      authority,
    });
  } catch (error) {
    throw deliveryError(error, {
      kind: "definitely-rejected",
      code: "MAIL_PRE_SEND_REJECTED",
    });
  }
  const authorization = await authorizePreparedEmail(prepared);
  return sendPreparedEmail(prepared, authority, authorization);
}
