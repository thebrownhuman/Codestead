import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  authorizeAssessmentCorrection: vi.fn(),
  createAssessmentCorrection: vi.fn(),
  listAssessmentCorrections: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("../authorization", () => ({ authorizeAssessmentCorrection: mocks.authorizeAssessmentCorrection }));
vi.mock("@/lib/assessment-corrections/admin-service", () => ({
  assessmentCorrectionErrorStatus: () => 409,
  createAssessmentCorrection: mocks.createAssessmentCorrection,
  listAssessmentCorrections: mocks.listAssessmentCorrections,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { GET, POST } from "../route";

const appealId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const validBody = {
  requestId,
  appealId,
  itemId: "python.loops.code-1",
  defectKind: "faulty_test",
  reason: "The reviewed hidden oracle incorrectly rejected every valid boundary result.",
  replacementEvidence: {
    kind: "runner-tests",
    bundleVersion: "reviewed-v2",
    runtimeImageDigest: digest,
    tests: [{ id: "hidden-2", visibility: "HIDDEN", category: "edge", stdin: "", expectedStdout: "3\n", comparison: "EXACT", critical: true }],
  },
  review: {
    reviewerKind: "human",
    specificationClarified: true,
    expectedOutputsReviewed: true,
    hiddenTestCoverageReviewed: true,
    pinnedRuntimeReviewed: true,
    evidenceRef: "evidence://review/faulty-loop-test-v2",
    note: "The replacement oracle and pinned runtime digest were manually reviewed against the specification.",
  },
} as const;

function post(body: unknown) {
  return new NextRequest("https://learn.example.test/api/admin/assessment-corrections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("assessment correction collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-user" }, session: { id: "admin-session" } },
      account: { role: "admin" },
    });
    mocks.authorizeAssessmentCorrection.mockResolvedValue({ allowed: true, code: "AUTHORIZED" });
    mocks.createAssessmentCorrection.mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000001",
      affectedCount: 3,
      replayed: false,
    });
    mocks.listAssessmentCorrections.mockResolvedValue([]);
    mocks.writeAuditEvent.mockResolvedValue({});
  });

  it("fails closed before reading or mutating for a non-admin", async () => {
    mocks.requireAdmin.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(post(validBody));
    expect(response.status).toBe(403);
    expect(mocks.createAssessmentCorrection).not.toHaveBeenCalled();
  });

  it("rejects extra fields and malformed replacement evidence", async () => {
    const extra = await POST(post({ ...validBody, learnerId: "attacker-selected" }));
    expect(extra.status).toBe(400);
    const unpinned = await POST(post({ ...validBody, replacementEvidence: { ...validBody.replacementEvidence, runtimeImageDigest: "latest" } }));
    expect(unpinned.status).toBe(400);
    expect(mocks.createAssessmentCorrection).not.toHaveBeenCalled();
  });

  it("requires fresh MFA and records the denied action without exposing tests", async () => {
    mocks.authorizeAssessmentCorrection.mockResolvedValue({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(post(validBody));
    expect(response.status).toBe(403);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "assessment.correction.create",
      resourceId: appealId,
      outcome: "denied",
      metadata: { denialCode: "FRESH_MFA_REQUIRED", itemId: validBody.itemId },
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain("expectedStdout");
  });

  it("binds the reviewed request to the authenticated admin and audits its exact impact count", async () => {
    const response = await POST(post(validBody));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ report: { affectedCount: 3 }, completionAuditRecorded: true });
    expect(mocks.createAssessmentCorrection).toHaveBeenCalledWith({ actorUserId: "admin-user", ...validBody });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "assessment.correction.create",
      resourceType: "assessment_correction",
      outcome: "success",
      metadata: expect.objectContaining({ affectedCount: 3, itemId: validBody.itemId }),
    }));
  });

  it("bounds and validates list queries", async () => {
    const invalid = await GET(new NextRequest("https://learn.example.test/api/admin/assessment-corrections?limit=1000"));
    expect(invalid.status).toBe(400);
    const valid = await GET(new NextRequest("https://learn.example.test/api/admin/assessment-corrections?scope=all&limit=10"));
    expect(valid.status).toBe(200);
    expect(mocks.listAssessmentCorrections).toHaveBeenCalledWith({ scope: "all", limit: 10 });
  });
});
