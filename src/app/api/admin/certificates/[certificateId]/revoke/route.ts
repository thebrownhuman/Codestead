import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { CertificateError, revokeCourseCertificate } from "@/lib/certificates/service";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const noStore = { "Cache-Control": "private, no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" };
const bodySchema = z.object({ requestId: z.uuid(), reason: z.string().trim().min(8).max(500) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ certificateId: string }> }) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "certificate_revoke_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const certificateId = (await params).certificateId;
      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!z.uuid().safeParse(certificateId).success || !parsed.success) {
        return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers: noStore });
      }
      let activeSession: { mfaVerifiedAt: Date | null } | undefined;
      try {
        [activeSession] = await db
          .select({ mfaVerifiedAt: session.mfaVerifiedAt })
          .from(session)
          .where(and(
            eq(session.id, authz.session.session.id),
            eq(session.userId, authz.session.user.id),
          ))
          .limit(1);
      } catch {
        return NextResponse.json(
          { error: "Certificate revocation protection is temporarily unavailable." },
          { status: 503, headers: noStore },
        );
      }
      const gate = authorizePrivilegedAction({
        actorRole: authz.account.role,
        mfaVerifiedAt: activeSession?.mfaVerifiedAt,
        reason: parsed.data.reason,
        action: "certificate.revoke",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "certificate.revoke",
          resourceType: "course_certificate",
          resourceId: certificateId,
          outcome: "denied",
          reason: parsed.data.reason,
          correlationId: parsed.data.requestId,
          metadata: { denialCode: gate.code },
        }).catch(() => undefined);
        return NextResponse.json({ error: gate.code }, { status: 403, headers: noStore });
      }
      try {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "certificate.revoke",
          resourceType: "course_certificate",
          resourceId: certificateId,
          outcome: "allowed",
          reason: parsed.data.reason,
          correlationId: parsed.data.requestId,
          metadata: { phase: "pre_mutation" },
        });
      } catch {
        return NextResponse.json(
          { error: "Certificate revocation protection is temporarily unavailable." },
          { status: 503, headers: noStore },
        );
      }
      try {
        const result = await revokeCourseCertificate({
          actorUserId: authz.session.user.id,
          certificateId,
          ...parsed.data,
        });
        const completionAuditRecorded = await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "certificate.revoke",
          resourceType: "course_certificate",
          resourceId: certificateId,
          outcome: "success",
          reason: parsed.data.reason,
          correlationId: parsed.data.requestId,
          metadata: { replayed: result.replayed },
        }).then(() => true).catch(() => false);
        return NextResponse.json({
          result,
          completionAuditRecorded,
          ...(completionAuditRecorded ? {} : {
            warning: "The certificate was revoked, but its completion audit needs operator reconciliation. Do not repeat the request.",
          }),
        }, { headers: noStore });
      } catch (error) {
        const code = error instanceof CertificateError ? error.code : "CERTIFICATE_REVOCATION_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "certificate.revoke",
          resourceType: "course_certificate",
          resourceId: certificateId,
          outcome: "failure",
          reason: parsed.data.reason,
          correlationId: parsed.data.requestId,
          metadata: { errorCode: code },
        }).catch(() => undefined);
        const status = code === "NOT_FOUND" ? 404 : code === "ADMIN_REQUIRED" ? 403 : code === "INVALID_REQUEST" ? 400 : 409;
        return NextResponse.json({ error: code }, { status, headers: noStore });
      }
    },
  );
}
