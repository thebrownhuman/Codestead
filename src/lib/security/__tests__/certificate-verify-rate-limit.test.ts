import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ limiter: vi.fn() }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.limiter, rateLimitIp: () => "192.0.2.1" }));
import { proxy } from "@/proxy";
describe("public certificate request limiter", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each(["a".repeat(32), "invalid"])("limits verification before looking up %s", async (id) => {
    mocks.limiter.mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "60" } }));
    const result = await proxy(new NextRequest(`https://learn.test/verify/${id}`));
    expect(result.status).toBe(429);
    expect(result.headers.get("Retry-After")).toBe("60");
    expect(mocks.limiter).toHaveBeenCalledWith({ policy: "certificate_verify_ip", identity: { kind: "ip", value: "192.0.2.1" } }, expect.any(Function));
  });
});
