import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { RunnerError } from "./errors.js";

export const AUTH_HEADERS = Object.freeze({
  timestamp: "x-runner-timestamp",
  nonce: "x-runner-nonce",
  signature: "x-runner-signature",
  requestId: "x-request-id",
  idempotencyKey: "x-idempotency-key",
});

const REQUEST_SIGNATURE_DOMAIN = "LEARNCODING-RUNNER-HMAC-V2";
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,200}$/;

export function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function canonicalRequest(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  requestId: string,
  idempotencyKey: string,
  body: Uint8Array | string,
): string {
  return [
    REQUEST_SIGNATURE_DOMAIN,
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    requestId,
    idempotencyKey,
    sha256Hex(body),
  ].join("\n");
}

export function signRequest(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  requestId: string,
  idempotencyKey: string,
  body: Uint8Array | string,
): string {
  const canonical = canonicalRequest(
    method,
    path,
    timestamp,
    nonce,
    requestId,
    idempotencyKey,
    body,
  );
  return `sha256=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

export function signResponse(
  secret: string,
  requestId: string,
  statusCode: number,
  body: Uint8Array | string,
): string {
  const canonical = [
    requestId,
    String(statusCode),
    sha256Hex(body),
  ].join("\n");
  return `sha256=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
}

function singleHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string {
  const value = headers[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new RunnerError(
      "AUTH_REQUIRED",
      `missing authentication header ${name}`,
      401,
    );
  }
  return value;
}

function optionalHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string {
  const value = headers[name];
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new RunnerError(
      "AUTH_INVALID",
      `authentication header ${name} is invalid`,
      401,
    );
  }
  return value;
}

export class NonceStore {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #capacity: number;

  constructor(ttlSeconds: number, capacity = 20_000) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError("nonce TTL must be a positive integer");
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("nonce capacity must be a positive integer");
    }
    this.#ttlMs = ttlSeconds * 1_000;
    this.#capacity = capacity;
  }

  claim(nonce: string, nowMs: number): boolean {
    this.prune(nowMs);
    if (this.#seen.has(nonce)) {
      return false;
    }
    if (this.#seen.size >= this.#capacity) {
      // Never evict an unexpired nonce: that would reopen a replay window.
      return false;
    }
    this.#seen.set(nonce, nowMs + this.#ttlMs);
    return true;
  }

  prune(nowMs: number): void {
    for (const [nonce, expiresAt] of this.#seen) {
      if (expiresAt <= nowMs) {
        this.#seen.delete(nonce);
      }
    }
  }
}

export interface VerifyRequestInput {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Uint8Array;
  readonly nowMs: number;
}

export class HmacAuthenticator {
  readonly #secret: string;
  readonly #maxSkewSeconds: number;
  readonly #nonces: NonceStore;

  constructor(
    secret: string,
    maxSkewSeconds: number,
    nonces: NonceStore,
  ) {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new RangeError("HMAC secret must contain at least 32 bytes");
    }
    if (!Number.isInteger(maxSkewSeconds) || maxSkewSeconds <= 0) {
      throw new RangeError("max skew must be a positive integer");
    }
    this.#secret = secret;
    this.#maxSkewSeconds = maxSkewSeconds;
    this.#nonces = nonces;
  }

  verify(input: VerifyRequestInput): void {
    const timestamp = singleHeader(
      input.headers,
      AUTH_HEADERS.timestamp,
    );
    const nonce = singleHeader(input.headers, AUTH_HEADERS.nonce);
    const requestId = singleHeader(
      input.headers,
      AUTH_HEADERS.requestId,
    );
    const idempotencyKey = optionalHeader(
      input.headers,
      AUTH_HEADERS.idempotencyKey,
    );
    const provided = singleHeader(
      input.headers,
      AUTH_HEADERS.signature,
    );

    if (!/^\d{10}$/.test(timestamp)) {
      throw new RunnerError(
        "AUTH_INVALID",
        "authentication timestamp is invalid",
        401,
      );
    }
    if (!NONCE_PATTERN.test(nonce)) {
      throw new RunnerError(
        "AUTH_INVALID",
        "authentication nonce is invalid",
        401,
      );
    }
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new RunnerError(
        "AUTH_INVALID",
        "authentication request ID is invalid",
        401,
      );
    }
    if (
      idempotencyKey !== "" &&
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
    ) {
      throw new RunnerError(
        "AUTH_INVALID",
        "authentication idempotency key is invalid",
        401,
      );
    }
    const signatureMatch = SIGNATURE_PATTERN.exec(provided);
    if (signatureMatch === null) {
      throw new RunnerError(
        "AUTH_INVALID",
        "authentication signature is invalid",
        401,
      );
    }

    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(input.nowMs / 1_000);
    if (
      Math.abs(nowSeconds - timestampSeconds) > this.#maxSkewSeconds
    ) {
      throw new RunnerError(
        "AUTH_EXPIRED",
        "authentication timestamp is outside the accepted window",
        401,
      );
    }

    const expected = signRequest(
      this.#secret,
      input.method,
      input.path,
      timestamp,
      nonce,
      requestId,
      idempotencyKey,
      input.body,
    );
    const expectedBytes = Buffer.from(expected, "utf8");
    const providedBytes = Buffer.from(provided, "utf8");
    if (
      expectedBytes.length !== providedBytes.length ||
      !timingSafeEqual(expectedBytes, providedBytes)
    ) {
      throw new RunnerError(
        "AUTH_INVALID",
        "authentication signature is invalid",
        401,
      );
    }

    if (!this.#nonces.claim(nonce, input.nowMs)) {
      throw new RunnerError(
        "AUTH_REPLAY",
        "authentication nonce has already been used",
        409,
      );
    }
  }

  signResponse(
    requestId: string,
    statusCode: number,
    body: Uint8Array | string,
  ): string {
    return signResponse(
      this.#secret,
      requestId,
      statusCode,
      body,
    );
  }
}
