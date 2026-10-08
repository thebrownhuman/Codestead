import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), pdf: vi.fn(), limiter: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.auth }));
vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));
vi.mock("@/lib/certificates/pdf", () => ({ renderCertificatePdf: mocks.pdf }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.limiter }));
import { GET } from "../route";
const id = "a3000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ certificateId: id }) };
const request = () => new NextRequest(`https://learn.test/api/certificates/${id}/pdf`);
describe("owner certificate PDF route", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv("APP_URL", "https://learn.test");
    mocks.auth.mockResolvedValue({ session: { user: { id: "owner" } } });
    mocks.limiter.mockImplementation(async (_check, handler) => handler());
    mocks.query.mockResolvedValue({ rows: [{ id, verification_id: "a".repeat(32), learner_display_name: "Owner Name", course_title: "Python", course_version_label: "1", issued_at: new Date("2026-07-14T00:00:00Z"), revoked_at: null, revocation_reason: null }] });
    mocks.pdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  });
  it("renders a PDF for its owner with a canonical verify URL", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mocks.query.mock.calls[0][0]).toContain("certificate.user_id=$2");
    expect(mocks.query.mock.calls[0][1]).toEqual([id, "owner"]);
    expect(mocks.pdf).toHaveBeenCalledWith(expect.objectContaining({ verificationUrl: `https://learn.test/verify/${"a".repeat(32)}`, learnerDisplayName: "Owner Name" }));
  });
  it("denies another user's certificate and unknown IDs identically", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Certificate not found." });
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
  it("requires login", async () => {
    mocks.auth.mockResolvedValue({ session: null, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
    expect((await GET(request(), context)).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("enforces the download rate limit before fetching or rendering", async () => {
    mocks.limiter.mockResolvedValue(NextResponse.json({ code: "RATE_LIMITED" }, { status: 429 }));
    expect((await GET(request(), context)).status).toBe(429);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
});
