import { and, eq } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { ExamReexamGrantError, issueExamReexamGrant } from "@/lib/exams/reexam-grant";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  requestId: z.uuid(),
  reason: z.string().trim().min(20).max(2_000),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  return withRateLimit(
    { policy: "exam_reexam_grant_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { sessionId } = await context.params;
      if (!z.uuid().safeParse(sessionId).success) return adminJson({ error: "Exam not found." }, 404);
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) return adminJson({ error: "A request id and specific outage rationale are required." }, 400);
      const [bound] = await db
        .select({ mfaVerifiedAt: session.mfaVerifiedAt })
        .from(session)
        .where(and(eq(session.id, authz.session.session.id), eq(session.userId, authz.session.user.id)))
        .limit(1);
      const gate = authorizePrivilegedAction({
        actorRole: authz.account.role,
        mfaVerifiedAt: bound?.mfaVerifiedAt,
        reason: body.data.reason,
        action: "exam.reexam.grant",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id, action: "exam.reexam.grant",
          resourceType: "exam_session", resourceId: sessionId, reason: body.data.reason,
          outcome: "denied", metadata: { denialCode: gate.code },
        });
        return adminJson({ error: gate.code }, 403);
      }
      try {
        const report = await issueExamReexamGrant({
          actorUserId: authz.session.user.id,
          sourceExamSessionId: sessionId,
          requestId: body.data.requestId,
          reason: body.data.reason,
        });
        await writeAuditEvent({
          actorUserId: authz.session.user.id, subjectUserId: report.userId,
          action: "exam.reexam.grant", resourceType: "exam_reexam_grant", resourceId: report.id,
          reason: body.data.reason, outcome: "success",
          metadata: { sourceExamSessionId: sessionId, evidenceHash: report.evidenceHash, replayed: report.replayed },
        });
        return adminJson({ report });
      } catch (error) {
        const code = error instanceof ExamReexamGrantError ? error.code : "REEXAM_GRANT_FAILED";
        await writeAuditEvent({
          actorUserId: authz.session.user.id, action: "exam.reexam.grant",
          resourceType: "exam_session", resourceId: sessionId, reason: body.data.reason,
          outcome: "failure", metadata: { errorCode: code },
        }).catch(() => undefined);
        const status = code === "EXAM_NOT_FOUND" ? 404
          : ["REASON_REQUIRED", "EXAM_NOT_FINALIZED", "EXAM_FINALIZATION_PENDING", "PASS_ALREADY_PROTECTED", "PENDING_REVIEW_CANNOT_BE_BYPASSED", "REEXAM_GRANT_SOURCE_INELIGIBLE", "REEXAM_SOURCE_NOT_CURRENT", "MATERIAL_OUTAGE_EVIDENCE_REQUIRED", "GRANT_ALREADY_EXISTS", "IDEMPOTENCY_MISMATCH"].includes(code) ? 409
            : 500;
        return adminJson({ error: code }, status);
      }
    },
  );
}
