import { describe, expect, it } from "vitest";

import { evaluateRequestOrigin } from "../request-origin-policy";

const CANONICAL_ORIGIN = "https://codestead.example.test";

function evaluate(input: {
  method?: string;
  headers?: HeadersInit;
  appUrl?: string;
  production?: boolean;
} = {}) {
  return evaluateRequestOrigin({
    method: input.method ?? "POST",
    headers: new Headers(input.headers),
    appUrl: input.appUrl,
    production: input.production ?? true,
  });
}

describe("pure request-origin policy", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("leaves safe %s requests unaffected", (method) => {
    expect(evaluate({
      method,
      appUrl: "not a URL",
      headers: { cookie: "session=opaque", origin: "https://hostile.example.test" },
    })).toEqual({ allowed: true });
  });

  it("keeps unsafe no-cookie public and authentication requests reachable", () => {
    expect(evaluate({
      appUrl: undefined,
      headers: { origin: "null", "sec-fetch-site": "cross-site" },
    })).toEqual({ allowed: true });
  });

  it("does not treat a present empty Cookie header as a no-cookie request", () => {
    expect(evaluate({
      appUrl: CANONICAL_ORIGIN,
      headers: { cookie: "", origin: "https://evil.codestead.example.test" },
    })).toEqual({
      allowed: false,
      status: 403,
      code: "REQUEST_ORIGIN_REJECTED",
    });
  });

  it("allows an unsafe cookie request only for the literal canonical origin", () => {
    expect(evaluate({
      appUrl: CANONICAL_ORIGIN,
      headers: {
        cookie: "learncoding.session_token=opaque",
        origin: CANONICAL_ORIGIN,
        "sec-fetch-site": "same-origin",
        host: "attacker.invalid",
        forwarded: "host=attacker.invalid;proto=http",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
      },
    })).toEqual({ allowed: true });
  });

  it.each([
    ["missing", undefined],
    ["null", "null"],
    ["malformed", "https://%"],
    ["multiple", `${CANONICAL_ORIGIN}, https://attacker.invalid`],
    ["sibling", "https://evil.codestead.example.test"],
    ["scheme mismatch", "http://codestead.example.test"],
    ["port mismatch", "https://codestead.example.test:8443"],
  ])("rejects a %s Origin on unsafe cookie requests", (_label, origin) => {
    const headers = new Headers({ cookie: "learncoding.session_token=opaque" });
    if (origin !== undefined) headers.set("origin", origin);
    expect(evaluate({ appUrl: CANONICAL_ORIGIN, headers })).toEqual({
      allowed: false,
      status: 403,
      code: "REQUEST_ORIGIN_REJECTED",
    });
  });

  it.each(["cross-site", "same-site", "none", "same-origin, cross-site"])(
    "rejects Sec-Fetch-Site=%s when it is present",
    (secFetchSite) => {
      expect(evaluate({
        appUrl: CANONICAL_ORIGIN,
        headers: {
          cookie: "learncoding.session_token=opaque",
          origin: CANONICAL_ORIGIN,
          "sec-fetch-site": secFetchSite,
        },
      })).toEqual({
        allowed: false,
        status: 403,
        code: "REQUEST_ORIGIN_REJECTED",
      });
    },
  );

  it.each([
    undefined,
    "",
    "http://codestead.example.test",
    "https://Codestead.example.test",
    "https://codestead.example.test/",
    "https://codestead.example.test/path",
    "https://codestead.example.test?query=true",
    "https://user@codestead.example.test",
    "https://codestead.example.test:443",
  ])("fails closed when production APP_URL is not a canonical HTTPS origin: %s", (appUrl) => {
    expect(evaluate({
      appUrl,
      headers: { cookie: "learncoding.session_token=opaque", origin: CANONICAL_ORIGIN },
    })).toEqual({
      allowed: false,
      status: 503,
      code: "CANONICAL_ORIGIN_UNAVAILABLE",
    });
  });

  it("uses the development localhost origin only when APP_URL is absent outside production", () => {
    expect(evaluate({
      production: false,
      headers: { cookie: "learncoding.session_token=opaque", origin: "http://localhost:3000" },
    })).toEqual({ allowed: true });
  });
});
