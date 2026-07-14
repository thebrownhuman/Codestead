import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), authorize: vi.fn(), list: vi.fn(), sync: vi.fn(), audit: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/app/api/admin/curriculum/authorization", () => ({ authorizeCurriculumAdmin: mocks.authorize }));
vi.mock("@/lib/projects/module-project-service", async (original) => {
  const actual = await original<typeof import("@/lib/projects/module-project-service")>();
  return { ...actual, listAdminModuleProjectTemplates: mocks.list, syncModuleProjectTemplates: mocks.sync };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.rateLimit }));

import { GET, POST } from "../route";

const auth = {
  session: { user: { id: "admin-1" }, session: { id: "session-1" } },
  account: { role: "admin" },
  response: null,
};

describe("admin module project catalog route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue(auth);
    mocks.authorize.mockResolvedValue({ allowed: true, code: "AUTHORIZED" });
    mocks.list.mockResolvedValue([{ id: "template-1", stage: "draft" }]);
    mocks.sync.mockResolvedValue({ templates: 119, created: 119, unchanged: 0 });
    mocks.audit.mockResolvedValue(undefined);
    mocks.rateLimit.mockImplementation(async (_input, callback: () => Promise<Response>) => callback());
  });

  it("lists only after the administrator guard", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("requires fresh privileged authorization before safe draft synchronization", async () => {
    const response = await POST(new NextRequest("http://localhost/api/admin/module-projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "81000000-0000-4000-8000-000000000020",
        reason: "Synchronize exact immutable project drafts after curriculum review.",
      }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1", sessionId: "session-1", action: "curriculum.stage",
    }));
    expect(mocks.sync).toHaveBeenCalledOnce();
  });

  it("does not touch the catalog for a learner or stale privileged session", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null, response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    expect((await GET()).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();

    mocks.authorize.mockResolvedValueOnce({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(new NextRequest("http://localhost/api/admin/module-projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "81000000-0000-4000-8000-000000000021",
        reason: "Synchronize exact immutable project drafts after curriculum review.",
      }),
    }));
    expect(response.status).toBe(403);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("fails closed before synchronization when the pre-mutation audit is unavailable", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(new NextRequest("http://localhost/api/admin/module-projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "81000000-0000-4000-8000-000000000020",
        reason: "Synchronize exact immutable project drafts after curriculum review.",
      }),
    }));
    expect(response.status).toBe(503);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("reports committed synchronization success when completion audit fails", async () => {
    mocks.audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(new NextRequest("http://localhost/api/admin/module-projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "81000000-0000-4000-8000-000000000020",
        reason: "Synchronize exact immutable project drafts after curriculum review.",
      }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      completionAuditRecorded: false,
      warning: expect.stringContaining("Do not repeat"),
    });
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });
});
