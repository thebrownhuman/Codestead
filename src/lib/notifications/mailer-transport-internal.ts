import {
  gmailCorrelationHeader,
  preparedEmailBindingMatches,
  type PreparedConsoleEmail,
  type PreparedEmail,
  type PreparedGmailEmail,
  type MailAdapter,
  type PreparedMailDispatchAuthority,
} from "./prepared-dispatch";
import {
  isFatalProviderTransportError,
  MailDeliveryError,
  type MailDeliveryFailureCode,
} from "./provider-dispatch-contract";

export {
  dispatchBinding,
  preparedEmailBindingMatches,
} from "./prepared-dispatch";
export type {
  AuthoritativeOutgoingEmail,
  AuthoritySealSha256,
  CompatibilityMailDispatchAuthority,
  CompatibilitySourceAuthoritySha256,
  DispatchBinding,
  MailAdapter,
  MailDispatchAuthority,
  MailPreparationContext,
  MailProviderContext,
  OutgoingEmail,
  PreparedConsoleEmail,
  PreparedEmail,
  PreparedGmailEmail,
  ProviderPayloadSha256,
  SourceAuthoritySha256,
  PreparedMailDispatchAuthority,
} from "./prepared-dispatch";

function deliveryError(
  error: unknown,
  code: MailDeliveryFailureCode,
) {
  return error instanceof MailDeliveryError
    ? error
    : new MailDeliveryError(code);
}

const DEFAULT_GMAIL_REQUEST_TIMEOUT_MS = 10_000;
const MIN_GMAIL_REQUEST_TIMEOUT_MS = 1_000;
const MAX_GMAIL_REQUEST_TIMEOUT_MS = 15_000;
const GMAIL_ABORT_SETTLEMENT_RESERVE_MS = 5_000;
const EXACT_OAUTH_DEADLINE_MS = 20_000;
const EXACT_GUARDED_SEND_DEADLINE_MS = 20_000;

class GmailAbortSettlementError extends Error {
  constructor(stage: "OAuth" | "delivery" | "reconciliation") {
    super(`Gmail ${stage} request did not settle after abort.`);
    this.name = "GmailAbortSettlementError";
  }
}

class GmailRequestTerminationError extends Error {
  constructor(stage: "OAuth" | "delivery" | "reconciliation") {
    super(`Gmail ${stage} request terminated.`);
    this.name = "GmailRequestTerminationError";
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
      "GMAIL_REQUEST_TIMEOUT_MS must be an integer from 1000 to 15000.",
    );
  }
  return value;
}

async function withGmailRequestDeadline<T>(
  stage: "OAuth" | "delivery" | "reconciliation",
  requestTimeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
  abortSettlementMs = GMAIL_ABORT_SETTLEMENT_RESERVE_MS,
  absoluteDeadlineMs = requestTimeoutMs + abortSettlementMs,
) {
  const startedAt = performance.now();
  const absoluteDeadlineAt = startedAt + absoluteDeadlineMs;
  const requestDeadlineAt = Math.min(
    absoluteDeadlineAt,
    startedAt + requestTimeoutMs,
  );
  const controller = new AbortController();
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  let terminationError: Error | undefined;
  const timeoutError = new GmailRequestTerminationError(stage);
  const externalAbortError = new GmailRequestTerminationError(stage);
  if (externalSignal?.aborted) {
    controller.abort();
    throw externalAbortError;
  }
  let rejectTermination!: (error: Error) => void;
  const termination = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const terminate = (error: Error) => {
    if (terminationError) return;
    terminationError = error;
    rejectTermination(error);
    controller.abort();
  };
  const onExternalAbort = () => terminate(externalAbortError);
  if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  if (externalSignal?.aborted) onExternalAbort();

  const requestTimer = setTimeout(
    () => terminate(timeoutError),
    Math.max(0, requestDeadlineAt - performance.now()),
  );
  let operationPromise: Promise<T>;
  try {
    if (terminationError) throw terminationError;
    operationPromise = Promise.resolve(operation(controller.signal));
    if (!terminationError && performance.now() >= requestDeadlineAt) {
      terminate(timeoutError);
    }
  } catch (error) {
    operationPromise = Promise.reject(error);
  }

  try {
    const result = await Promise.race([operationPromise, termination]);
    if (!terminationError && externalSignal?.aborted) {
      terminate(externalAbortError);
    }
    if (!terminationError && performance.now() >= requestDeadlineAt) {
      terminate(timeoutError);
    }
    if (terminationError) throw terminationError;
    return result;
  } catch (error) {
    if (!terminationError) throw error;
    const settlementBudgetMs = Math.max(
      0,
      Math.min(abortSettlementMs, absoluteDeadlineAt - performance.now()),
    );
    const settled = await Promise.race([
      operationPromise.then(
        () => true as const,
        () => true as const,
      ),
      settlementBudgetMs === 0
        ? Promise.resolve(false as const)
        : new Promise<false>((resolve) => {
            settlementTimer = setTimeout(
              () => resolve(false),
              settlementBudgetMs,
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

type GmailOAuthConfiguration = Readonly<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}>;

declare const mailTransportConfigurationBrand: unique symbol;

export type MailTransportConfiguration = Readonly<{
  [mailTransportConfigurationBrand]: "MailTransportConfiguration";
}>;

type MailTransportConfigurationState =
  | Readonly<{ adapter: "console" }>
  | Readonly<{
      adapter: "gmail";
      configuration: GmailOAuthConfiguration;
    }>;

const MAIL_TRANSPORT_CONFIGURATIONS = new WeakMap<
  MailTransportConfiguration,
  MailTransportConfigurationState
>();

function configuredCredential(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 8_192
    && !/[\r\n\u0000]/u.test(value);
}

export function captureMailTransportConfiguration(
  adapter: MailAdapter,
): MailTransportConfiguration {
  if (adapter !== "console" && adapter !== "gmail") {
    throw new Error("Invalid mail adapter.");
  }
  const handle = Object.freeze({}) as MailTransportConfiguration;
  if (adapter === "console") {
    MAIL_TRANSPORT_CONFIGURATIONS.set(handle, Object.freeze({ adapter }));
    return handle;
  }
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (
    !configuredCredential(clientId)
    || !configuredCredential(clientSecret)
    || !configuredCredential(refreshToken)
  ) {
    throw new Error("Gmail OAuth is not configured.");
  }
  MAIL_TRANSPORT_CONFIGURATIONS.set(handle, Object.freeze({
    adapter,
    configuration: Object.freeze({ clientId, clientSecret, refreshToken }),
  }));
  return handle;
}

declare const preparedMailTransportPlanBrand: unique symbol;

export type PreparedMailTransportPlan = Readonly<{
  [preparedMailTransportPlanBrand]: "PreparedMailTransportPlan";
}>;

export type PreparedMailTransportTiming = Readonly<{
  oauthDeadlineMs: number;
  guardedSendDeadlineMs: number;
  providerAbortSettlementMs: number;
}>;

type PreparedMailTransportPlanState =
  | Readonly<{ adapter: "console" }>
  | Readonly<{
      adapter: "gmail";
      configuration: GmailOAuthConfiguration;
      timing: PreparedMailTransportTiming;
    }>;

const PREPARED_MAIL_TRANSPORT_PLANS = new WeakMap<
  PreparedMailTransportPlan,
  PreparedMailTransportPlanState
>();

export function capturePreparedMailTransportPlan(
  adapter: MailAdapter,
  timing: PreparedMailTransportTiming,
  transportConfiguration: MailTransportConfiguration,
): PreparedMailTransportPlan {
  if (
    (adapter !== "console" && adapter !== "gmail")
    || !Object.isFrozen(timing)
    || timing.oauthDeadlineMs !== EXACT_OAUTH_DEADLINE_MS
    || timing.guardedSendDeadlineMs !== EXACT_GUARDED_SEND_DEADLINE_MS
    || timing.providerAbortSettlementMs
      !== GMAIL_ABORT_SETTLEMENT_RESERVE_MS
  ) {
    throw new Error("Invalid prepared mail transport timing.");
  }
  const configurationState = Object.isFrozen(transportConfiguration)
    ? MAIL_TRANSPORT_CONFIGURATIONS.get(transportConfiguration)
    : undefined;
  if (!configurationState || configurationState.adapter !== adapter) {
    throw new Error("Mail transport configuration is invalid.");
  }
  const handle = Object.freeze({}) as PreparedMailTransportPlan;
  if (configurationState.adapter === "console") {
    PREPARED_MAIL_TRANSPORT_PLANS.set(handle, Object.freeze({
      adapter: "console" as const,
    }));
    return handle;
  }
  PREPARED_MAIL_TRANSPORT_PLANS.set(handle, Object.freeze({
    adapter,
    configuration: configurationState.configuration,
    timing,
  }));
  return handle;
}

export function discardPreparedMailTransportPlan(
  plan: PreparedMailTransportPlan,
): boolean {
  if (!Object.isFrozen(plan)) return false;
  return PREPARED_MAIL_TRANSPORT_PLANS.delete(plan);
}
function consumePreparedMailTransportPlan(
  plan: PreparedMailTransportPlan,
  adapter: MailAdapter,
) {
  const state = Object.isFrozen(plan)
    ? PREPARED_MAIL_TRANSPORT_PLANS.get(plan)
    : undefined;
  if (!state || state.adapter !== adapter) {
    throw new MailDeliveryError("MAIL_PRE_SEND_REJECTED");
  }
  PREPARED_MAIL_TRANSPORT_PLANS.delete(plan);
  return state;
}

async function gmailAccessToken(
  requestTimeoutMs: number,
  configuration?: GmailOAuthConfiguration,
  abortSettlementMs = GMAIL_ABORT_SETTLEMENT_RESERVE_MS,
  absoluteDeadlineMs = requestTimeoutMs + abortSettlementMs,
) {
  const clientId = configuration?.clientId ?? process.env.GMAIL_CLIENT_ID;
  const clientSecret = configuration?.clientSecret ?? process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = configuration?.refreshToken ?? process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Gmail OAuth is not configured.");
  return withGmailRequestDeadline("OAuth", requestTimeoutMs, async (signal) => {
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
  }, undefined, abortSettlementMs, absoluteDeadlineMs);
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

declare const preparedEmailAuthorizationBrand: unique symbol;

export type PreparedEmailAuthorization = Readonly<{
  [preparedEmailAuthorizationBrand]: "PreparedEmailAuthorization";
}>;

type PreparedEmailAuthorizationState =
  | Readonly<{
      adapter: "console";
      prepared: PreparedConsoleEmail;
      authority: PreparedMailDispatchAuthority;
    }>
  | Readonly<{
      adapter: "gmail";
      prepared: PreparedGmailEmail;
      authority: PreparedMailDispatchAuthority;
      accessToken: string;
      abortSettlementMs: number;
      requestTimeoutMs: number;
    }>;

const preparedEmailAuthorizationStates = new WeakMap<
  object,
  PreparedEmailAuthorizationState
>();

function issuePreparedEmailAuthorization(
  state: PreparedEmailAuthorizationState,
): PreparedEmailAuthorization {
  const handle = Object.freeze({}) as PreparedEmailAuthorization;
  preparedEmailAuthorizationStates.set(handle, Object.freeze(state));
  return handle;
}

export async function authorizePreparedEmail(
  prepared: PreparedEmail,
  authority: PreparedMailDispatchAuthority,
  transportPlan: PreparedMailTransportPlan,
): Promise<PreparedEmailAuthorization> {
  const preparedSnapshot = snapshotPreparedEmail(prepared);
  const authoritySnapshot = snapshotDispatchAuthority(authority);
  if (!preparedEmailBindingMatches(
    preparedSnapshot,
    authoritySnapshot,
  )) {
    throw preparedBindingMismatch();
  }

  const plan = consumePreparedMailTransportPlan(
    transportPlan,
    preparedSnapshot.adapter,
  );

  if (preparedSnapshot.adapter === "console") {
    return issuePreparedEmailAuthorization({
      adapter: "console" as const,
      prepared: preparedSnapshot,
      authority: authoritySnapshot,
    });
  }

  if (plan.adapter !== "gmail") {
    throw new MailDeliveryError("MAIL_PRE_SEND_REJECTED");
  }
  const abortSettlementMs = plan.timing.providerAbortSettlementMs;
  const oauthRequestTimeoutMs =
    plan.timing.oauthDeadlineMs - abortSettlementMs;

  try {
    const accessToken = await gmailAccessToken(
      oauthRequestTimeoutMs,
      plan.configuration,
      abortSettlementMs,
      plan.timing.oauthDeadlineMs,
    );
    return issuePreparedEmailAuthorization({
      adapter: "gmail" as const,
      prepared: preparedSnapshot,
      authority: authoritySnapshot,
      accessToken,
      abortSettlementMs,
      requestTimeoutMs: plan.timing.guardedSendDeadlineMs,
    });
  } catch (error) {
    if (isFatalProviderTransportError(error)) throw error;
    if (error instanceof GmailAbortSettlementError) {
      throw deliveryError(error, "GMAIL_OAUTH_TRANSPORT_UNSETTLED");
    }
    throw deliveryError(error, "GMAIL_OAUTH_FAILED");
  }
}

function preparedBindingMismatch() {
  return new MailDeliveryError("PAYLOAD_DIGEST_MISMATCH");
}

function preparedAuthorizationMismatch() {
  return new MailDeliveryError("MAIL_PRE_SEND_REJECTED");
}

function assertPreparedGmailAuthorization(
  authorization: Extract<PreparedEmailAuthorizationState, { adapter: "gmail" }>,
) {
  if (
    typeof authorization.accessToken !== "string"
    || !authorization.accessToken.trim()
    || authorization.accessToken.length > 8_192
    || /[\r\n]/.test(authorization.accessToken)
    || authorization.abortSettlementMs
      !== GMAIL_ABORT_SETTLEMENT_RESERVE_MS
    || authorization.requestTimeoutMs !== EXACT_GUARDED_SEND_DEADLINE_MS
  ) {
    throw new MailDeliveryError("MAIL_PRE_SEND_REJECTED");
  }
}

export type PreparedEmailSendOptions = Readonly<{
  signal?: AbortSignal;
}>;

function snapshotPreparedEmail(prepared: PreparedEmail): PreparedEmail {
  const adapter = prepared.adapter;
  if (adapter === "gmail") {
    const gmail = prepared as PreparedGmailEmail;
    return Object.freeze({
      adapter,
      bindingVersion: gmail.bindingVersion,
      bindingSha256: gmail.bindingSha256,
      authorityBindingVersion: gmail.authorityBindingVersion,
      authorityBindingSha256: gmail.authorityBindingSha256,
      messageId: gmail.messageId,
      rfc822: gmail.rfc822,
      raw: gmail.raw,
      requestBody: gmail.requestBody,
    });
  }
  if (adapter === "console") {
    const consoleEmail = prepared as PreparedConsoleEmail;
    return Object.freeze({
      adapter,
      bindingVersion: consoleEmail.bindingVersion,
      bindingSha256: consoleEmail.bindingSha256,
      authorityBindingVersion: consoleEmail.authorityBindingVersion,
      authorityBindingSha256: consoleEmail.authorityBindingSha256,
      eventLine: consoleEmail.eventLine,
      eventBytes: consoleEmail.eventBytes,
      requestBody: consoleEmail.requestBody,
      providerId: consoleEmail.providerId,
    });
  }
  throw preparedBindingMismatch();
}

function snapshotDispatchAuthority<T extends PreparedMailDispatchAuthority>(
  authority: T,
): T {
  return Object.freeze({
    id: authority.id,
    operationId: authority.operationId,
    claimToken: authority.claimToken,
    claimOwner: authority.claimOwner,
    claimVersion: authority.claimVersion,
    deliveryScopeKey: authority.deliveryScopeKey,
    sourceAuthoritySha256: authority.sourceAuthoritySha256,
    recipient: authority.recipient,
    template: authority.template,
    templateVersion: authority.templateVersion,
  }) as T;
}

export function discardPreparedEmailAuthorization(
  authorization: PreparedEmailAuthorization,
): boolean {
  if (!Object.isFrozen(authorization)) return false;
  return preparedEmailAuthorizationStates.delete(authorization);
}

function consumePreparedAuthorization(
  authorization: PreparedEmailAuthorization,
): PreparedEmailAuthorizationState {
  const state = preparedEmailAuthorizationStates.get(authorization);
  if (!state) {
    throw preparedAuthorizationMismatch();
  }
  preparedEmailAuthorizationStates.delete(authorization);
  return state;
}

function gmailProviderMessageId(body: unknown): string | null {
  try {
    if (
      !body
      || typeof body !== "object"
      || Array.isArray(body)
      || Object.getPrototypeOf(body) !== Object.prototype
    ) return null;
    const descriptor = Object.getOwnPropertyDescriptor(body, "id");
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    const providerId = descriptor.value;
    if (
      typeof providerId !== "string"
      || !providerId
      || providerId !== providerId.trim()
      || providerId.length > 512
      || /[\r\n\u0000]/u.test(providerId)
    ) return null;
    return providerId;
  } catch {
    return null;
  }
}
export async function sendPreparedEmail(
  authorization: PreparedEmailAuthorization,
  options: PreparedEmailSendOptions = {},
) {
  const authorizationSnapshot = consumePreparedAuthorization(authorization);
  const preparedSnapshot = authorizationSnapshot.prepared;
  const authoritySnapshot = authorizationSnapshot.authority;
  const externalSignal = options.signal;

  if (!preparedEmailBindingMatches(
    preparedSnapshot,
    authoritySnapshot,
  )) {
    throw preparedBindingMismatch();
  }

  if (authorizationSnapshot.adapter === "console") {
    const consolePrepared = authorizationSnapshot.prepared;
    process.stdout.write(consolePrepared.eventBytes);
    return { providerId: consolePrepared.providerId };
  }
  assertPreparedGmailAuthorization(authorizationSnapshot);

  try {
    return await withGmailRequestDeadline(
      "delivery",
      authorizationSnapshot.requestTimeoutMs,
      async (signal) => {
        const response = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${authorizationSnapshot.accessToken}`,
              "content-type": "application/json",
            },
            body: preparedSnapshot.requestBody,
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
            throw new MailDeliveryError("GMAIL_DELIVERY_REJECTED");
          }
          throw error;
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new MailDeliveryError("PROVIDER_OUTCOME_INVALID");
        }
        const providerId = gmailProviderMessageId(body);
        if (providerId === null) {
          throw new MailDeliveryError("PROVIDER_OUTCOME_INVALID");
        }
        return { providerId };
      },
      externalSignal,
      authorizationSnapshot.abortSettlementMs,
      authorizationSnapshot.requestTimeoutMs
        + authorizationSnapshot.abortSettlementMs,
    );
  } catch (error) {
    if (isFatalProviderTransportError(error)) throw error;
    if (error instanceof GmailAbortSettlementError) {
      throw new MailDeliveryError("GMAIL_DELIVERY_TRANSPORT_UNSETTLED");
    }
    if (error instanceof GmailRequestTerminationError) {
      throw new MailDeliveryError("GMAIL_DELIVERY_AMBIGUOUS");
    }
    throw deliveryError(error, "PROVIDER_OUTCOME_UNKNOWN");
  }
}
