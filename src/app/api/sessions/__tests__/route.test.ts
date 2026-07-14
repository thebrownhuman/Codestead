import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  listSessionControls: vi.fn(),
  archiveAndDeleteSessions: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/session-controls", () => ({
  listSessionControls: mocks.listSessionControls,
  archiveAndDeleteSessions: mocks.archiveAndDeleteSessions,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { DELETE, GET } from "../route";

const auth = {
  session: {
    user: { id: "learner-1", name: "Learner" },
    session: { id: "session-current" },
  },
  account: { role: "learner" },
  response: null,
};

describe("learner session API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.listSessionControls.mockResolvedValue({ sessions: [], revocationRequests: [] });
    mocks.archiveAndDeleteSessions.mockResolvedValue([]);
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
  });

  it("uses only the authenticated learner identity when listing", async () => {
    const response = await GET();
    expect(mocks.listSessionControls).toHaveBeenCalledWith("learner-1", "session-current");
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ sessions: [], revocationRequests: [] });
  });

  it("rejects malformed revoke scopes before changing sessions", async () => {
    const response = await DELETE(new NextRequest("https://learn.test/api/sessions", {
      method: "DELETE",
      body: JSON.stringify({ scope: "learner-2", userId: "learner-2" }),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(400);
    expect(mocks.archiveAndDeleteSessions).not.toHaveBeenCalled();
  });

  it("binds revoke-all to the authenticated learner and audits the count", async () => {
    mocks.archiveAndDeleteSessions.mockResolvedValue(["one", "two"]);
    const response = await DELETE(new NextRequest("https://learn.test/api/sessions", {
      method: "DELETE",
      body: JSON.stringify({ scope: "all" }),
      headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(mocks.archiveAndDeleteSessions).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      actorUserId: "learner-1",
      currentSessionId: "session-current",
      scope: "all",
    }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      subjectUserId: "learner-1",
      metadata: { revokedCount: 2 },
    }));
  });

  it("preserves no-store headers on authentication failures", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
