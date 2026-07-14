import { describe, expect, it } from "vitest";
import {
  AUTH_HEADERS,
  HmacAuthenticator,
  NonceStore,
  canonicalRequest,
  sha256Hex,
  signRequest,
  signResponse,
} from "../auth.js";
import { RunnerError } from "../errors.js";

const secret = "a-test-secret-that-is-definitely-over-32-bytes";
const nowMs = 1_750_000_000_000;
const timestamp = String(Math.floor(nowMs / 1_000));
const nonce = "nonce_abcdefghijklmnop";
const requestId = "request-contract-0001";
const idempotencyKey = "idempotency-contract-0001";
const body = Buffer.from('{"hello":"world"}');

function signedHeaders(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    [AUTH_HEADERS.timestamp]: timestamp,
    [AUTH_HEADERS.nonce]: nonce,
    [AUTH_HEADERS.signature]: signRequest(
      secret,
      "POST",
      "/v1/jobs",
      timestamp,
      nonce,
      requestId,
      idempotencyKey,
      body,
    ),
    [AUTH_HEADERS.requestId]: requestId,
    [AUTH_HEADERS.idempotencyKey]: idempotencyKey,
    ...overrides,
  };
}

describe("HMAC authentication", () => {
  it("uses a stable body-hash canonical form", () => {
    expect(
      canonicalRequest(
        "post",
        "/v1/jobs",
        timestamp,
        nonce,
        requestId,
        idempotencyKey,
        body,
      ),
    ).toBe(
      `LEARNCODING-RUNNER-HMAC-V2\nPOST\n/v1/jobs\n${timestamp}\n${nonce}\n${requestId}\n${idempotencyKey}\n${sha256Hex(body)}`,
    );
  });

  it("matches the shared client/server HMAC-v2 contract vector", () => {
    expect(
      signRequest(
        "runner-signature-contract-secret-32-bytes",
        "POST",
        "/v1/jobs",
        "1750000000",
        "nonce_abcdefghijklmnop",
        "request-contract-0001",
        "idempotency-contract-0001",
        '{"hello":"world"}',
      ),
    ).toBe(
      "sha256=6e66a3f44c830bf8f4a3ad660a36d1791dca9367eea79d5bfd2e4b4677895064",
    );
  });

  it("accepts a valid signature once", () => {
    const auth = new HmacAuthenticator(
      secret,
      300,
      new NonceStore(600),
    );
    expect(() =>
      auth.verify({
        method: "POST",
        path: "/v1/jobs",
        headers: signedHeaders(),
        body,
        nowMs,
      }),
    ).not.toThrow();
  });

  it("rejects body and path tampering", () => {
    const make = () =>
      new HmacAuthenticator(secret, 300, new NonceStore(600));
    expect(() =>
      make().verify({
        method: "POST",
        path: "/v1/jobs",
        headers: signedHeaders(),
        body: Buffer.from('{"hello":"tampered"}'),
        nowMs,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "AUTH_INVALID",
      }),
    );
    expect(() =>
      make().verify({
        method: "POST",
        path: "/v1/other",
        headers: signedHeaders(),
        body,
        nowMs,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "AUTH_INVALID",
      }),
    );
  });

  it("rejects idempotency-key and request-ID mutation", () => {
    const make = () =>
      new HmacAuthenticator(secret, 300, new NonceStore(600));
    expect(() =>
      make().verify({
        method: "POST",
        path: "/v1/jobs",
        headers: signedHeaders({
          [AUTH_HEADERS.idempotencyKey]: "idempotency-mutated-0001",
        }),
        body,
        nowMs,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "AUTH_INVALID",
      }),
    );
    expect(() =>
      make().verify({
        method: "POST",
        path: "/v1/jobs",
        headers: signedHeaders({
          [AUTH_HEADERS.requestId]: "request-mutated-0001",
        }),
        body,
        nowMs,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "AUTH_INVALID",
      }),
    );
  });

  it("rejects stale timestamps", () => {
    const auth = new HmacAuthenticator(
      secret,
      30,
      new NonceStore(600),
    );
    expect(() =>
      auth.verify({
        method: "POST",
        path: "/v1/jobs",
        headers: signedHeaders(),
        body,
        nowMs: nowMs + 31_000,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "AUTH_EXPIRED",
      }),
    );
  });

  it("rejects nonce replay after valid authentication", () => {
    const auth = new HmacAuthenticator(
      secret,
      300,
      new NonceStore(600),
    );
    const input = {
      method: "POST",
      path: "/v1/jobs",
      headers: signedHeaders(),
      body,
      nowMs,
    } as const;
    auth.verify(input);
    expect(() => auth.verify(input)).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "AUTH_REPLAY",
      }),
    );
  });

  it("does not consume a nonce for an invalid signature", () => {
    const auth = new HmacAuthenticator(
      secret,
      300,
      new NonceStore(600),
    );
    expect(() =>
      auth.verify({
        method: "POST",
        path: "/v1/jobs",
        headers: signedHeaders({
          [AUTH_HEADERS.signature]: `sha256:${"0".repeat(64)}`,
        }),
        body,
        nowMs,
      }),
    ).toThrow();
    expect(() =>
      auth.verify({
        method: "POST",
        path: "/v1/jobs",
        headers: signedHeaders(),
        body,
        nowMs,
      }),
    ).not.toThrow();
  });

  it("allows nonce reuse only after nonce TTL expiry", () => {
    const store = new NonceStore(60);
    expect(store.claim(nonce, nowMs)).toBe(true);
    expect(store.claim(nonce, nowMs + 59_999)).toBe(false);
    expect(store.claim(nonce, nowMs + 60_000)).toBe(true);
  });

  it("signs deterministic response envelopes", () => {
    expect(signResponse(secret, "request-1", 202, body)).toBe(
      signResponse(secret, "request-1", 202, body),
    );
    expect(signResponse(secret, "request-1", 202, body)).not.toBe(
      signResponse(secret, "request-1", 200, body),
    );
  });

  it("rejects weak secrets and malformed headers", () => {
    expect(
      () =>
        new HmacAuthenticator("short", 300, new NonceStore(600)),
    ).toThrow(RangeError);
    const auth = new HmacAuthenticator(
      secret,
      300,
      new NonceStore(600),
    );
    expect(() =>
      auth.verify({
        method: "POST",
        path: "/v1/jobs",
        headers: {},
        body,
        nowMs,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RunnerError>>({
        code: "AUTH_REQUIRED",
      }),
    );
  });
});
