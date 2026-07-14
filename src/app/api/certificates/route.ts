import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { CertificateError, issueCourseCertificate, listCertificateCandidates, listOwnCertificates } from "@/lib/certificates/service";
import { requireAuth } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const noStore = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const issueSchema = z.object({ requestId: z.uuid(), enrollmentId: z.uuid() }).strict();

function status(code: string) {
  if (code === "NOT_FOUND") return 404;
  if (code === "INVALID_REQUEST") return 400;
  if (code === "NOT_ELIGIBLE") return 422;
  return 409;
}

export async function GET() {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const [certificates, candidates] = await Promise.all([
    listOwnCertificates(authz.session.user.id),
    listCertificateCandidates(authz.session.user.id),
  ]);
  return NextResponse.json({ certificates, candidates }, { headers: noStore });
}

export async function POST(request: NextRequest) {
  const authz = await requireAuth();
  if (!authz.session) return authz.response;
  const parsed = issueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers: noStore });
  return withRateLimit(
    { policy: "certificate_issue_user", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      try {
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: authz.session!.user.id,
          action: "certificate.issue",
          resourceType: "course_enrollment",
          resourceId: parsed.data.enrollmentId,
          outcome: "allowed",
          correlationId: parsed.data.requestId,
          metadata: { phase: "pre_mutation" },
        });
      } catch {
        return NextResponse.json(
          { error: "Certificate issuance protection is temporarily unavailable." },
          { status: 503, headers: noStore },
        );
      }

      let result: Awaited<ReturnType<typeof issueCourseCertificate>>;
      try {
        result = await issueCourseCertificate({ userId: authz.session!.user.id, ...parsed.data });
      } catch (error) {
        const code = error instanceof CertificateError ? error.code : "CERTIFICATE_ISSUE_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session!.user.id,
          subjectUserId: authz.session!.user.id,
          action: "certificate.issue",
          resourceType: "course_enrollment",
          resourceId: parsed.data.enrollmentId,
          outcome: "failure",
          correlationId: parsed.data.requestId,
          metadata: { errorCode: code },
        }).catch(() => undefined);
        return NextResponse.json({ error: code }, { status: status(code), headers: noStore });
      }

      const completionAuditRecorded = await writeAuditEvent({
        actorUserId: authz.session!.user.id,
        subjectUserId: authz.session!.user.id,
        action: "certificate.issue",
        resourceType: "course_certificate",
        resourceId: result.certificate.id,
        outcome: "success",
        correlationId: parsed.data.requestId,
        metadata: { enrollmentId: parsed.data.enrollmentId, replayed: result.replayed, reusedExisting: "reusedExisting" in result && result.reusedExisting === true },
      }).then(() => true).catch(() => false);
      return NextResponse.json({
        result,
        completionAuditRecorded,
        ...(completionAuditRecorded ? {} : {
          warning: "The certificate was issued, but its completion audit needs operator reconciliation. Do not repeat the request.",
        }),
      }, { status: result.replayed || ("reusedExisting" in result && result.reusedExisting) ? 200 : 201, headers: noStore });
    },
  );
}
