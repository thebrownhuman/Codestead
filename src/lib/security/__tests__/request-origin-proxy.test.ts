import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config, proxy } from "../../../proxy";
import { auditApiSurface } from "../api-surface";

const CANONICAL_ORIGIN = "https://codestead.example.test";

function production(appUrl: string | null = CANONICAL_ORIGIN) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_URL", appUrl ?? "");
  if (appUrl === null) delete process.env.APP_URL;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Next request-origin proxy", () => {
  it("covers the complete API route surface with no route exemptions", async () => {
    const report = await auditApiSurface(process.cwd());
    expect(report.errors).toEqual([]);
    expect(report.entries.length).toBeGreaterThanOrEqual(80);
    expect(report.entries.every((entry) => entry.route.startsWith("/api/"))).toBe(true);
    expect(config).toEqual({ matcher: ["/api/:path*"] });
  });

  it.each(["GET", "HEAD", "OPTIONS"])("leaves %s requests unaffected", (method) => {
    production(null);
    const response = proxy(new NextRequest(`${CANONICAL_ORIGIN}/api/privacy/consents`, {
      method,
      headers: { cookie: "learncoding.session_token=opaque", origin: "https://attacker.invalid" },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each(["/api/access-requests", "/api/auth/sign-in/email"])(
    "keeps the unsafe no-cookie route %s reachable",
    (route) => {
      production(null);
      const response = proxy(new NextRequest(`${CANONICAL_ORIGIN}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: "{}",
      }));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it("rejects the exact hostile sibling text/plain cookie mutation before routing", async () => {
    production();
    const response = proxy(new NextRequest(`${CANONICAL_ORIGIN}/api/privacy/consents`, {
      method: "POST",
      headers: {
        cookie: "learncoding.session_token=opaque",
        origin: "https://evil.codestead.example.test",
        "sec-fetch-site": "same-site",
        "content-type": "text/plain",
        host: "codestead.example.test",
        forwarded: "host=codestead.example.test;proto=https",
        "x-forwarded-host": "codestead.example.test",
        "x-forwarded-proto": "https",
      },
      body: '{"analytics":true,"personalization":true,"policyVersion":"2026-07"}',
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ error: "REQUEST_ORIGIN_REJECTED" });
  });

  it("returns a no-store 503 when production APP_URL is unavailable", async () => {
    production(null);
    const response = proxy(new NextRequest(`${CANONICAL_ORIGIN}/api/drafts`, {
      method: "PUT",
      headers: { cookie: "learncoding.session_token=opaque", origin: CANONICAL_ORIGIN },
      body: "{}",
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ error: "CANONICAL_ORIGIN_UNAVAILABLE" });
  });

  it("uses only literal Origin authority, never the request URL or forwarding headers", () => {
    production();
    const response = proxy(new NextRequest("https://attacker.invalid/api/drafts", {
      method: "PUT",
      headers: {
        cookie: "learncoding.session_token=opaque",
        origin: CANONICAL_ORIGIN,
        host: "attacker.invalid",
        forwarded: "host=attacker.invalid;proto=http",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "http",
      },
      body: "{}",
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps canonical Origin on the authenticated production smoke request", () => {
    const source = readFileSync(
      path.join(process.cwd(), "scripts/verify-authenticated-learn-runtime.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /const canonicalOrigin = new URL\(input\.baseURL\)\.origin;[\s\S]*?context\.request\.post\(canonicalOrigin \+ "\/api\/auth\/sign-in\/email", \{[\s\S]*?headers: \{[\s\S]*?origin: canonicalOrigin/,
    );
  });
});
