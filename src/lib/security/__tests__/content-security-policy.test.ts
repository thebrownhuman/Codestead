import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "../../../proxy";

afterEach(() => vi.unstubAllEnvs());
describe("nonce Content-Security-Policy", () => {
  it.each(["/health/live", "/health/ready", "/health/runner"])("exempts JSON health route %s from the document proxy", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });
  it("keeps origin rejection responses locked down", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://codestead.test");
    const response = await proxy(new NextRequest("https://codestead.test/api/drafts", {
      method: "PUT",
      headers: { cookie: "learncoding.session_token=opaque", origin: "https://attacker.test" },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  });
  it.each(["production", "development", "test"])("authorizes only nonce scripts in %s", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    const response = await proxy(new NextRequest("https://codestead.test/login", {
      headers: { "x-nonce": "attacker", "content-security-policy": "script-src *" },
    }));
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toBeTruthy();
    const nonce = response.headers.get("x-middleware-request-x-nonce")!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    // React's development build needs eval for debugging (Next.js CSP guide);
    // every other environment, including production, must never allow it.
    const scriptSrc = `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
    if (environment === "development") {
      expect(csp).toContain(`${scriptSrc} 'unsafe-eval'`);
      expect(csp.match(/'unsafe-eval'/g)).toHaveLength(1);
    } else {
      expect(csp).toContain(`${scriptSrc};`);
      expect(csp).not.toContain("'unsafe-eval'");
    }
    expect(csp.split(";").find((directive) => directive.trim().startsWith("script-src"))).not.toContain("'unsafe-inline'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const second = await proxy(new NextRequest("https://codestead.test/login"));
    expect(second.headers.get("x-middleware-request-x-nonce")).not.toBe(nonce);
  });
  it.each(["development", "production"])("passes allowed API requests through untouched in %s (no request rewrite, no document CSP)", async (environment) => {
    // Rewriting request headers on API routes left GET handlers hanging under
    // the dev server; APIs render no HTML, so they need no nonce or CSP.
    vi.stubEnv("NODE_ENV", environment);
    const response = await proxy(new NextRequest("https://codestead.test/api/monitoring/envelope", {
      headers: { "x-nonce": "attacker" },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
  it.each(["/", "/login", "/playground", "/learn", "/api/auth/callback/google", "/api/monitoring/envelope"])("covers %s, including prefetches", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url, headers: { "next-router-prefetch": "1" } })).toBe(true);
  });
  it.each(["/_next/static/chunk.js", "/_next/image", "/monaco/vs/loader.js", "/favicon.ico"])("excludes static asset %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });
});
