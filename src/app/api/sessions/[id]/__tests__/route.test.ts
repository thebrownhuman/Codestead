import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  revokeOneOwnedSession: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/session-controls", () => ({ revokeOneOwnedSession: mocks.revokeOneOwnedSession }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { DELETE } from "../route";

describe("single learner session revoke API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: {
        user: { id: "learner-owner" },
        session: { id: "session-current" },
      },
      account: { role: "learner" },
      response: null,
    });
    mocks.revokeOneOwnedSession.mockResolvedValue(true);
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
  });

  it("always binds a requested session id to the authenticated owner", async () => {
    const response = await DELETE(
      new NextRequest("https://learn.test/api/sessions/other-users-session", { method: "DELETE" }),
      { params: Promise.resolve({ id: "other-users-session" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.revokeOneOwnedSession).toHaveBeenCalledWith({
      userId: "learner-owner",
      sessionId: "other-users-session",
      actorUserId: "learner-owner",
      reason: "learner_logout",
    });
  });

  it("returns a non-enumerating not-found response when ownership fails", async () => {
    mocks.revokeOneOwnedSession.mockResolvedValue(false);
    const response = await DELETE(
      new NextRequest("https://learn.test/api/sessions/not-owned", { method: "DELETE" }),
      { params: Promise.resolve({ id: "not-owned" }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});
