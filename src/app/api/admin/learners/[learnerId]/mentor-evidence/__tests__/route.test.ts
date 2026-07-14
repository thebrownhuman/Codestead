import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return {
    limit,
    select: vi.fn(() => ({ from })),
    requireAdmin: vi.fn(),
    resolveMentorLearner: vi.fn(),
    readMentorEvidence: vi.fn(),
    writeAuditEvent: vi.fn(),
    authorizePrivilegedAction: vi.fn(),
    withRateLimit: vi.fn(async (_check, handler: () => Promise<Response>) => handler()),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-mentor/evidence-reader", () => ({
  MentorEvidenceError: class MentorEvidenceError extends Error {
    constructor(public readonly code: string) { super(code); }
  },
  resolveMentorLearner: mocks.resolveMentorLearner,
  readMentorEvidence: mocks.readMentorEvidence,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));
vi.mock("@/lib/security/privileged-access", () => ({ authorizePrivilegedAction: mocks.authorizePrivilegedAction }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { POST } from "../route";

const LEARNER_PUBLIC_ID = "11000000-0000-4000-8000-000000000001";
const REQUEST_ID = "12000000-0000-4000-8000-000000000001";
const validBody = {
  requestId: REQUEST_ID,
  category: "chats",
  purpose: "learning_support",
  reason: "Review the learner's loop misconception before assigning focused remediation.",
  limit: 5,
};

function request(payload: unknown = validBody) {
  return new NextRequest(`https://learn.test/api/admin/learners/${LEARNER_PUBLIC_ID}/mentor-evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function context(learnerId = LEARNER_PUBLIC_ID) {
  return { params: Promise.resolve({ learnerId }) };
}

describe("audited mentor evidence read route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue([{ mfaVerifiedAt: new Date() }]);
    mocks.requireAdmin.mockResolvedValue({
      session: { user: { id: "admin-1" }, session: { id: "admin-session" } },
      account: { role: "admin" },
      response: null,
    });
    mocks.resolveMentorLearner.mockResolvedValue({
      id: "learner-internal-1",
      public_id: LEARNER_PUBLIC_ID,
      name: "Asha Learner",
    });
    mocks.authorizePrivilegedAction.mockReturnValue({ allowed: true, code: "AUTHORIZED" });
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: REQUEST_ID, eventHash: "a".repeat(64) });
    mocks.readMentorEvidence.mockResolvedValue({
      category: "chats",
      items: [{ id: "13000000-0000-4000-8000-000000000001", role: "user", content: "Explain loops." }],
      page: { limit: 5, hasMore: false, nextCursor: null },
      safeguards: {
        responseBytes: 100,
        responseByteLimit: 131_072,
        perItemByteLimit: 49_152,
        truncatedItemCount: 0,
        hiddenAssessmentEvidenceIncluded: false,
        credentialOrSessionEvidenceIncluded: false,
        deviceOrIpEvidenceIncluded: false,
      },
    });
  });

  it("requires administrator authentication and never reads evidence anonymously", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Administrator access required." }, { status: 403 }),
    });
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.readMentorEvidence).not.toHaveBeenCalled();
  });

  it("strictly rejects missing purpose, short reason, unknown category, extra fields, and query-free invalid learners", async () => {
    for (const [payload, learnerId] of [
      [{ ...validBody, purpose: undefined }, LEARNER_PUBLIC_ID],
      [{ ...validBody, reason: "short" }, LEARNER_PUBLIC_ID],
      [{ ...validBody, category: "provider_keys" }, LEARNER_PUBLIC_ID],
      [{ ...validBody, unexpected: true }, LEARNER_PUBLIC_ID],
      [validBody, "learner-internal-1"],
    ] as const) {
      const response = await POST(request(payload), context(learnerId));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(mocks.readMentorEvidence).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "mentor.evidence.read",
      outcome: "denied",
      metadata: { code: "INVALID_REQUEST" },
    }));
  });

  it("requires fresh MFA after resolving only the selected path learner and audits denial", async () => {
    mocks.authorizePrivilegedAction.mockReturnValueOnce({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    const response = await POST(request(), context());
    expect(response.status).toBe(403);
    expect(mocks.readMentorEvidence).not.toHaveBeenCalled();
    expect(mocks.authorizePrivilegedAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "mentor.evidence.read",
      reason: validBody.reason,
    }));
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      subjectUserId: "learner-internal-1",
      resourceId: LEARNER_PUBLIC_ID,
      action: "mentor.evidence.read",
      outcome: "denied",
      correlationId: REQUEST_ID,
      metadata: expect.objectContaining({ category: "chats", purpose: "learning_support", code: "FRESH_MFA_REQUIRED" }),
    }));
  });

  it("passes only the selected learner, body category, bounded cursor/page and audits before disclosure", async () => {
    const payload = { ...validBody, category: "code_submissions", cursor: "safe-cursor", limit: 3 };
    const response = await POST(request(payload), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.readMentorEvidence).toHaveBeenCalledWith({
      learnerUserId: "learner-internal-1",
      category: "code_submissions",
      cursor: "safe-cursor",
      limit: 3,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1",
      subjectUserId: "learner-internal-1",
      action: "mentor.evidence.read",
      resourceType: "learner_evidence",
      resourceId: LEARNER_PUBLIC_ID,
      reason: validBody.reason,
      outcome: "success",
      correlationId: REQUEST_ID,
      metadata: expect.objectContaining({ category: "code_submissions", purpose: "learning_support", itemCount: 1 }),
    }));
    const json = await response.json();
    expect(json.evidence.items).toHaveLength(1);
    expect(json.autoClearSeconds).toBe(300);
  });

  it("returns a bounded oversized item with its usable continuation cursor and audits truncation", async () => {
    mocks.readMentorEvidence
      .mockResolvedValueOnce({
        category: "exams",
        items: [{
          id: "13000000-0000-4000-8000-000000000009",
          mentorPayloadTruncated: true,
          mentorOriginalPayloadBytes: 420_000,
          mentorPayloadByteLimit: 49_152,
        }],
        page: { limit: 1, hasMore: true, nextCursor: "bounded-next-cursor" },
        safeguards: {
          responseBytes: 180,
          responseByteLimit: 131_072,
          perItemByteLimit: 49_152,
          truncatedItemCount: 1,
          hiddenAssessmentEvidenceIncluded: false,
          credentialOrSessionEvidenceIncluded: false,
          deviceOrIpEvidenceIncluded: false,
        },
      })
      .mockResolvedValueOnce({
        category: "exams",
        items: [{ id: "13000000-0000-4000-8000-000000000010", attemptId: "small-older-attempt" }],
        page: { limit: 1, hasMore: false, nextCursor: null },
        safeguards: {
          responseBytes: 100,
          responseByteLimit: 131_072,
          perItemByteLimit: 49_152,
          truncatedItemCount: 0,
          hiddenAssessmentEvidenceIncluded: false,
          credentialOrSessionEvidenceIncluded: false,
          deviceOrIpEvidenceIncluded: false,
        },
      });

    const response = await POST(request({ ...validBody, category: "exams", limit: 1 }), context());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.evidence.page).toEqual({ limit: 1, hasMore: true, nextCursor: "bounded-next-cursor" });
    expect(json.evidence.safeguards).toMatchObject({
      perItemByteLimit: 49_152,
      truncatedItemCount: 1,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "mentor.evidence.read",
      outcome: "success",
      metadata: expect.objectContaining({
        category: "exams",
        itemCount: 1,
        hasMore: true,
        truncatedItemCount: 1,
      }),
    }));

    const secondResponse = await POST(request({
      ...validBody,
      requestId: "12000000-0000-4000-8000-000000000002",
      category: "exams",
      cursor: "bounded-next-cursor",
      limit: 1,
    }), context());
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      evidence: {
        items: [{ attemptId: "small-older-attempt" }],
        page: { hasMore: false, nextCursor: null },
      },
    });
    expect(mocks.readMentorEvidence).toHaveBeenLastCalledWith({
      learnerUserId: "learner-internal-1",
      category: "exams",
      cursor: "bounded-next-cursor",
      limit: 1,
    });
  });

  it("fails closed and withholds already-read content when the disclosure audit cannot be written", async () => {
    mocks.writeAuditEvent.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(request(), context());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("Explain loops");
  });

  it("audits rate-limited reads without invoking the evidence reader", async () => {
    mocks.withRateLimit.mockImplementationOnce(async () => NextResponse.json(
      { error: "Too many requests.", code: "RATE_LIMITED" },
      { status: 429 },
    ));
    const response = await POST(request(), context());
    expect(response.status).toBe(429);
    expect(mocks.readMentorEvidence).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "mentor.evidence.read",
      outcome: "denied",
      metadata: expect.objectContaining({ code: "RATE_LIMITED" }),
    }));
  });
});
