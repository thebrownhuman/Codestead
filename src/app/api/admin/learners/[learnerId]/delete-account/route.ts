import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import { authorizeLifecycleAdmin } from "@/lib/data-lifecycle/admin-authorization";
import {
  AccountDeletionError,
  deleteLearnerAccount,
  type AccountDeletionReport,
} from "@/lib/data-lifecycle/deletion";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { withRateLimit } from "@/lib/security/rate-limit";

const bodySchema = z.object({
  requestId: z.uuid(),
  confirmation: z.literal("DELETE"),
  reason: z.string().trim().min(8).max(500),
}).strict();

const noStore = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) {
    for (const [name, value] of Object.entries(noStore)) authz.response.headers.set(name, value);
    return authz.response;
  }
  return withRateLimit(
    { policy: "account_deletion_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success) {
        return NextResponse.json(
          { error: "Type DELETE, provide a unique request id, and record a specific reason." },
          { status: 400, headers: noStore },
        );
      }
      const { learnerId } = await context.params;
      const [target] = await db
        .select({ id: user.id, role: user.role })
        .from(user)
        .where(eq(user.id, learnerId))
        .limit(1);
      if (!target || target.role !== "learner") {
        return NextResponse.json({ error: "Learner not found." }, { status: 404, headers: noStore });
      }
      const gate = await authorizeLifecycleAdmin({
        actorUserId: authz.session.user.id,
        actorSessionId: authz.session.session.id,
        actorRole: authz.account.role,
        reason: body.data.reason,
        action: "account.delete",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: learnerId,
          action: "account.delete",
          resourceType: "user",
          resourceId: learnerId,
          reason: body.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code },
        });
        return NextResponse.json({ error: gate.code }, { status: 403, headers: noStore });
      }
      await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: learnerId,
        action: "account.delete",
        resourceType: "user",
        resourceId: learnerId,
        reason: body.data.reason,
        outcome: "allowed",
        metadata: { phase: "pre_mutation", requestId: body.data.requestId },
      });
      let report: AccountDeletionReport;
      try {
        report = await deleteLearnerAccount({
          actorUserId: authz.session.user.id,
          learnerId,
          requestId: body.data.requestId,
          reason: body.data.reason,
        });
      } catch (error) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: learnerId,
          action: "account.delete",
          resourceType: "user",
          resourceId: learnerId,
          reason: body.data.reason,
          outcome: "failure",
          metadata: {
            errorCode: error instanceof Error && "code" in error
              ? String((error as { code: unknown }).code)
              : "ACCOUNT_DELETION_FAILED",
          },
        }).catch(() => undefined);
        const status = error instanceof AccountDeletionError
          ? error.code === "ADMIN_REQUIRED"
            ? 403
            : error.code === "LEARNER_NOT_FOUND"
              ? 404
              : error.code === "FILE_ERASURE_FAILED"
                ? 503
                : 409
          : 500;
        return NextResponse.json(
          {
            error: error instanceof AccountDeletionError
              ? error.code
              : "Account deletion failed safely; review the lifecycle run before retrying.",
          },
          { status, headers: noStore },
        );
      }
      const completionAuditRecorded = await writeAuditEvent({
        actorUserId: authz.session.user.id,
        subjectUserId: learnerId,
        action: "account.delete",
        resourceType: "account_deletion_tombstone",
        resourceId: report.tombstoneId,
        reason: body.data.reason,
        outcome: "success",
        metadata: {
          primaryStoreDeletionComplete: true,
          objectFileErasureComplete: report.objectFileErasureComplete,
          backupStatus: report.backupStatus,
          backupRetentionUntil: report.backupRetentionUntil,
        },
      }).then(() => true).catch(() => false);
      return NextResponse.json(
        {
          report,
          completionAuditRecorded,
          ...(completionAuditRecorded
            ? {}
            : { warning: "Deletion completed, but its completion audit needs operator reconciliation." }),
        },
        { status: 200, headers: noStore },
      );
    },
  );
}
