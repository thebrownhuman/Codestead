import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), fix: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/learning-requests/support-service", () => ({ fixSupportRequest: mocks.fix }));
import { POST } from "../route";
const id = "10000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const post = (body: unknown, headers = {}) => new NextRequest(`http://localhost:3000/api/admin/learning-requests/${id}/decision`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
describe("admin mark fixed boundary", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.requireAdmin.mockResolvedValue({ session: { user: { id: "admin" } } }); mocks.fix.mockResolvedValue({ ok: true, decision: "fixed" }); });
  it("requires administrator authorization", async () => {
    mocks.requireAdmin.mockResolvedValue({ session: null, response: NextResponse.json({}, { status: 403 }) });
    expect((await POST(post({ decision: "fixed" }), context)).status).toBe(403);
    expect(mocks.fix).not.toHaveBeenCalled();
  });
  it("marks fixed with an optional reply", async () => {
    expect((await POST(post({ decision: "fixed" }), context)).status).toBe(200);
    expect(mocks.fix).toHaveBeenCalledWith("admin", id, "");
    expect((await POST(post({ decision: "fixed", reply: "Try now" }), context)).status).toBe(200);
    expect(mocks.fix).toHaveBeenLastCalledWith("admin", id, "Try now");
  });
  it("validates identifiers, reply bounds, extra fields, and sensitive text", async () => {
    for (const body of [{ decision: "fixed", reply: "x".repeat(501) }, { decision: "fixed", userId: "forged" }, { decision: "fixed", reply: "api_key=secretsecret" }]) expect((await POST(post(body), context)).status).toBe(400);
    expect((await POST(post({ decision: "fixed" }), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
    expect(mocks.fix).not.toHaveBeenCalled();
  });
  it("rejects cross-origin writes and handles not-found and transactional failure", async () => {
    expect((await POST(post({ decision: "fixed" }, { cookie: "session=stub", origin: "https://evil.test" }), context)).status).toBe(403);
    expect(mocks.fix).not.toHaveBeenCalled();
    mocks.fix.mockResolvedValueOnce(null);
    expect((await POST(post({ decision: "fixed" }), context)).status).toBe(404);
    mocks.fix.mockRejectedValueOnce(new Error("private SQL"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(post({ decision: "fixed" }), context);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private SQL");
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      event: "learning_request.fix_failed", requestId: id, errorName: "Error",
    }));
    errorLog.mockRestore();
  });
});
