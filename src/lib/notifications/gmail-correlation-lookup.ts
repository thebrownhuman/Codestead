import { createHash } from "node:crypto";

import {
  dispatchEvidenceSha256,
  PROVIDER_EVIDENCE_VERSION,
} from "./dispatch-evidence";
import type {
  GmailCorrelationLookup,
  GmailReconciliationAuthority,
  GmailReconciliationProof,
} from "./gmail-reconciliation";
import {
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
  outboxCorrelationToken,
  outboxMessageId,
} from "./provider-correlation";
import { FatalProviderTransportError } from "./provider-dispatch-contract";

const DEFAULT_GMAIL_REQUEST_TIMEOUT_MS = 10_000;
const MIN_GMAIL_REQUEST_TIMEOUT_MS = 1_000;
const MAX_GMAIL_REQUEST_TIMEOUT_MS = 25_000;
const GMAIL_ABORT_SETTLEMENT_TIMEOUT_MS = 5_000;
const GMAIL_RAW_BINDING_VERSION = "gmail-raw-v1" as const;
const LEGACY_OUTBOX_MESSAGE_ID =
  /^<codestead\.outbox\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@mail\.codestead\.invalid>$/;
const CANONICAL_EVIDENCE_VALUE =
  /^v1\.([A-Za-z0-9_-]{43})$/;
const HEADER_NAME =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type GmailLookupResult =
  Awaited<ReturnType<GmailCorrelationLookup["findByMessageId"]>>;

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

async function withGmailReconciliationDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  let requestTimedOut = false;
  let operationSettled = false;
  const requestDeadline = new Promise<"deadline">((resolve) => {
    requestTimer = setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
      resolve("deadline");
    }, timeoutMs);
  });
  let operationPromise: Promise<T>;
  try {
    operationPromise = Promise.resolve(operation(controller.signal));
  } catch (error) {
    operationPromise = Promise.reject(error);
  }
  const observedOperation = operationPromise.then(
    (value) => {
      operationSettled = true;
      return { kind: "fulfilled" as const, value };
    },
    (error: unknown) => {
      operationSettled = true;
      return { kind: "rejected" as const, error };
    },
  );

  try {
    const first = await Promise.race([observedOperation, requestDeadline]);
    if (!requestTimedOut && first !== "deadline") {
      if (first.kind === "fulfilled") return first.value;
      throw first.error;
    }
    if (!operationSettled) {
      const settled = await Promise.race([
        observedOperation.then(() => true as const),
        new Promise<false>((resolve) => {
          settlementTimer = setTimeout(
            () => resolve(false),
            GMAIL_ABORT_SETTLEMENT_TIMEOUT_MS,
          );
        }),
      ]);
      if (!settled) {
        throw new FatalProviderTransportError("PROVIDER_TRANSPORT_FATAL");
      }
    }
    throw new Error("Gmail reconciliation request timed out.");
  } finally {
    if (requestTimer !== undefined) clearTimeout(requestTimer);
    if (settlementTimer !== undefined) clearTimeout(settlementTimer);
  }
}

async function gmailAccessToken(timeoutMs: number) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Gmail OAuth is not configured.");
  }
  return withGmailReconciliationDeadline(timeoutMs, async (signal) => {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
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
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new Error("Gmail token exchange returned no access token.");
    }
    return body.access_token;
  });
}

function exactCorrelationMessageId(
  messageId: string,
  authority: GmailReconciliationAuthority,
) {
  if (
    typeof messageId !== "string"
    || messageId === ""
    || /[\r\n]/u.test(messageId)
  ) return null;
  if (authority.kind === "opaque-header-v1") {
    let expected: string;
    try {
      expected = outboxMessageId(authority.operationId);
    } catch {
      return null;
    }
    return messageId === expected ? messageId : null;
  }
  return LEGACY_OUTBOX_MESSAGE_ID.test(messageId) ? messageId : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
  ) ? value as Record<string, unknown> : null;
}

function canonicalBase64urlBytes(value: unknown) {
  if (
    typeof value !== "string"
    || value === ""
    || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)
  ) return null;
  const paddingIndex = value.indexOf("=");
  const unpadded = paddingIndex === -1
    ? value
    : value.slice(0, paddingIndex);
  const suppliedPadding = value.length - unpadded.length;
  if (unpadded.length % 4 === 1) return null;
  const requiredPadding = (4 - (unpadded.length % 4)) % 4;
  if (suppliedPadding !== 0 && suppliedPadding !== requiredPadding) {
    return null;
  }
  const bytes = Buffer.from(unpadded, "base64url");
  return bytes.toString("base64url") === unpadded ? bytes : null;
}

function parsedHeaders(bytes: Buffer) {
  const separator = Buffer.from("\r\n\r\n", "ascii");
  const headerEnd = bytes.indexOf(separator);
  if (headerEnd <= 0) return null;
  const headerBlock = bytes.subarray(0, headerEnd).toString("latin1");
  if (headerBlock.includes("\0")) return null;
  const headers = new Map<string, string[]>();
  for (const line of headerBlock.split("\r\n")) {
    if (line === "" || /^[ \t]/u.test(line)) return null;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon);
    if (!HEADER_NAME.test(name)) return null;
    const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/gu, "");
    const normalizedName = name.toLowerCase();
    const existing = headers.get(normalizedName) ?? [];
    existing.push(value);
    headers.set(normalizedName, existing);
  }
  return headers;
}

function exactMessageId(headers: ReadonlyMap<string, readonly string[]>, expected: string) {
  const values = headers.get("message-id") ?? [];
  return values.length === 1 && values[0] === expected;
}

function canonicalEvidenceToken(value: string) {
  const match = CANONICAL_EVIDENCE_VALUE.exec(value);
  if (!match) return null;
  const bytes = canonicalBase64urlBytes(match[1]);
  if (bytes?.length !== 32) return null;
  return match[1]!;
}

function verifiedProof(
  rawBytes: Buffer,
  headers: ReadonlyMap<string, readonly string[]>,
  authority: Exclude<GmailReconciliationAuthority, {
    kind: "legacy-unbound-v0";
  }>,
): GmailReconciliationProof | null {
  if (authority.kind === "legacy-raw-bound-v1") {
    if ((headers.get("x-codestead-dispatch-evidence") ?? []).length !== 0) {
      return null;
    }
    const adapterPayloadSha256 = createHash("sha256")
      .update(rawBytes)
      .digest("hex");
    return adapterPayloadSha256 === authority.adapterPayloadSha256
      ? { kind: "raw-sha256-v1", adapterPayloadSha256 }
      : null;
  }

  const evidenceValues =
    headers.get("x-codestead-dispatch-evidence") ?? [];
  if (evidenceValues.length !== 1) return null;
  const evidenceToken = canonicalEvidenceToken(evidenceValues[0]!);
  if (evidenceToken === null) return null;
  let providerEvidenceSha256: string;
  try {
    providerEvidenceSha256 = dispatchEvidenceSha256({
      operationId: authority.operationId,
      providerCorrelationVersion:
        OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
      providerCorrelationToken:
        outboxCorrelationToken(authority.operationId),
      dispatchBindingVersion: GMAIL_RAW_BINDING_VERSION,
      adapterPayloadSha256: authority.adapterPayloadSha256,
      providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
      evidenceToken,
    });
  } catch {
    return null;
  }
  return providerEvidenceSha256 === authority.providerEvidenceSha256
    ? { kind: "header-evidence-v1", providerEvidenceSha256 }
    : null;
}

async function fetchJson(
  url: URL,
  accessToken: string,
  timeoutMs: number,
  failureLabel: "search" | "verification",
) {
  return withGmailReconciliationDeadline(timeoutMs, async (signal) => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Gmail reconciliation ${failureLabel} failed (${response.status}).`,
      );
    }
    return response.json() as Promise<unknown>;
  });
}

export async function findGmailMessageByMessageId(
  input: Readonly<{
    messageId: string;
    authority: GmailReconciliationAuthority;
  }>,
): Promise<GmailLookupResult> {
  const correlation = exactCorrelationMessageId(
    input.messageId,
    input.authority,
  );
  if (correlation === null) return { kind: "ambiguous" };
  const requestTimeoutMs = gmailRequestTimeoutMs();
  const accessToken = await gmailAccessToken(requestTimeoutMs);
  const listUrl = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  );
  listUrl.searchParams.set("maxResults", "2");
  listUrl.searchParams.set("q", `rfc822msgid:${correlation}`);
  listUrl.searchParams.append("labelIds", "SENT");
  const listRecord = objectRecord(
    await fetchJson(listUrl, accessToken, requestTimeoutMs, "search"),
  );
  if (listRecord === null) return { kind: "ambiguous" };
  const rawMessages = listRecord.messages;
  if (
    (rawMessages !== undefined && !Array.isArray(rawMessages))
    || listRecord.nextPageToken !== undefined
  ) return { kind: "ambiguous" };
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  if (messages.length === 0) return { kind: "not-found" };
  if (messages.length !== 1) return { kind: "ambiguous" };
  const listedMessage = objectRecord(messages[0]);
  const listedId = listedMessage?.id;
  if (typeof listedId !== "string" || listedId.trim() !== listedId || listedId === "") {
    return { kind: "ambiguous" };
  }

  const messageUrl = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(listedId)}`,
  );
  if (input.authority.kind === "legacy-unbound-v0") {
    messageUrl.searchParams.set("format", "metadata");
    messageUrl.searchParams.append("metadataHeaders", "Message-ID");
  } else {
    messageUrl.searchParams.set("format", "raw");
  }
  const messageRecord = objectRecord(
    await fetchJson(messageUrl, accessToken, requestTimeoutMs, "verification"),
  );
  if (messageRecord === null) return { kind: "ambiguous" };
  const labels = messageRecord.labelIds;
  if (
    messageRecord.id !== listedId
    || !Array.isArray(labels)
    || labels.some((label) => typeof label !== "string")
    || !labels.includes("SENT")
  ) return { kind: "ambiguous" };

  if (input.authority.kind === "legacy-unbound-v0") {
    const payload = objectRecord(messageRecord.payload);
    const rawHeaders = payload?.headers;
    if (!Array.isArray(rawHeaders)) return { kind: "ambiguous" };
    const messageIdValues = rawHeaders.flatMap((header) => {
      const record = objectRecord(header);
      return record
        && typeof record.name === "string"
        && record.name.toLowerCase() === "message-id"
        && typeof record.value === "string"
        ? [record.value.trim()]
        : [];
    });
    return messageIdValues.length === 1
      && messageIdValues[0] === correlation
      ? {
          kind: "matched",
          providerMessageId: listedId,
          proof: { kind: "legacy-discovery-v0" },
        }
      : { kind: "ambiguous" };
  }

  const rawBytes = canonicalBase64urlBytes(messageRecord.raw);
  if (rawBytes === null) return { kind: "ambiguous" };
  const headers = parsedHeaders(rawBytes);
  if (headers === null || !exactMessageId(headers, correlation)) {
    return { kind: "ambiguous" };
  }
  const proof = verifiedProof(rawBytes, headers, input.authority);
  return proof === null
    ? { kind: "ambiguous" }
    : { kind: "matched", providerMessageId: listedId, proof };
}
