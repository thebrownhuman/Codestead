import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), authorize: vi.fn(), generate: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.auth }));
vi.mock("../../../authorization", () => ({ authorizeCurriculumAdmin: mocks.authorize, curriculumErrorStatus: () => 409 }));
vi.mock("@/lib/curriculum-publication/admin-service", () => ({ generateCurriculumReleaseEvidence: mocks.generate, CurriculumAdminError: class extends Error {} }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: (_: unknown, run: () => unknown) => run() }));
import { POST } from "./route";
const versionId = "e1000000-0000-4000-8000-000000000001";
const body = { requestId: "f1000000-0000-4000-8000-000000000001", expectedVersion: 1, expectedContentHash: "a".repeat(64), reason: "Owner accepts checks were not run for beta.", acknowledgeNotRun: true, notRunReason: "Checks await grading parity fix." };
function request(data: unknown = body) { return POST(new NextRequest("http://localhost/api/admin/curriculum/versions/" + versionId + "/evidence", { method: "POST", body: JSON.stringify(data) }), { params: Promise.resolve({ versionId }) }); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ session: { user: { id: "authenticated-admin" }, session: { id: "session" } }, account: { role: "admin" } });
  mocks.authorize.mockResolvedValue({ allowed: true });
  mocks.generate.mockResolvedValue({ evidenceVersion: 1, publicationRevision: 2, replayed: false, notRunReports: [{ report: "security", reason: body.notRunReason }] });
});
describe("release generation route", () => {
  it("rejects non-admins before generation", async () => {
    mocks.auth.mockResolvedValue({ session: null, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await request()).status).toBe(403); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("requires fresh MFA", async () => {
    mocks.authorize.mockResolvedValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    expect((await request()).status).toBe(403); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each([{ acknowledgedBy: "spoofed" }, { acknowledgedAt: "2026-10-07T12:00:00Z" }, { evidence: { sourceCoverage: { passed: true } } }, { acknowledgeNotRun: false }])("rejects unsafe inputs %j", async (extra) => {
    expect((await request({ ...body, ...extra })).status).toBe(400); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("uses session identity and audits skipped reports with reasons", async () => {
    expect((await request()).status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "authenticated-admin", courseVersionId: versionId, expectedContentHash: body.expectedContentHash }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", metadata: expect.objectContaining({ notRunReports: [{ report: "security", reason: body.notRunReason }] }) }));
  });
});
