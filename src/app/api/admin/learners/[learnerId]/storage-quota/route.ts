import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { withRateLimit } from "@/lib/security/rate-limit";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import {
  changeLearnerStorageQuota,
  getLearnerStorageQuota,
  StorageQuotaAdminError,
  storageQuotaAdminHttpStatus,
} from "@/lib/storage/admin-quota";
import { emailStorageQuotaChanged } from "@/lib/storage/quota-notifications";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_STORAGE_QUOTA_BYTES,
} from "@/lib/storage/policy";

const learnerIdSchema = z.uuid();
const bodySchema = z.object({
  requestId: z.uuid(),
  expectedRowVersion: z.number().int().min(0),
  quotaBytes: z.number().int().min(DEFAULT_STORAGE_QUOTA_BYTES).max(MAX_STORAGE_QUOTA_BYTES),
  reason: z.string().trim().min(8).max(500),
}).strict();

const noStore = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const { learnerId } = await context.params;
  if (!learnerIdSchema.safeParse(learnerId).success) {
    return NextResponse.json({ error: "Learner identifier is invalid." }, { status: 400, headers: noStore });
  }
  try {
    const quota = await getLearnerStorageQuota(learnerId);
    return NextResponse.json({
      usedBytes: quota.usedBytes,
      quotaBytes: quota.quotaBytes,
      rowVersion: quota.rowVersion,
    }, { headers: noStore });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof StorageQuotaAdminError ? error.message : "Storage quota is temporarily unavailable." },
      { status: storageQuotaAdminHttpStatus(error), headers: noStore },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  return withRateLimit(
    { policy: "storage_quota_admin", identity: { kind: "user", value: authz.session.user.id } },
    async () => {
      const { learnerId } = await context.params;
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!learnerIdSchema.safeParse(learnerId).success || !body.success) {
        return NextResponse.json(
          { error: "Provide a valid learner, quota, version, request id, and recorded reason." },
          { status: 400, headers: noStore },
        );
      }
      const [activeSession] = await db
        .select({ mfaVerifiedAt: session.mfaVerifiedAt })
        .from(session)
        .where(and(
          eq(session.id, authz.session.session.id),
          eq(session.userId, authz.session.user.id),
        ))
        .limit(1);
      const gate = authorizePrivilegedAction({
        actorRole: authz.account.role,
        mfaVerifiedAt: activeSession?.mfaVerifiedAt,
        reason: body.data.reason,
        action: "storage.quota.manage",
      });
      if (!gate.allowed) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "storage.quota.change",
          resourceType: "learner_profile",
          resourceId: learnerId,
          reason: body.data.reason,
          outcome: "denied",
          metadata: { denialCode: gate.code },
        });
        return NextResponse.json({ error: gate.code }, { status: 403, headers: noStore });
      }
      try {
        const quota = await changeLearnerStorageQuota({
          learnerPublicId: learnerId,
          requestedBytes: body.data.quotaBytes,
          expectedRowVersion: body.data.expectedRowVersion,
          requestId: body.data.requestId,
          actorUserId: authz.session.user.id,
          reason: body.data.reason,
        });
        const audit = await writeAuditEvent({
          actorUserId: authz.session.user.id,
          subjectUserId: quota.learnerUserId,
          action: "storage.quota.change",
          resourceType: "learner_profile",
          resourceId: learnerId,
          reason: body.data.reason,
          outcome: "success",
          correlationId: body.data.requestId,
          metadata: {
            quotaBytes: quota.quotaBytes,
            usedBytes: quota.usedBytes,
            rowVersion: quota.rowVersion,
            replayed: quota.replayed,
          },
        });
        let notificationWarning: string | undefined;
        try {
          await emailStorageQuotaChanged(quota, body.data.requestId);
        } catch {
          notificationWarning = "The in-app notice was recorded, but email delivery could not be queued.";
          await writeAuditEvent({
            actorUserId: authz.session.user.id,
            subjectUserId: quota.learnerUserId,
            action: "storage.quota.notification",
            resourceType: "email_outbox",
            resourceId: learnerId,
            outcome: "failure",
            correlationId: body.data.requestId,
            metadata: { errorCode: "EMAIL_ENQUEUE_FAILED" },
          }).catch(() => undefined);
        }
        return NextResponse.json({
          usedBytes: quota.usedBytes,
          quotaBytes: quota.quotaBytes,
          rowVersion: quota.rowVersion,
          replayed: quota.replayed,
          auditCorrelationId: audit.correlationId,
          ...(notificationWarning ? { warning: notificationWarning } : {}),
        }, { headers: noStore });
      } catch (error) {
        await writeAuditEvent({
          actorUserId: authz.session.user.id,
          action: "storage.quota.change",
          resourceType: "learner_profile",
          resourceId: learnerId,
          reason: body.data.reason,
          outcome: "failure",
          correlationId: body.data.requestId,
          metadata: {
            errorCode: error instanceof StorageQuotaAdminError ? error.code : "STORAGE_QUOTA_CHANGE_FAILED",
          },
        }).catch(() => undefined);
        return NextResponse.json(
          { error: error instanceof StorageQuotaAdminError ? error.message : "Storage quota could not be changed safely." },
          { status: storageQuotaAdminHttpStatus(error), headers: noStore },
        );
      }
    },
  );
}
