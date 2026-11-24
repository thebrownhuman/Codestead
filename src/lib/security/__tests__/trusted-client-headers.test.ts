import { afterEach, describe, expect, it, vi } from "vitest";

import { trustedClientHeaders } from "../trusted-client-headers";

afterEach(() => vi.unstubAllEnvs());

describe("trustedClientHeaders", () => {
  it("never forwards a client-supplied x-forwarded-for", () => {
    const headers = trustedClientHeaders(new Request("https://app.test/", {
      headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "ua" },
    }));
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("cf-connecting-ip")).toBeNull();
    expect(headers.get("user-agent")).toBe("ua");
  });

  it("forwards only the trusted proxy IP, under the header Better Auth reads", () => {
    const headers = trustedClientHeaders(new Request("https://app.test/", {
      headers: { "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "198.51.100.7" },
    }));
    expect(headers.get("cf-connecting-ip")).toBe("198.51.100.7");
    expect(headers.get("x-forwarded-for")).toBeNull();
  });

  it("drops an invalid trusted IP value", () => {
    const headers = trustedClientHeaders(new Request("https://app.test/", { headers: { "cf-connecting-ip": "not-an-ip" } }));
    expect(headers.get("cf-connecting-ip")).toBeNull();
  });
});
