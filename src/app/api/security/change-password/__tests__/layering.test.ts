import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ current: { user: { id: "owner" }, session: { id: "session" } }, change: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: async () => ({ session: mocks.current }) }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: async (_check: unknown, operation: () => unknown) => operation() }));
vi.mock("@/lib/security/password-change", () => ({ changeAccountPassword: mocks.change }));
vi.mock("@/lib/security/password-settings", () => ({ hasCredentialPassword: async () => true, preservePasswordChangeSession: vi.fn() }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { changePassword: () => { throw new Error("Route bypassed the recovery service"); } } } }));
import { POST } from "../route";
beforeEach(() => { vi.resetAllMocks(); });
it("delegates password rotation, audit, and session preservation to the service", async () => {
  const response = Response.json({ ok: true }, { headers: { "set-cookie": "learncoding.session_token=replacement; HttpOnly" } });
  mocks.change.mockResolvedValue(response);
  const request = new NextRequest("https://example.test/api/security/change-password", {
    method: "POST", headers: { "content-type": "application/json", cookie: "approved-session" },
    body: JSON.stringify({ currentPassword: "current-password", newPassword: "a-new-long-password" }),
  });
  expect(await POST(request)).toBe(response);
  expect(mocks.change).toHaveBeenCalledWith({ current: mocks.current, headers: request.headers,
    passwords: { currentPassword: "current-password", newPassword: "a-new-long-password" } });
});
