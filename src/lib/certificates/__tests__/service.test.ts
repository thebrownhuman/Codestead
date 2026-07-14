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
        status: "mastered",
        critical_requirements_met: true,
        mastery_policy_version: "mastery-v1",
        evidence_ids: ["a8000000-0000-4000-8000-000000000001"],
      }], rowCount: 1 };
    }
    if (sql.startsWith("select id from course_certificate where enrollment_id")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("insert into course_certificate")) return { rows: [{ id: CERTIFICATE_ID }], rowCount: 1 };
    if (sql.startsWith("select certificate.id") && sql.includes("where certificate.id=$1")) {
      return { rows: [privateRow()], rowCount: 1 };
    }
    if (sql.startsWith("select certificate_id,reason,evidence_hash,revoked_at")) {
      return state.priorRevocation ? { rows: [{
        certificate_id: CERTIFICATE_ID,
        reason: "Verified integrity correction",
        evidence_hash: "unused",
        revoked_at: new Date("2026-07-14T01:00:00.000Z"),
      }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("select id from course_certificate where id=$1")) return { rows: [{ id: CERTIFICATE_ID }], rowCount: 1 };
    if (sql.startsWith("select 1 from certificate_revocation")) return { rows: [], rowCount: 0 };
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
});
