import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), authorize: vi.fn(), rollback: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.auth }));
vi.mock("../../../authorization", () => ({ authorizeCurriculumAdmin: mocks.authorize, curriculumErrorStatus: () => 409 }));
vi.mock("@/lib/curriculum-publication/admin-service", () => ({ rollbackCurriculumPointer: mocks.rollback, CurriculumAdminError: class extends Error {} }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: (_: unknown, run: () => unknown) => run() }));
import { POST } from "./route";
const courseId = "e2000000-0000-4000-8000-000000000001";
const body = { requestId: "f2000000-0000-4000-8000-000000000001", targetCourseVersionId: "e2000000-0000-4000-8000-000000000002", expectedPointerVersion: 3, reason: "Roll back to the last reviewed version." };
function request(data: unknown = body) { return POST(new NextRequest("http://localhost/api/admin/curriculum/courses/" + courseId + "/rollback", { method: "POST", body: JSON.stringify(data) }), { params: Promise.resolve({ courseId }) }); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ session: { user: { id: "authenticated-admin" }, session: { id: "session" } }, account: { role: "admin" } });
  mocks.authorize.mockResolvedValue({ allowed: true });
  mocks.audit.mockResolvedValue({});
  mocks.rollback.mockResolvedValue({ currentCourseVersionId: body.targetCourseVersionId, pointerVersion: 4, replayed: false });
});
describe("curriculum pointer rollback route", () => {
  it("rolls back with the session identity and audits completion", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ report: { pointerVersion: 4 }, completionAuditRecorded: true });
    expect(mocks.rollback).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "authenticated-admin", courseId }));
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "success" }));
  });
  it("reports success when only the completion audit write fails", async () => {
    mocks.audit.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("audit store down"));
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ report: { pointerVersion: 4 }, completionAuditRecorded: false });
  });
  it("returns the rollback error code when the mutation fails", async () => {
    mocks.rollback.mockRejectedValue(new Error("pointer moved"));
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "ROLLBACK_FAILED" });
  });
});
