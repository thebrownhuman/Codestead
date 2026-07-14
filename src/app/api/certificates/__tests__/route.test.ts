import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  issue: vi.fn(),
  listCandidates: vi.fn(),
  listOwn: vi.fn(),
  audit: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/certificates/service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/certificates/service")>();
  return {
    ...original,
    issueCourseCertificate: mocks.issue,
    listCertificateCandidates: mocks.listCandidates,
    listOwnCertificates: mocks.listOwn,
  };
});
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { CertificateError } from "@/lib/certificates/service";
import { GET, POST } from "../route";

const learnerId = "learner-owner";
const enrollmentId = "c1000000-0000-4000-8000-000000000001";
const requestId = "c2000000-0000-4000-8000-000000000001";

function request(body: unknown) {
  return new NextRequest("https://learn.test/api/certificates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("certificate learner API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: learnerId } }, response: null });
    mocks.listOwn.mockResolvedValue([]);
    mocks.listCandidates.mockResolvedValue([]);
    mocks.issue.mockResolvedValue({
      certificate: { id: "certificate-1" }, replayed: false, reusedExisting: false,
    });
    mocks.audit.mockResolvedValue({ eventHash: "hash" });
    mocks.withRateLimit.mockImplementation(async (_check, handler: () => Promise<Response>) => handler());
  });

  it("fails closed for an anonymous request", async () => {
    mocks.requireAuth.mockResolvedValue({ session: null, response: new Response("unauthorized", { status: 401 }) });
    const response = await GET();
    expect(response.status).toBe(401);
    expect(mocks.listOwn).not.toHaveBeenCalled();
  });

  it("lists only the authenticated learner's candidates and certificates", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.listOwn).toHaveBeenCalledWith(learnerId);
    expect(mocks.listCandidates).toHaveBeenCalledWith(learnerId);
  });

  it("binds issuance to the session owner and rejects an IDOR-shaped userId", async () => {
    const denied = await POST(request({ requestId, enrollmentId, userId: "another-learner" }));
    expect(denied.status).toBe(400);
    expect(mocks.issue).not.toHaveBeenCalled();

    const accepted = await POST(request({ requestId, enrollmentId }));
    expect(accepted.status).toBe(201);
    expect(mocks.issue).toHaveBeenCalledWith({ userId: learnerId, requestId, enrollmentId });
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      { policy: "certificate_issue_user", identity: { kind: "user", value: learnerId } },
      expect.any(Function),
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: learnerId,
      subjectUserId: learnerId,
      action: "certificate.issue",
    }));
  });

  it("reports failed eligibility without issuing or leaking evidence", async () => {
    mocks.issue.mockRejectedValue(new CertificateError("NOT_ELIGIBLE"));
    const response = await POST(request({ requestId, enrollmentId }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "NOT_ELIGIBLE" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
  });

  it("fails closed before issuance when the pre-mutation audit is unavailable", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request({ requestId, enrollmentId }));
    expect(response.status).toBe(503);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("returns committed success with a reconciliation warning when completion audit fails", async () => {
    mocks.audit.mockResolvedValueOnce({ eventHash: "pre" }).mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request({ requestId, enrollmentId }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ completionAuditRecorded: false, warning: expect.stringContaining("Do not repeat") });
    expect(mocks.issue).toHaveBeenCalledTimes(1);
  });
});
