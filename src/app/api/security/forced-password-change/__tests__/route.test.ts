import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  complete: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/forced-password-change", () => ({
  completeForcedPasswordChange: mocks.complete,
}));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { POST } from "../route";

function request(body: unknown) {
  return new NextRequest("https://learn.test/api/security/forced-password-change", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  currentPassword: "temporary-password",
  newPassword: "independent-new-password",
};

describe("forced password change endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "session-1" } },
      account: { status: "pending", mustChangePassword: true },
      response: null,
    });
    mocks.complete.mockResolvedValue("changed");
    mocks.withRateLimit.mockImplementation(async (_config, operation) => operation());
  });

  it("uses the dedicated durable exception and returns no credential or session token", async () => {
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    expect(mocks.requireAuth).toHaveBeenCalledWith({
      allowPending: true,
      allowPasswordChange: true,
    });
    expect(mocks.complete).toHaveBeenCalledWith({ userId: "admin-1", ...validBody });
    const body = await response.json();
    expect(body).toEqual({ ok: true, signInRequired: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toMatch(/session_token=;/);
    expect(JSON.stringify(body)).not.toMatch(/token|password/i);
  });

  it("rejects malformed or reused passwords before rotating", async () => {
    const malformed = await POST(request({ currentPassword: "short", newPassword: "short" }));
    expect(malformed.status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("fails closed for invalid current authority", async () => {
    mocks.complete.mockResolvedValueOnce("invalid");
    const response = await POST(request(validBody));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Password change could not be completed." });
  });

  it("returns the authorization response before parsing credentials", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await POST(request(validBody));
    expect(response.status).toBe(401);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});