import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(), authorize: vi.fn(), transition: vi.fn(), audit: vi.fn(), rateLimit: vi.fn(),
}));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/app/api/admin/curriculum/authorization", () => ({ authorizeCurriculumAdmin: mocks.authorize }));
vi.mock("@/lib/projects/module-project-service", async (original) => {
  const actual = await original<typeof import("@/lib/projects/module-project-service")>();
  return { ...actual, transitionModuleProjectTemplate: mocks.transition };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.rateLimit }));

import { ModuleProjectError } from "@/lib/projects/module-project-service";
import { POST } from "../route";

const templateId = "81000000-0000-4000-8000-000000000022";
const request = () => new NextRequest(`http://localhost/api/admin/module-projects/${templateId}/decision`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    requestId: "81000000-0000-4000-8000-000000000023",
    targetStage: "beta", expectedVersion: 1,
    reason: "Reviewed the scenario, milestones, acceptance boundaries, and no-solution promise.",
  }),
});

describe("admin module project decision route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "session-1" } },
      account: { role: "admin" }, response: null,
    });
    mocks.authorize.mockResolvedValue({ allowed: true, code: "AUTHORIZED" });
    mocks.transition.mockResolvedValue({ templateId, stage: "beta", rowVersion: 2, replayed: false });
    mocks.audit.mockResolvedValue(undefined);
    mocks.rateLimit.mockImplementation(async (_input, callback: () => Promise<Response>) => callback());
  });

  it("binds an MFA-authorized decision to the authenticated administrator", async () => {
    const response = await POST(request(), { params: Promise.resolve({ templateId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ completionAuditRecorded: true });
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1", templateId, targetStage: "beta", expectedVersion: 1,
    }));
  });

  it("fails before mutation when privileged authorization is stale", async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    expect((await POST(request(), { params: Promise.resolve({ templateId }) })).status).toBe(403);
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("fails before parsing or mutation without administrator access", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null, response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    expect((await POST(request(), { params: Promise.resolve({ templateId }) })).status).toBe(403);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("rejects a malformed template identifier before authorization or mutation", async () => {
    const response = await POST(request(), { params: Promise.resolve({ templateId: "not-a-template" }) });
    expect(response.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("maps stale optimistic versions without hiding the domain result", async () => {
    mocks.transition.mockRejectedValueOnce(new ModuleProjectError("VERSION_CONFLICT"));
    const response = await POST(request(), { params: Promise.resolve({ templateId }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "VERSION_CONFLICT" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
  });

  it("fails closed before mutation when the pre-mutation audit is unavailable", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request(), { params: Promise.resolve({ templateId }) });
    expect(response.status).toBe(503);
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("reports committed success when only the completion audit fails", async () => {
    mocks.audit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request(), { params: Promise.resolve({ templateId }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      completionAuditRecorded: false,
      warning: expect.stringContaining("Do not repeat"),
    });
    expect(mocks.transition).toHaveBeenCalledTimes(1);
  });
});
