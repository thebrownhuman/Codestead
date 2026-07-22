import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("request-origin boundary", () => {
  it("provides a pure policy and the Next API proxy boundary", () => {
    expect(existsSync(path.join(process.cwd(), "src/lib/security/request-origin-policy.ts"))).toBe(true);
    expect(existsSync(path.join(process.cwd(), "src/proxy.ts"))).toBe(true);
    const policy = readFileSync(path.join(process.cwd(), "src/lib/security/request-origin-policy.ts"), "utf8");
    const proxy = readFileSync(path.join(process.cwd(), "src/proxy.ts"), "utf8");
    expect(policy).toContain("export function evaluateRequestOrigin");
    expect(proxy).toContain("export function proxy");
    expect(proxy).toContain('matcher: ["/api/:path*"]');
  });
});
