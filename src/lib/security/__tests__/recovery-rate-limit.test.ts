import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock("../rate-limit", () => ({ withRateLimit: mocks.limit }));
import { atomicAuthRateLimitPlugin } from "../auth-rate-limit";
beforeEach(() => { vi.resetAllMocks(); mocks.limit.mockImplementation(async (_check, admitted) => admitted()); });
describe("public recovery admission", () => {
  it.each([
    ["/request-password-reset", "auth_reset_request_ip", 3, 600],
    ["/reset-password", "auth_reset_password_ip", 6, 60],
    ["/reset-password/one-bearer", "auth_reset_callback_ip", 10, 60],
    ["/two-factor/verify-backup-code", "auth_backup_code_ip", 6, 60],
  ])("spends a durable budget for %s before validation", async (path, name, limit, windowSeconds) => {
    const plugin = atomicAuthRateLimitPlugin(true);
    await plugin.onRequest(new Request(`https://example.test/api/auth${path}`, {
      headers: { "cf-connecting-ip": "198.51.100.41" },
    }), { baseURL: "https://example.test/api/auth" });
    expect(mocks.limit).toHaveBeenCalledWith({
      policy: { name, limit, windowSeconds, failureMode: "closed" },
      identity: { kind: "ip", value: "198.51.100.41" },
    }, expect.any(Function));
  });
  it("shares the callback budget across tokens and fails closed on storage errors", async () => {
    mocks.limit.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const plugin = atomicAuthRateLimitPlugin(true);
    for (const token of ["first", "second"]) {
      const result = await plugin.onRequest(new Request(`https://example.test/api/auth/reset-password/${token}`), { baseURL: "https://example.test/api/auth" });
      expect(result?.response.status).toBe(503);
    }
    expect(mocks.limit.mock.calls.map(([check]) => check.policy.name)).toEqual(["auth_reset_callback_ip", "auth_reset_callback_ip"]);
  });
});
