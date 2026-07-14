import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return {
    limit,
    where,
    from,
    select,
    requireAdmin: vi.fn(),
    learnerExists: vi.fn(),
    revokeOneOwnedSession: vi.fn(),
    notifySessionRevoked: vi.fn(),
    writeAuditEvent: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/session-controls", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/session-controls")>();
  return {
    ...original,
    learnerExists: mocks.learnerExists,
    revokeOneOwnedSession: mocks.revokeOneOwnedSession,
  };
});
vi.mock("@/lib/session-notifications", () => ({ notifySessionRevoked: mocks.notifySessionRevoked }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { POST } from "../route";

const request = () => new NextRequest("https://learn.test/api/admin/revoke", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ reason: "Confirmed lost browser profile" }),
});

describe("administrator session revocation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockReset();
    mocks.requireAdmin.mockResolvedValue({
      session: {
        user: { id: "admin-1" },
        session: { id: "admin-session" },
      },
      account: { role: "admin" },
      response: null,
    });
    mocks.learnerExists.mockResolvedValue(true);
    mocks.revokeOneOwnedSession.mockResolvedValue(true);
    mocks.notifySessionRevoked.mockResolvedValue(undefined);
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
    mocks.limit
      .mockResolvedValueOnce([{ mfaVerifiedAt: new Date() }])
      .mockResolvedValueOnce([{ deviceLabel: "Chrome on Windows", userAgent: null }]);
  });

  it("requires a fresh MFA assertion before looking up or revoking a learner session", async () => {
    mocks.limit.mockReset().mockResolvedValueOnce([{ mfaVerifiedAt: new Date(0) }]);
    const response = await POST(request(), {
      params: Promise.resolve({ learnerId: "learner-1", sessionId: "session-1" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.learnerExists).not.toHaveBeenCalled();
    expect(mocks.revokeOneOwnedSession).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "denied",
      metadata: { denialCode: "FRESH_MFA_REQUIRED" },
    }));
  });

  it("does not revoke when the path learner is not a learner", async () => {
    mocks.learnerExists.mockResolvedValue(false);
    const response = await POST(request(), {
      params: Promise.resolve({ learnerId: "admin-2", sessionId: "session-1" }),
    });
    expect(response.status).toBe(404);
    expect(mocks.revokeOneOwnedSession).not.toHaveBeenCalled();
  });

  it("returns not found when the session is not owned by the path learner", async () => {
    mocks.limit
      .mockReset()
      .mockResolvedValueOnce([{ mfaVerifiedAt: new Date() }])
      .mockResolvedValueOnce([]);
    const response = await POST(request(), {
      params: Promise.resolve({ learnerId: "learner-1", sessionId: "someone-elses-session" }),
    });
    expect(response.status).toBe(404);
    expect(mocks.revokeOneOwnedSession).not.toHaveBeenCalled();
  });

  it("binds the revoke to the learner, audits it, and notifies the same learner", async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ learnerId: "learner-1", sessionId: "session-1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.revokeOneOwnedSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      sessionId: "session-1",
      actorUserId: "admin-1",
    }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      subjectUserId: "learner-1",
      resourceId: "session-1",
      outcome: "success",
    }));
    expect(mocks.notifySessionRevoked).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      device: "Chrome on Windows",
    }));
  });
});
