import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.poolQuery, connect: mocks.connect } }));

import {
  issueCourseCertificate,
  listAdminCertificates,
  listCertificateCandidates,
  listOwnCertificates,
  loadPublicCertificate,
  revokeCourseCertificate,
} from "../service";

const userId = "10000000-0000-4000-8000-000000000001";
const enrollmentId = "20000000-0000-4000-8000-000000000001";
const requestId = "30000000-0000-4000-8000-000000000001";
const certificateId = "40000000-0000-4000-8000-000000000001";
const courseVersionId = "50000000-0000-4000-8000-000000000001";

function certificateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: certificateId,
    verification_id: "verification-id-placeholder-000000000000000000",
    learner_display_name: "Learner",
    course_title: "Python",
    course_version_label: "1.0.0",
    policy_version: "verified-course-certificate-2026-07-14.v1",
    issued_at: new Date("2026-07-12T00:00:00.000Z"),
    revoked_at: null,
    revocation_reason: null,
    ...overrides,
  };
}

function eligibilityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enrollment_id: enrollmentId,
    enrollment_status: "completed",
    completed_at: new Date("2026-07-11T00:00:00.000Z"),
    user_id: userId,
    learner_name: "Learner",
    learner_status: "active",
    learner_role: "learner",
    course_id: "course-1",
    course_slug: "python",
    course_title: "Python",
    course_version_id: courseVersionId,
    course_version: "1.0.0",
    stage: "verified",
    content_hash: "a".repeat(64),
    publication_revision: 2,
    published_at: new Date("2026-07-10T00:00:00.000Z"),
    approved_by: "admin-1",
    pointer_version: 1,
    release_evidence_id: "evidence-1",
    release_evidence_version: 1,
    release_evidence_hash: "b".repeat(64),
    artifact_count: 3,
    unapproved_count: 0,
    ...overrides,
  };
}

function conceptRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    concept_id: "concept-1",
    slug: "concept-1",
    critical: true,
    status: "mastered",
    critical_requirements_met: true,
    mastery_policy_version: "adaptive-learning-v1",
    evidence_ids: ["evidence-1"],
    ...overrides,
  };
}

function fakeClient(handlers: Record<string, unknown[] | ((text: string, values?: unknown[]) => unknown[])>) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const normalized = text.replace(/\s+/g, " ");
      const key = Object.keys(handlers).find((candidate) => normalized.includes(candidate));
      if (!key) return { rows: [] };
      const handler = handlers[key]!;
      const rows = typeof handler === "function" ? handler(text, values) : handler;
      return { rows };
    }),
    release: vi.fn(),
  };
  return { client, calls };
}

describe("issueCourseCertificate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed request before opening a connection", async () => {
    await expect(issueCourseCertificate({ userId, enrollmentId: "not-a-uuid", requestId }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the account is not an active learner", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [],
    });
    mocks.connect.mockResolvedValue(client);

    await expect(issueCourseCertificate({ userId, enrollmentId, requestId }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(client.query).toHaveBeenCalledWith("rollback");
  });

  it("replays an identical prior request without re-inserting", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from certificate_operation_receipt": (_text, values) => {
        const [, reqId] = values as [string, string];
        return reqId === requestId ? [{ input_hash: "will-be-overwritten", certificate_id: certificateId }] : [];
      },
      "from course_certificate certificate": [certificateRow()],
    });
    mocks.connect.mockResolvedValue(client);

    // First call establishes the real hash so the replay path can match it.
    const firstAttempt = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from certificate_operation_receipt": [],
      "from enrollment": [eligibilityRow()],
      "select id from course_certificate where enrollment_id": [],
      "with covered as": [conceptRow()],
      "insert into course_certificate": [{ id: certificateId }],
      "from course_certificate certificate": [certificateRow()],
    });
    mocks.connect.mockResolvedValueOnce(firstAttempt.client);
    const first = await issueCourseCertificate({ userId, enrollmentId, requestId });
    expect(first.replayed).toBe(false);

    const insertReceiptCall = firstAttempt.calls.find((call) => call.text.includes("insert into certificate_operation_receipt"));
    const realHash = (insertReceiptCall!.values as unknown[])[2] as string;

    const replay = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from certificate_operation_receipt": [{ input_hash: realHash, certificate_id: certificateId }],
      "from course_certificate certificate": [certificateRow()],
    });
    mocks.connect.mockResolvedValueOnce(replay.client);
    const second = await issueCourseCertificate({ userId, enrollmentId, requestId });
    expect(second.replayed).toBe(true);
    expect(second.certificate.id).toBe(certificateId);
  });

  it("throws IDEMPOTENCY_MISMATCH when the same request id is reused with different inputs", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from certificate_operation_receipt": [{ input_hash: "a-completely-different-hash", certificate_id: certificateId }],
    });
    mocks.connect.mockResolvedValue(client);

    await expect(issueCourseCertificate({ userId, enrollmentId, requestId }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("throws NOT_ELIGIBLE when the eligibility row does not meet every requirement", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from certificate_operation_receipt": [],
      "from enrollment": [eligibilityRow({ unapproved_count: 1 })],
    });
    mocks.connect.mockResolvedValue(client);

    await expect(issueCourseCertificate({ userId, enrollmentId, requestId }))
      .rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("reuses an existing certificate for the enrollment instead of issuing a second one", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from certificate_operation_receipt": [],
      "from enrollment": [eligibilityRow()],
      "select id from course_certificate where enrollment_id": [{ id: certificateId }],
      "from course_certificate certificate": [certificateRow()],
    });
    mocks.connect.mockResolvedValue(client);

    const result = await issueCourseCertificate({ userId, enrollmentId, requestId });

    expect(result).toMatchObject({ replayed: false, reusedExisting: true });
    expect(client.query).toHaveBeenCalledWith("commit");
  });

  it("throws NOT_ELIGIBLE when covered concepts lack complete mastery evidence", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from certificate_operation_receipt": [],
      "from enrollment": [eligibilityRow()],
      "select id from course_certificate where enrollment_id": [],
      "with covered as": [conceptRow({ status: "learning" })],
    });
    mocks.connect.mockResolvedValue(client);

    await expect(issueCourseCertificate({ userId, enrollmentId, requestId }))
      .rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("maps a unique-constraint violation to WRITE_CONFLICT and rolls back", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from certificate_operation_receipt": [],
      "from enrollment": [eligibilityRow()],
      "select id from course_certificate where enrollment_id": [],
      "with covered as": [conceptRow()],
      "insert into course_certificate": () => { throw Object.assign(new Error("duplicate"), { code: "23505" }); },
    });
    mocks.connect.mockResolvedValue(client);

    await expect(issueCourseCertificate({ userId, enrollmentId, requestId }))
      .rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(client.query).toHaveBeenCalledWith("rollback");
  });
});

describe("read-only certificate listings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps a learner's own certificates to their public shape", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [certificateRow()] });

    const certificates = await listOwnCertificates(userId);

    expect(certificates[0]).toMatchObject({ id: certificateId, status: "valid", verificationPath: expect.stringContaining("/verify/") });
  });

  it("marks a revoked certificate's status accordingly", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [certificateRow({ revoked_at: new Date("2026-07-13T00:00:00.000Z"), revocation_reason: "Policy violation." })] });

    const certificates = await listOwnCertificates(userId);

    expect(certificates[0]).toMatchObject({ status: "revoked", revocationReason: "Policy violation." });
  });

  it("explains why each certificate candidate is or is not eligible", async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        { enrollment_id: "e1", course_title: "Python", course_version: "1.0.0", enrollment_status: "in_progress", completed_at: null, stage: "verified", is_current: true, artifact_count: 3, unapproved_count: 0, concept_count: 4, mastered_count: 4, certificate_id: null },
        { enrollment_id: "e2", course_title: "JavaScript", course_version: "1.0.0", enrollment_status: "completed", completed_at: new Date(), stage: "beta", is_current: true, artifact_count: 3, unapproved_count: 0, concept_count: 4, mastered_count: 4, certificate_id: null },
        { enrollment_id: "e3", course_title: "Go", course_version: "1.0.0", enrollment_status: "completed", completed_at: new Date(), stage: "verified", is_current: true, artifact_count: 3, unapproved_count: 0, concept_count: 0, mastered_count: 0, certificate_id: null },
        { enrollment_id: "e4", course_title: "Rust", course_version: "1.0.0", enrollment_status: "completed", completed_at: new Date(), stage: "verified", is_current: true, artifact_count: 3, unapproved_count: 0, concept_count: 4, mastered_count: 2, certificate_id: null },
        { enrollment_id: "e5", course_title: "Ruby", course_version: "1.0.0", enrollment_status: "completed", completed_at: new Date(), stage: "verified", is_current: true, artifact_count: 3, unapproved_count: 0, concept_count: 4, mastered_count: 4, certificate_id: certificateId },
      ],
    });

    const candidates = await listCertificateCandidates(userId);

    expect(candidates[0]).toMatchObject({ eligible: false, reason: "Complete this course first." });
    expect(candidates[1]).toMatchObject({ eligible: false, reason: expect.stringContaining("not the current verified publication") });
    expect(candidates[2]).toMatchObject({ eligible: false, reason: expect.stringContaining("no certificate-eligible concept map") });
    expect(candidates[3]).toMatchObject({ eligible: false, reason: "2 of 4 covered concepts have mastered, valid evidence." });
    expect(candidates[4]).toMatchObject({ eligible: true, alreadyIssued: true });
  });

  it("lists every certificate with the learner's email for administrators", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ ...certificateRow(), learner_email: "learner@example.test" }] });

    const certificates = await listAdminCertificates();

    expect(certificates[0]).toMatchObject({ learnerEmail: "learner@example.test" });
  });
});

describe("loadPublicCertificate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed verification id without querying the database", async () => {
    await expect(loadPublicCertificate("short")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when no certificate matches", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });

    await expect(loadPublicCertificate("v".repeat(40))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("describes a valid certificate without exposing a revocation reason", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [certificateRow()] });

    const result = await loadPublicCertificate("v".repeat(40));

    expect(result.status).toBe("valid");
    expect(result.statement).toContain("immutable certificate");
  });

  it("describes a revoked certificate without exposing the private reason", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [certificateRow({ revoked_at: new Date("2026-07-13T00:00:00.000Z") })] });

    const result = await loadPublicCertificate("v".repeat(40));

    expect(result.status).toBe("revoked");
    expect(result.statement).not.toContain("Policy violation");
    expect(result.statement).toContain("revoked");
  });
});

describe("revokeCourseCertificate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed request before opening a connection", async () => {
    await expect(revokeCourseCertificate({ actorUserId: userId, certificateId, requestId, reason: "short" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("requires an active administrator", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
    });
    mocks.connect.mockResolvedValue(client);

    await expect(revokeCourseCertificate({ actorUserId: userId, certificateId, requestId, reason: "Policy violation observed." }))
      .rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("throws NOT_FOUND when the certificate does not exist", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "admin", status: "active" }],
      "from certificate_revocation where revoked_by": [],
      "from course_certificate where id=$1 for update": [],
    });
    mocks.connect.mockResolvedValue(client);

    await expect(revokeCourseCertificate({ actorUserId: userId, certificateId, requestId, reason: "Policy violation observed." }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws ALREADY_REVOKED for a certificate that already has a revocation row", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "admin", status: "active" }],
      "from certificate_revocation where revoked_by": [],
      "from course_certificate where id=$1 for update": [{ id: certificateId }],
      "select 1 from certificate_revocation where certificate_id": [{ "?column?": 1 }],
    });
    mocks.connect.mockResolvedValue(client);

    await expect(revokeCourseCertificate({ actorUserId: userId, certificateId, requestId, reason: "Policy violation observed." }))
      .rejects.toMatchObject({ code: "ALREADY_REVOKED" });
  });

  it("revokes the certificate and commits", async () => {
    const { client } = fakeClient({
      'from "user" where id=$1 for update': [{ role: "admin", status: "active" }],
      "from certificate_revocation where revoked_by": [],
      "from course_certificate where id=$1 for update": [{ id: certificateId }],
      "select 1 from certificate_revocation where certificate_id": [],
    });
    mocks.connect.mockResolvedValue(client);

    const result = await revokeCourseCertificate({ actorUserId: userId, certificateId, requestId, reason: "Policy violation observed." });

    expect(result).toMatchObject({ certificateId, replayed: false });
    expect(client.query).toHaveBeenCalledWith("commit");
  });

  it("replays an identical prior revocation request", async () => {
    const revokedAt = new Date("2026-07-13T00:00:00.000Z");
    const reason = "Policy violation observed.";

    // Compute the real evidence hash first via a successful run, then confirm replay matches it.
    const firstRun = fakeClient({
      'from "user" where id=$1 for update': [{ role: "admin", status: "active" }],
      "from certificate_revocation where revoked_by": [],
      "from course_certificate where id=$1 for update": [{ id: certificateId }],
      "select 1 from certificate_revocation where certificate_id": [],
    });
    mocks.connect.mockResolvedValueOnce(firstRun.client);
    await revokeCourseCertificate({ actorUserId: userId, certificateId, requestId, reason });
    const insertCall = firstRun.calls.find((call) => call.text.includes("insert into certificate_revocation"));
    const realHash = (insertCall!.values as unknown[])[4] as string;

    const replay = fakeClient({
      'from "user" where id=$1 for update': [{ role: "admin", status: "active" }],
      "from certificate_revocation where revoked_by": [{ certificate_id: certificateId, reason, evidence_hash: realHash, revoked_at: revokedAt }],
    });
    mocks.connect.mockResolvedValueOnce(replay.client);
    const result = await revokeCourseCertificate({ actorUserId: userId, certificateId, requestId, reason });

    expect(result).toMatchObject({ replayed: true, revokedAt: revokedAt.toISOString() });
  });
});
