import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "learner-1";
const ADMIN_ID = "admin-1";
const ENROLLMENT_ID = "a1000000-0000-4000-8000-000000000001";
const REQUEST_ID = "a2000000-0000-4000-8000-000000000001";
const CERTIFICATE_ID = "a3000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => {
  const state = {
    actorRole: "learner",
    eligible: true,
    receiptHash: null as string | null,
    priorRevocation: false,
    existingCertificateForEnrollment: false,
    conceptsMastered: true,
    certificateForRevokeExists: true,
    alreadyRevoked: false,
    failNextInsertWith: null as string | null,
  };
  const privateRow = () => ({
    id: "a3000000-0000-4000-8000-000000000001",
    verification_id: "A_very_long_random_verification_token_1234567890",
    learner_display_name: "Safe Learner",
    course_title: "Python foundations",
    course_version_label: "1.0.0",
    policy_version: "verified-course-certificate-2026-07-14.v1",
    issued_at: new Date("2026-07-14T00:00:00.000Z"),
    revoked_at: null,
    revocation_reason: null,
  });
  const query = vi.fn(async (statement: string) => {
    const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql.includes('select role,status from "user"')) {
      return { rows: [{ role: state.actorRole, status: "active" }], rowCount: 1 };
    }
    if (sql.includes("from certificate_operation_receipt") && sql.includes("select input_hash")) {
      return state.receiptHash
        ? { rows: [{ input_hash: state.receiptHash, certificate_id: CERTIFICATE_ID }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("select enrollment.id enrollment_id")) {
      return state.eligible ? { rows: [{
        enrollment_id: ENROLLMENT_ID,
        enrollment_status: "completed",
        completed_at: new Date("2026-07-13T00:00:00.000Z"),
        user_id: USER_ID,
        learner_name: "Safe Learner",
        learner_status: "active",
        learner_role: "learner",
        course_id: "a4000000-0000-4000-8000-000000000001",
        course_slug: "python-foundations",
        course_title: "Python foundations",
        course_version_id: "a5000000-0000-4000-8000-000000000001",
        course_version: "1.0.0",
        stage: "verified",
        content_hash: "b".repeat(64),
        publication_revision: 3,
        published_at: new Date("2026-07-01T00:00:00.000Z"),
        approved_by: ADMIN_ID,
        pointer_version: 2,
        release_evidence_id: "a6000000-0000-4000-8000-000000000001",
        release_evidence_version: 1,
        release_evidence_hash: "c".repeat(64),
        artifact_count: 2,
        unapproved_count: 0,
      }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("with covered as")) {
      return { rows: [{
        concept_id: "a7000000-0000-4000-8000-000000000001",
        slug: "python.variables",
        critical: true,
        status: state.conceptsMastered ? "mastered" : "learning",
        critical_requirements_met: state.conceptsMastered,
        mastery_policy_version: "mastery-v1",
        evidence_ids: state.conceptsMastered ? ["a8000000-0000-4000-8000-000000000001"] : [],
      }], rowCount: 1 };
    }
    if (sql.startsWith("select id from course_certificate where enrollment_id")) {
      return state.existingCertificateForEnrollment
        ? { rows: [{ id: CERTIFICATE_ID }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("insert into course_certificate")) {
      if (state.failNextInsertWith) {
        const code = state.failNextInsertWith;
        state.failNextInsertWith = null;
        throw Object.assign(new Error("simulated write failure"), { code });
      }
      return { rows: [{ id: CERTIFICATE_ID }], rowCount: 1 };
    }
    if (sql.startsWith("select certificate.id") && sql.includes("where certificate.id=$1")) {
      return { rows: [privateRow()], rowCount: 1 };
    }
    if (sql.startsWith("select certificate_id,reason,evidence_hash,revoked_at")) {
      return state.priorRevocation ? { rows: [{
        certificate_id: CERTIFICATE_ID,
        reason: "Verified integrity correction",
        evidence_hash: hashSocialEvidence({
          certificateId: CERTIFICATE_ID,
          requestId: REQUEST_ID,
          reason: "Verified integrity correction",
        }),
        revoked_at: new Date("2026-07-14T01:00:00.000Z"),
      }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("select id from course_certificate where id=$1")) {
      return state.certificateForRevokeExists
        ? { rows: [{ id: CERTIFICATE_ID }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("select 1 from certificate_revocation")) {
      return state.alreadyRevoked ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: vi.fn() };
  return {
    state,
    privateRow,
    query,
    client,
    connect: vi.fn(async () => client),
    poolQuery: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect, query: mocks.poolQuery },
}));

import {
  issueCourseCertificate,
  listAdminCertificates,
  listCertificateCandidates,
  listOwnCertificates,
  loadPublicCertificate,
  revokeCourseCertificate,
} from "../service";
import { hashSocialEvidence } from "@/lib/social/hash";

describe("certificate evidence service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.actorRole = "learner";
    mocks.state.eligible = true;
    mocks.state.receiptHash = null;
    mocks.state.priorRevocation = false;
    mocks.state.existingCertificateForEnrollment = false;
    mocks.state.conceptsMastered = true;
    mocks.state.certificateForRevokeExists = true;
    mocks.state.alreadyRevoked = false;
    mocks.state.failNextInsertWith = null;
  });

  it("issues only after owner-bound current-version eligibility and mastery evidence", async () => {
    const result = await issueCourseCertificate({
      userId: USER_ID,
      enrollmentId: ENROLLMENT_ID,
      requestId: REQUEST_ID,
      verificationId: "A_very_long_random_verification_token_1234567890",
      now: new Date("2026-07-14T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ replayed: false, certificate: { id: CERTIFICATE_ID, status: "valid" } });
    const sql = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(sql.findIndex((statement) => statement.includes("pg_advisory_xact_lock")))
      .toBeLessThan(sql.findIndex((statement) => statement.includes("select enrollment.id enrollment_id")));
    expect(sql.some((statement) => statement.includes("with covered as"))).toBe(true);
    expect(sql.some((statement) => statement.includes("insert into course_certificate"))).toBe(true);
    expect(sql.at(-1)).toBe("commit");
  });

  it("rejects an enrollment that is not owned and eligible", async () => {
    mocks.state.eligible = false;
    await expect(issueCourseCertificate({ userId: USER_ID, enrollmentId: ENROLLMENT_ID, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.query.mock.calls.some(([statement]) => String(statement).includes("insert into course_certificate"))).toBe(false);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("replays the same issuance receipt without a second certificate insert", async () => {
    mocks.state.receiptHash = hashSocialEvidence({
      operation: "issue",
      userId: USER_ID,
      enrollmentId: ENROLLMENT_ID,
      requestId: REQUEST_ID,
      policyVersion: "verified-course-certificate-2026-07-14.v1",
    });
    const result = await issueCourseCertificate({ userId: USER_ID, enrollmentId: ENROLLMENT_ID, requestId: REQUEST_ID });
    expect(result.replayed).toBe(true);
    expect(mocks.query.mock.calls.some(([statement]) => String(statement).includes("insert into course_certificate"))).toBe(false);
  });

  it("fails a reused request id with different canonical input", async () => {
    mocks.state.receiptHash = "f".repeat(64);
    await expect(issueCourseCertificate({ userId: USER_ID, enrollmentId: ENROLLMENT_ID, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("allows only an active administrator to append a private revocation", async () => {
    mocks.state.actorRole = "admin";
    await expect(revokeCourseCertificate({
      actorUserId: ADMIN_ID,
      certificateId: CERTIFICATE_ID,
      requestId: REQUEST_ID,
      reason: "Verified integrity correction",
      now: new Date("2026-07-14T01:00:00.000Z"),
    })).resolves.toMatchObject({ certificateId: CERTIFICATE_ID, replayed: false });
    expect(mocks.query.mock.calls.some(([statement]) => String(statement).includes("insert into certificate_revocation"))).toBe(true);

    vi.clearAllMocks();
    mocks.state.actorRole = "learner";
    await expect(revokeCourseCertificate({
      actorUserId: USER_ID, certificateId: CERTIFICATE_ID, requestId: REQUEST_ID,
      reason: "Learner cannot revoke this evidence",
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("projects a strict public allowlist and withholds the revocation reason", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{
      ...mocks.privateRow(),
      revoked_at: new Date("2026-07-14T01:00:00.000Z"),
      revocation_reason: null,
      learner_email: "must-not-leak@example.test",
      evidence_hash: "must-not-leak",
    }] });
    const publicRecord = await loadPublicCertificate("A_very_long_random_verification_token_1234567890");
    expect(Object.keys(publicRecord).sort()).toEqual([
      "courseTitle", "courseVersion", "issuedAt", "learnerDisplayName", "revokedAt",
      "statement", "status", "verificationId",
    ]);
    expect(JSON.stringify(publicRecord)).not.toMatch(/must-not-leak|verified integrity correction|learner_email|evidence_hash|policy_version|enrollment_id|user_id/i);
    expect(publicRecord.status).toBe("revoked");
  });

  it("rejects a malformed issue request before opening a connection", async () => {
    await expect(issueCourseCertificate({ userId: USER_ID, enrollmentId: "not-a-uuid", requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects a malformed revoke request before opening a connection", async () => {
    await expect(revokeCourseCertificate({ actorUserId: ADMIN_ID, certificateId: CERTIFICATE_ID, requestId: REQUEST_ID, reason: "short" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("reuses an existing certificate for the enrollment instead of issuing a second one", async () => {
    mocks.state.existingCertificateForEnrollment = true;
    const result = await issueCourseCertificate({ userId: USER_ID, enrollmentId: ENROLLMENT_ID, requestId: REQUEST_ID });

    expect(result).toMatchObject({ replayed: false, reusedExisting: true, certificate: { id: CERTIFICATE_ID } });
    expect(mocks.query.mock.calls.some(([statement]) => String(statement).includes("insert into course_certificate"))).toBe(false);
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("rejects issuance when a covered concept lacks complete mastery evidence", async () => {
    mocks.state.conceptsMastered = false;
    await expect(issueCourseCertificate({ userId: USER_ID, enrollmentId: ENROLLMENT_ID, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("maps a unique-constraint violation on insert to WRITE_CONFLICT", async () => {
    mocks.state.failNextInsertWith = "23505";
    await expect(issueCourseCertificate({ userId: USER_ID, enrollmentId: ENROLLMENT_ID, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "WRITE_CONFLICT" });
  });

  it("maps a check-constraint violation on insert to NOT_ELIGIBLE", async () => {
    mocks.state.failNextInsertWith = "23514";
    await expect(issueCourseCertificate({ userId: USER_ID, enrollmentId: ENROLLMENT_ID, requestId: REQUEST_ID }))
      .rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("rejects revocation of a certificate that does not exist", async () => {
    mocks.state.actorRole = "admin";
    mocks.state.certificateForRevokeExists = false;
    await expect(revokeCourseCertificate({
      actorUserId: ADMIN_ID, certificateId: CERTIFICATE_ID, requestId: REQUEST_ID,
      reason: "Verified integrity correction",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects revoking a certificate that already has a revocation row", async () => {
    mocks.state.actorRole = "admin";
    mocks.state.alreadyRevoked = true;
    await expect(revokeCourseCertificate({
      actorUserId: ADMIN_ID, certificateId: CERTIFICATE_ID, requestId: REQUEST_ID,
      reason: "Verified integrity correction",
    })).rejects.toMatchObject({ code: "ALREADY_REVOKED" });
  });

  it("replays an identical prior revocation request without a second insert", async () => {
    mocks.state.actorRole = "admin";
    mocks.state.priorRevocation = true;
    const result = await revokeCourseCertificate({
      actorUserId: ADMIN_ID, certificateId: CERTIFICATE_ID, requestId: REQUEST_ID,
      reason: "Verified integrity correction",
    });
    expect(result).toMatchObject({ certificateId: CERTIFICATE_ID, replayed: true });
    expect(mocks.query.mock.calls.some(([statement]) => String(statement).includes("insert into certificate_revocation"))).toBe(false);
  });

  it("rejects a reused revocation request id bound to different inputs", async () => {
    mocks.state.actorRole = "admin";
    mocks.state.priorRevocation = true;
    await expect(revokeCourseCertificate({
      actorUserId: ADMIN_ID, certificateId: CERTIFICATE_ID, requestId: REQUEST_ID,
      reason: "A completely different reason than before.",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("rejects a malformed verification id without querying the database", async () => {
    await expect(loadPublicCertificate("short")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when no public certificate matches the verification id", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(loadPublicCertificate("A_very_long_random_verification_token_1234567890"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists a learner's own certificates with a valid status when not revoked", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [mocks.privateRow()] });
    const certificates = await listOwnCertificates(USER_ID);
    expect(certificates[0]).toMatchObject({ id: CERTIFICATE_ID, status: "valid" });
  });

  it("lists every certificate for administrators including the learner email", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ ...mocks.privateRow(), learner_email: "learner@example.test" }] });
    const certificates = await listAdminCertificates();
    expect(certificates[0]).toMatchObject({ learnerEmail: "learner@example.test" });
  });

  it("explains why a certificate candidate is or is not eligible", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        { enrollment_id: "e1", course_title: "Python", course_version: "1.0.0", enrollment_status: "completed", completed_at: new Date(), stage: "verified", is_current: true, artifact_count: 3, unapproved_count: 0, concept_count: 4, mastered_count: 4, certificate_id: null },
        { enrollment_id: "e2", course_title: "JavaScript", course_version: "1.0.0", enrollment_status: "in_progress", completed_at: null, stage: "verified", is_current: true, artifact_count: 3, unapproved_count: 0, concept_count: 4, mastered_count: 4, certificate_id: null },
      ],
    });
    const candidates = await listCertificateCandidates(USER_ID);
    expect(candidates[0]).toMatchObject({ eligible: true, alreadyIssued: false });
    expect(candidates[1]).toMatchObject({ eligible: false, reason: "Complete this course first." });
  });
});
