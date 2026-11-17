import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  withRateLimit: vi.fn(),
  select: vi.fn(),
  authorize: vi.fn(),
  audit: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorize }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/ai/fallback-grants", () => ({ revokeFallbackGrantCommand: mocks.revoke }));

import { POST } from "../route";

const grantId = "fa000000-0000-4000-8000-000000000001";

function post(id: string) {
  return POST(
    new NextRequest(`https://learn.example.test/api/admin/fallback-grants/${id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "Learner no longer needs fallback access.",
        requestId: "fa000000-0000-4000-8000-000000000002",
      }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("admin fallback grant revoke route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "session-1" } },
      account: { role: "admin" },
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
    mocks.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [{ mfaVerifiedAt: new Date() }] }) }),
    });
    mocks.authorize.mockReturnValue({ allowed: true });
    mocks.revoke.mockResolvedValue({ ok: true, replayed: false, value: { revokedAt: new Date() } });
  });

  it("answers 404 for a malformed grant id without querying the uuid column", async () => {
    mocks.revoke.mockRejectedValue(new Error("invalid input syntax for type uuid"));
    const response = await post("not-a-uuid");
    expect(response.status).toBe(404);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("still revokes a well-formed grant id", async () => {
    const response = await post(grantId);
    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(expect.objectContaining({ grantId }));
  });
});
