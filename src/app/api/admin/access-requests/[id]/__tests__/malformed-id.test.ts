import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  authorize: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, transaction: mocks.transaction } }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorize }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueEmailInTransaction: vi.fn() }));
vi.mock("@/lib/security/user-authority-lock", () => ({ lockAccessRequestSourceAuthority: vi.fn() }));

import { POST as approve } from "../approve/route";
import { POST as reject } from "../reject/route";

function request(action: string) {
  return new NextRequest(`https://learn.example.test/api/admin/access-requests/not-a-uuid/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "Reviewed the request details." }),
  });
}

describe("admin access-request decisions with a malformed id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1", role: "admin" }, session: { id: "session-1" } },
      account: { role: "admin" },
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    mocks.authorize.mockReturnValue({ allowed: true });
    // First select reads the admin session; any later select would hit the
    // access_request uuid column, where Postgres rejects a malformed id.
    mocks.select
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: async () => [{ mfaVerifiedAt: new Date() }] }) }),
      })
      .mockImplementation(() => {
        throw new Error("invalid input syntax for type uuid");
      });
  });

  it.each([
    ["approve", approve],
    ["reject", reject],
  ] as const)("%s answers 404 without querying the uuid column", async (action, handler) => {
    const response = await handler(request(action), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(404);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
