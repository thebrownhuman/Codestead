import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  audit: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/projects/module-project-service", async (original) => {
  const actual = await original<typeof import("@/lib/projects/module-project-service")>();
  return { ...actual, listLearnerModuleProjects: mocks.list, startModuleProject: mocks.start };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { GET, POST } from "../route";

const session = { user: { id: "learner-1" } };

describe("module project learner route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session, response: null });
    mocks.list.mockResolvedValue([{ templateId: "template-1", state: "ready" }]);
    mocks.start.mockResolvedValue({
      project: { id: "project-1" }, replayed: false, reusedExisting: false,
    });
    mocks.audit.mockResolvedValue(undefined);
    mocks.withRateLimit.mockImplementation(async (_check, handler: () => Promise<Response>) => handler());
  });

  it("lists only through the authenticated owner id", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith("learner-1");
    expect(await response.json()).toEqual({ projects: [{ templateId: "template-1", state: "ready" }] });
  });

  it("starts from the authenticated owner and rejects client-supplied identity", async () => {
    const request = new NextRequest("http://localhost/api/module-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "81000000-0000-4000-8000-000000000001",
        templateId: "81000000-0000-4000-8000-000000000002",
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.start).toHaveBeenCalledWith({
      userId: "learner-1",
      requestId: "81000000-0000-4000-8000-000000000001",
      templateId: "81000000-0000-4000-8000-000000000002",
    });
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "module_project_start_user", identity: { kind: "user", value: "learner-1" } },
      expect.any(Function),
    );

    const injected = await POST(new NextRequest("http://localhost/api/module-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "other-learner",
        requestId: "81000000-0000-4000-8000-000000000003",
        templateId: "81000000-0000-4000-8000-000000000002",
      }),
    }));
    expect(injected.status).toBe(400);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("returns the authentication response without calling services", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await GET()).status).toBe(401);
    expect(await POST(new NextRequest("http://localhost/api/module-projects", { method: "POST" }))).toMatchObject({ status: 401 });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("fails closed before starting when the pre-mutation audit is unavailable", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(new NextRequest("http://localhost/api/module-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "81000000-0000-4000-8000-000000000001",
        templateId: "81000000-0000-4000-8000-000000000002",
      }),
    }));
    expect(response.status).toBe(503);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("returns committed success with a reconciliation warning when completion audit fails", async () => {
    mocks.audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(new NextRequest("http://localhost/api/module-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "81000000-0000-4000-8000-000000000001",
        templateId: "81000000-0000-4000-8000-000000000002",
      }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ completionAuditRecorded: false, warning: expect.stringContaining("Do not repeat") });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});
