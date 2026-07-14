import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { hashSocialEvidence } from "@/lib/social/hash";

export const CERTIFICATE_POLICY_VERSION = "verified-course-certificate-2026-07-14.v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFICATION_PATTERN = /^[A-Za-z0-9_-]{32,80}$/;

export class CertificateError extends Error {
  constructor(public readonly code:
    | "NOT_FOUND"
    | "INVALID_REQUEST"
    | "NOT_ELIGIBLE"
    | "IDEMPOTENCY_MISMATCH"
    | "ADMIN_REQUIRED"
    | "ALREADY_REVOKED"
    | "WRITE_CONFLICT") {
    super(code);
  }
}

type EligibilityRow = {
  enrollment_id: string;
  enrollment_status: string;
  completed_at: Date | null;
  user_id: string;
  learner_name: string;
  learner_status: string;
  learner_role: string | null;
  course_id: string;
  course_slug: string;
  course_title: string;
  course_version_id: string;
  course_version: string;
  stage: string;
  content_hash: string;
  publication_revision: string | number;
  published_at: Date | null;
  approved_by: string | null;
  pointer_version: string | number;
  release_evidence_id: string | null;
  release_evidence_version: string | number | null;
  release_evidence_hash: string | null;
  artifact_count: string | number;
  unapproved_count: string | number;
};

type ConceptEvidenceRow = {
  concept_id: string;
  slug: string;
  critical: boolean;
  status: string | null;
  critical_requirements_met: boolean | null;
  mastery_policy_version: string | null;
  evidence_ids: string[] | null;
};

function issueInputHash(userId: string, enrollmentId: string, requestId: string) {
  return hashSocialEvidence({ operation: "issue", userId, enrollmentId, requestId, policyVersion: CERTIFICATE_POLICY_VERSION });
}

function newVerificationId() {
  return randomBytes(24).toString("base64url");
}

async function assertActiveLearner(client: PoolClient, userId: string) {
  const result = await client.query<{ role: string | null; status: string }>(
    `select role,status from "user" where id=$1 for update`, [userId],
  );
  if (result.rows[0]?.role !== "learner" || result.rows[0]?.status !== "active") {
    throw new CertificateError("NOT_FOUND");
  }
}

async function readEligibility(client: PoolClient, userId: string, enrollmentId: string) {
  const result = await client.query<EligibilityRow>(
    `select enrollment.id enrollment_id,enrollment.status enrollment_status,enrollment.completed_at,
            learner.id user_id,learner.name learner_name,learner.status learner_status,learner.role learner_role,
            course.id course_id,course.slug course_slug,course.title course_title,
            version.id course_version_id,version.version course_version,version.stage,version.content_hash,
            version.publication_revision,version.published_at,version.approved_by,
            pointer.row_version pointer_version,release.id release_evidence_id,
            release.evidence_version release_evidence_version,release.evidence_hash release_evidence_hash,
            count(distinct artifact.id)::int artifact_count,
            count(distinct artifact.id) filter (where artifact.review_status <> 'approved')::int unapproved_count
       from enrollment
       join "user" learner on learner.id=enrollment.user_id
       join course_version version on version.id=enrollment.course_version_id
       join course on course.id=version.course_id
       left join curriculum_publication_pointer pointer
         on pointer.course_id=course.id and pointer.current_course_version_id=version.id
       left join lateral (
         select evidence.id,evidence.evidence_version,evidence.evidence_hash
           from curriculum_release_evidence evidence
          where evidence.course_version_id=version.id
          order by evidence.evidence_version desc,evidence.created_at desc,evidence.id desc limit 1
       ) release on true
       left join curriculum_artifact artifact on artifact.course_version_id=version.id
      where enrollment.id=$2 and enrollment.user_id=$1
      group by enrollment.id,learner.id,course.id,version.id,pointer.course_id,pointer.row_version,
               release.id,release.evidence_version,release.evidence_hash`,
    [userId, enrollmentId],
  );
  const row = result.rows[0];
  if (!row) throw new CertificateError("NOT_FOUND");
  const eligible = row.learner_status === "active" && row.learner_role === "learner"
    && row.enrollment_status === "completed" && Boolean(row.completed_at)
    && row.stage === "verified" && Boolean(row.approved_by) && Boolean(row.published_at)
    && Number(row.pointer_version) >= 1 && Boolean(row.release_evidence_id)
    && Number(row.artifact_count) > 0 && Number(row.unapproved_count) === 0;
  if (!eligible) throw new CertificateError("NOT_ELIGIBLE");
  return row;
}

async function readConceptEvidence(client: PoolClient, userId: string, enrollmentId: string, courseVersionId: string) {
  const result = await client.query<ConceptEvidenceRow>(
    `with covered as (
       select distinct concept.id concept_id,concept.slug,concept.critical
         from course_module module
         join lesson on lesson.module_id=module.id
         join lesson_concept link on link.lesson_id=lesson.id
         join concept on concept.id=link.concept_id
        where module.course_version_id=$3
     )
     select covered.concept_id,covered.slug,covered.critical,mastery.status,
            mastery.critical_requirements_met,mastery.policy_version mastery_policy_version,
            array_remove(array_agg(evidence.id::text order by evidence.recorded_at,evidence.id)
              filter (where evidence.id is not null),null) evidence_ids
       from covered
       left join concept_mastery mastery
         on mastery.user_id=$1 and mastery.enrollment_id=$2 and mastery.concept_id=covered.concept_id
       left join mastery_evidence evidence
         on evidence.user_id=$1 and evidence.enrollment_id=$2 and evidence.concept_id=covered.concept_id
        and evidence.validity='valid'
      group by covered.concept_id,covered.slug,covered.critical,mastery.status,
               mastery.critical_requirements_met,mastery.policy_version
      order by covered.slug,covered.concept_id`,
    [userId, enrollmentId, courseVersionId],
  );
  if (!result.rows.length || result.rows.some((row) =>
    row.status !== "mastered"
    || (row.critical && !row.critical_requirements_met)
    || !(row.evidence_ids?.length))) {
    throw new CertificateError("NOT_ELIGIBLE");
  }
  return result.rows;
}

type CertificatePrivateRow = {
  id: string; verification_id: string; learner_display_name: string; course_title: string;
  course_version_label: string; policy_version: string; issued_at: Date;
  revoked_at: Date | null; revocation_reason: string | null;
};

function privateCertificate(row: CertificatePrivateRow) {
  return {
    id: row.id,
    verificationId: row.verification_id,
    learnerDisplayName: row.learner_display_name,
    courseTitle: row.course_title,
    courseVersion: row.course_version_label,
    policyVersion: row.policy_version,
    issuedAt: row.issued_at.toISOString(),
    status: row.revoked_at ? "revoked" as const : "valid" as const,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revocationReason: row.revocation_reason,
    verificationPath: `/verify/${row.verification_id}`,
  };
}

async function readPrivateCertificate(client: PoolClient, certificateId: string, userId: string) {
  const result = await client.query<CertificatePrivateRow>(
    `select certificate.id,certificate.verification_id,certificate.learner_display_name,
            certificate.course_title,certificate.course_version_label,certificate.policy_version,
            certificate.issued_at,revocation.revoked_at,revocation.reason revocation_reason
       from course_certificate certificate
       left join certificate_revocation revocation on revocation.certificate_id=certificate.id
      where certificate.id=$1 and certificate.user_id=$2`,
    [certificateId, userId],
  );
  if (!result.rows[0]) throw new CertificateError("NOT_FOUND");
  return privateCertificate(result.rows[0]);
}

export async function issueCourseCertificate(input: {
  userId: string;
  enrollmentId: string;
  requestId: string;
  now?: Date;
  verificationId?: string;
}) {
  const now = input.now ?? new Date();
  if (!input.userId.trim() || !UUID_PATTERN.test(input.enrollmentId) || !UUID_PATTERN.test(input.requestId)
    || !Number.isFinite(now.getTime()) || (input.verificationId && !VERIFICATION_PATTERN.test(input.verificationId))) {
    throw new CertificateError("INVALID_REQUEST");
  }
  const inputHash = issueInputHash(input.userId, input.enrollmentId, input.requestId);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`certificate:${input.enrollmentId}`]);
    await assertActiveLearner(client, input.userId);
    const receipt = await client.query<{ input_hash: string; certificate_id: string }>(
      `select input_hash,certificate_id from certificate_operation_receipt
        where user_id=$1 and request_id=$2`, [input.userId, input.requestId],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].input_hash !== inputHash) throw new CertificateError("IDEMPOTENCY_MISMATCH");
      const certificate = await readPrivateCertificate(client, receipt.rows[0].certificate_id, input.userId);
      await client.query("commit");
      return { certificate, replayed: true } as const;
    }
    const eligibility = await readEligibility(client, input.userId, input.enrollmentId);
    const existing = await client.query<{ id: string }>(
      `select id from course_certificate where enrollment_id=$1 and user_id=$2`,
      [input.enrollmentId, input.userId],
    );
    if (existing.rows[0]) {
      const certificate = await readPrivateCertificate(client, existing.rows[0].id, input.userId);
      await client.query(
        `insert into certificate_operation_receipt
          (user_id,request_id,operation,input_hash,certificate_id,result,created_at)
         values ($1,$2,'issue',$3,$4,$5::jsonb,$6)`,
        [input.userId, input.requestId, inputHash, certificate.id,
          JSON.stringify({ certificateId: certificate.id, reusedExisting: true }), now],
      );
      await client.query("commit");
      return { certificate, replayed: false, reusedExisting: true } as const;
    }
    const concepts = await readConceptEvidence(client, input.userId, input.enrollmentId, eligibility.course_version_id);
    const issueEvidence = {
      schemaVersion: 1,
      enrollmentId: eligibility.enrollment_id,
      courseId: eligibility.course_id,
      courseSlug: eligibility.course_slug,
      courseVersionId: eligibility.course_version_id,
      courseVersion: eligibility.course_version,
      courseContentHash: eligibility.content_hash,
      publicationRevision: Number(eligibility.publication_revision),
      publicationPointerVersion: Number(eligibility.pointer_version),
      releaseEvidence: {
        id: eligibility.release_evidence_id,
        version: Number(eligibility.release_evidence_version),
        hash: eligibility.release_evidence_hash,
      },
      enrollmentCompletedAt: eligibility.completed_at!.toISOString(),
      conceptCount: concepts.length,
      criticalConceptCount: concepts.filter((concept) => concept.critical).length,
      concepts: concepts.map((concept) => ({
        conceptId: concept.concept_id,
        slug: concept.slug,
        critical: concept.critical,
        masteryPolicyVersion: concept.mastery_policy_version,
        evidenceIds: concept.evidence_ids,
      })),
      certificatePolicyVersion: CERTIFICATE_POLICY_VERSION,
    };
    const verificationId = input.verificationId ?? newVerificationId();
    const inserted = await client.query<{ id: string }>(
      `insert into course_certificate
        (user_id,enrollment_id,course_version_id,verification_id,learner_display_name,
         course_title,course_version_label,issue_evidence,evidence_hash,policy_version,issued_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) returning id`,
      [input.userId, input.enrollmentId, eligibility.course_version_id, verificationId,
        eligibility.learner_name, eligibility.course_title, eligibility.course_version,
        JSON.stringify(issueEvidence), hashSocialEvidence(issueEvidence), CERTIFICATE_POLICY_VERSION, now],
    );
    const certificate = await readPrivateCertificate(client, inserted.rows[0]!.id, input.userId);
    await client.query(
      `insert into certificate_operation_receipt
        (user_id,request_id,operation,input_hash,certificate_id,result,created_at)
       values ($1,$2,'issue',$3,$4,$5::jsonb,$6)`,
      [input.userId, input.requestId, inputHash, certificate.id,
        JSON.stringify({ certificateId: certificate.id, reusedExisting: false }), now],
    );
    await client.query("commit");
    return { certificate, replayed: false, reusedExisting: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") throw new CertificateError("WRITE_CONFLICT");
    if ((error as { code?: string }).code === "23514") throw new CertificateError("NOT_ELIGIBLE");
    throw error;
  } finally {
    client.release();
  }
}

export async function listOwnCertificates(userId: string) {
  const result = await pool.query<CertificatePrivateRow>(
    `select certificate.id,certificate.verification_id,certificate.learner_display_name,
            certificate.course_title,certificate.course_version_label,certificate.policy_version,
            certificate.issued_at,revocation.revoked_at,revocation.reason revocation_reason
       from course_certificate certificate
       left join certificate_revocation revocation on revocation.certificate_id=certificate.id
      where certificate.user_id=$1 order by certificate.issued_at desc,certificate.id`,
    [userId],
  );
  return result.rows.map(privateCertificate);
}

export async function listCertificateCandidates(userId: string) {
  const result = await pool.query<{
    enrollment_id: string; course_title: string; course_version: string; enrollment_status: string;
    completed_at: Date | null; stage: string; is_current: boolean; artifact_count: string | number;
    unapproved_count: string | number; concept_count: string | number; mastered_count: string | number;
    certificate_id: string | null;
  }>(
    `with covered as (
       select module.course_version_id,link.concept_id,concept.critical
         from course_module module join lesson on lesson.module_id=module.id
         join lesson_concept link on link.lesson_id=lesson.id
         join concept on concept.id=link.concept_id
        group by module.course_version_id,link.concept_id,concept.critical
     )
     select enrollment.id enrollment_id,course.title course_title,version.version course_version,
            enrollment.status enrollment_status,enrollment.completed_at,version.stage,
            coalesce(pointer.current_course_version_id=version.id,false) is_current,
            (select count(*) from curriculum_artifact artifact where artifact.course_version_id=version.id)::int artifact_count,
            (select count(*) from curriculum_artifact artifact where artifact.course_version_id=version.id and artifact.review_status<>'approved')::int unapproved_count,
            count(covered.concept_id)::int concept_count,
            count(covered.concept_id) filter (where exists (
              select 1 from concept_mastery mastery where mastery.user_id=$1
                and mastery.enrollment_id=enrollment.id and mastery.concept_id=covered.concept_id
                and mastery.status='mastered'
                and (not covered.critical or mastery.critical_requirements_met)
                and exists (select 1 from mastery_evidence evidence where evidence.user_id=$1
                  and evidence.enrollment_id=enrollment.id and evidence.concept_id=covered.concept_id
                  and evidence.validity='valid')
            ))::int mastered_count,certificate.id certificate_id
       from enrollment join course_version version on version.id=enrollment.course_version_id
       join course on course.id=version.course_id
       left join curriculum_publication_pointer pointer on pointer.course_id=course.id
       left join covered on covered.course_version_id=version.id
       left join course_certificate certificate on certificate.enrollment_id=enrollment.id
      where enrollment.user_id=$1
      group by enrollment.id,course.id,version.id,pointer.course_id,pointer.current_course_version_id,certificate.id
      order by case enrollment.status when 'completed' then 0 else 1 end,course.title,enrollment.created_at,enrollment.id`,
    [userId],
  );
  return result.rows.map((row) => {
    const concepts = Number(row.concept_count);
    const mastered = Number(row.mastered_count);
    const eligible = row.enrollment_status === "completed" && Boolean(row.completed_at)
      && row.stage === "verified" && row.is_current
      && Number(row.artifact_count) > 0 && Number(row.unapproved_count) === 0
      && concepts > 0 && mastered === concepts;
    return {
      enrollmentId: row.enrollment_id,
      courseTitle: row.course_title,
      courseVersion: row.course_version,
      enrollmentStatus: row.enrollment_status,
      completedAt: row.completed_at?.toISOString() ?? null,
      masteredConcepts: mastered,
      totalConcepts: concepts,
      eligible,
      alreadyIssued: Boolean(row.certificate_id),
      reason: eligible
        ? "Current verified version, completed enrollment, and every covered concept has valid mastery evidence."
        : row.enrollment_status !== "completed" ? "Complete this course first."
          : row.stage !== "verified" || !row.is_current ? "The completed version is not the current verified publication."
            : concepts === 0 ? "This course version has no certificate-eligible concept map."
              : `${mastered} of ${concepts} covered concepts have mastered, valid evidence.`,
    };
  });
}

export async function loadPublicCertificate(verificationId: string) {
  if (!VERIFICATION_PATTERN.test(verificationId)) throw new CertificateError("NOT_FOUND");
  const result = await pool.query<CertificatePrivateRow>(
    `select certificate.id,certificate.verification_id,certificate.learner_display_name,
            certificate.course_title,certificate.course_version_label,certificate.policy_version,
            certificate.issued_at,revocation.revoked_at,null::text revocation_reason
       from course_certificate certificate
       join "user" learner on learner.id=certificate.user_id
       left join certificate_revocation revocation on revocation.certificate_id=certificate.id
      where certificate.verification_id=$1 and learner.status <> 'deleted'`,
    [verificationId],
  );
  if (!result.rows[0]) throw new CertificateError("NOT_FOUND");
  const certificate = privateCertificate(result.rows[0]);
  return {
    verificationId: certificate.verificationId,
    learnerDisplayName: certificate.learnerDisplayName,
    courseTitle: certificate.courseTitle,
    courseVersion: certificate.courseVersion,
    issuedAt: certificate.issuedAt,
    status: certificate.status,
    revokedAt: certificate.revokedAt,
    statement: certificate.status === "valid"
      ? "This record matches an immutable certificate issued from the current verified course version and authoritative completion evidence at issue time."
      : "This certificate has been revoked. The private administrative reason is not exposed by the public verifier.",
  };
}

export async function listAdminCertificates() {
  const result = await pool.query<CertificatePrivateRow & { learner_email: string }>(
    `select certificate.id,certificate.verification_id,certificate.learner_display_name,
            learner.email learner_email,certificate.course_title,certificate.course_version_label,
            certificate.policy_version,certificate.issued_at,revocation.revoked_at,
            revocation.reason revocation_reason
       from course_certificate certificate
       join "user" learner on learner.id=certificate.user_id
       left join certificate_revocation revocation on revocation.certificate_id=certificate.id
      order by certificate.issued_at desc,certificate.id`,
  );
  return result.rows.map((row) => ({
    ...privateCertificate(row),
    learnerEmail: row.learner_email,
  }));
}

export async function revokeCourseCertificate(input: {
  actorUserId: string;
  certificateId: string;
  requestId: string;
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!input.actorUserId.trim() || !UUID_PATTERN.test(input.certificateId) || !UUID_PATTERN.test(input.requestId)
    || reason.length < 8 || reason.length > 1_000 || !Number.isFinite(now.getTime())) {
    throw new CertificateError("INVALID_REQUEST");
  }
  const evidence = { certificateId: input.certificateId, requestId: input.requestId, reason };
  const evidenceHash = hashSocialEvidence(evidence);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`certificate-revoke:${input.certificateId}`]);
    const actor = await client.query<{ role: string | null; status: string }>(
      `select role,status from "user" where id=$1 for update`, [input.actorUserId],
    );
    if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
      throw new CertificateError("ADMIN_REQUIRED");
    }
    const priorRequest = await client.query<{
      certificate_id: string; reason: string; evidence_hash: string; revoked_at: Date;
    }>(
      `select certificate_id,reason,evidence_hash,revoked_at from certificate_revocation
        where revoked_by=$1 and request_id=$2`, [input.actorUserId, input.requestId],
    );
    if (priorRequest.rows[0]) {
      if (priorRequest.rows[0].certificate_id !== input.certificateId
        || priorRequest.rows[0].reason !== reason || priorRequest.rows[0].evidence_hash !== evidenceHash) {
        throw new CertificateError("IDEMPOTENCY_MISMATCH");
      }
      await client.query("commit");
      return { certificateId: input.certificateId, revokedAt: priorRequest.rows[0].revoked_at.toISOString(), replayed: true } as const;
    }
    const certificate = await client.query<{ id: string }>(
      `select id from course_certificate where id=$1 for update`, [input.certificateId],
    );
    if (!certificate.rows[0]) throw new CertificateError("NOT_FOUND");
    const existing = await client.query(`select 1 from certificate_revocation where certificate_id=$1`, [input.certificateId]);
    if (existing.rows[0]) throw new CertificateError("ALREADY_REVOKED");
    await client.query(
      `insert into certificate_revocation
        (certificate_id,revoked_by,request_id,reason,evidence_hash,revoked_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [input.certificateId, input.actorUserId, input.requestId, reason, evidenceHash, now],
    );
    await client.query("commit");
    return { certificateId: input.certificateId, revokedAt: now.toISOString(), replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
