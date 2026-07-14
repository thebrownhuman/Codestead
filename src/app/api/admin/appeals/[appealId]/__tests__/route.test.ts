import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdminAppealDetail: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/appeals/admin-service", () => ({
  AppealAdminError: class AppealAdminError extends Error {
    constructor(public readonly code: string) { super(code); }
  },
  getAdminAppealDetail: mocks.getAdminAppealDetail,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { GET } from "../route";

const appealId = "10000000-0000-4000-8000-000000000001";
const detail = {
  appeal: {
    id: appealId,
    userId: "learner-user",
    category: "scoring",
    evidenceHashValid: true,
    reason: "Sensitive learner appeal claim",
  },
};

describe("administrator appeal evidence endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-user" }, session: { id: "session" } },
      account: { role: "admin" },
    });
    mocks.getAdminAppealDetail.mockResolvedValue(detail);
    mocks.writeAuditEvent.mockResolvedValue(undefined);
  });

  it("does not query or disclose evidence to a non-administrator", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await GET(new Request("https://learn.example.test"), { params: Promise.resolve({ appealId }) });
    expect(response.status).toBe(403);
    expect(mocks.getAdminAppealDetail).not.toHaveBeenCalled();
  });

  it("audits the exact learner and appeal before returning private evidence", async () => {
    const response = await GET(new Request("https://learn.example.test"), { params: Promise.resolve({ appealId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ detail });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-user",
      subjectUserId: "learner-user",
      resourceId: appealId,
      action: "appeal.read_evidence",
      outcome: "success",
    }));
  });

  it("fails closed without returning evidence when the durable read audit fails", async () => {
    mocks.writeAuditEvent.mockRejectedValue(new Error("audit sink unavailable"));
    const response = await GET(new Request("https://learn.example.test"), { params: Promise.resolve({ appealId }) });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("Sensitive learner appeal claim");
    expect(body).toContain("could not be loaded or audited");
  });

  it("normalizes malformed ids to a not-found response", async () => {
    const response = await GET(new Request("https://learn.example.test"), { params: Promise.resolve({ appealId: "invalid" }) });
    expect(response.status).toBe(404);
    expect(mocks.getAdminAppealDetail).not.toHaveBeenCalled();
  });
});
