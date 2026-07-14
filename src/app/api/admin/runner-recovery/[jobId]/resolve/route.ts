import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import {
  PracticeRecoveryAdminError,
  resolveQuarantinedPracticeRunnerJob,
} from "@/lib/runner/practice-recovery-admin";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const jobIdSchema = z.uuid();
const bodySchema = z.object({
  requestId: z.uuid(),
  reason: z.string().trim().min(20).max(500),
  isolatedRunnerRestarted: z.literal(true),
  journalReconciled: z.literal(true),
}).strict();

async function auditDenied(input: {
  actorUserId: string;
  jobId?: string;
  requestId?: string;
  reason: string;
  code: string;
  outcome?: "denied" | "failure";
}) {
  await writeAuditEvent({
    actorUserId: input.actorUserId,
    action: "runner.practice.quarantine.resolve",
    resourceType: "runner_job",
    resourceId: input.jobId,
    reason: input.reason,
    outcome: input.outcome ?? "denied",
    correlationId: input.requestId,
    metadata: { code: input.code, officialEvidenceChanged: false },
  }).catch(() => undefined);
}

function errorResponse(error: PracticeRecoveryAdminError) {
  switch (error.code) {
    case "ADMIN_REQUIRED": return adminJson({ error: "Administrator access is required.", code: error.code }, 403);
    case "RUNNER_JOB_NOT_FOUND": return adminJson({ error: "The runner job was not found.", code: error.code }, 404);
    case "ATTESTATION_REQUIRED":
    case "INVALID_INPUT": return adminJson({ error: "Valid recovery attestations, reason, and identifiers are required.", code: error.code }, 400);
    case "NOT_PRACTICE_JOB": return adminJson({ error: "Official exam and regrade jobs cannot use practice recovery resolution.", code: error.code }, 409);
    case "NOT_QUARANTINED": return adminJson({ error: "This practice job is not quarantined.", code: error.code }, 409);
    case "LEARNER_NOT_ACTIVE": return adminJson({ error: "The learner is not eligible for recovery resolution.", code: error.code }, 409);
    case "STATUS_CONFLICT": return adminJson({ error: "The runner state changed. Refresh the audited evidence before retrying.", code: error.code }, 409);
    case "IDEMPOTENCY_CONFLICT": return adminJson({ error: "That recovery was already resolved by a different request.", code: error.code }, 409);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const actorUserId = authz.session.user.id;
  const { jobId } = await context.params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  const validJobId = jobIdSchema.safeParse(jobId);
  if (!validJobId.success || !body.success) {
    await auditDenied({
      actorUserId,
      jobId: validJobId.success ? validJobId.data : undefined,
      reason: "Invalid bounded practice recovery resolution request.",
      code: "INVALID_REQUEST",
    });
    return adminJson({
      error: "Provide a valid job, request id, specific reason, and both operator attestations.",
      code: "INVALID_REQUEST",
    }, 400);
  }

  const response = await withRateLimit(
    { policy: "runner_recovery_admin", identity: { kind: "user", value: actorUserId } },
    async () => {
      const [activeSession] = await db
        .select({ mfaVerifiedAt: session.mfaVerifiedAt })
        .from(session)
        .where(and(
          eq(session.id, authz.session!.session.id),
          eq(session.userId, actorUserId),
        ))
        .limit(1);
      const gate = authorizePrivilegedAction({
        actorRole: authz.account.role,
        mfaVerifiedAt: activeSession?.mfaVerifiedAt,
        reason: body.data.reason,
        action: "runner.practice.quarantine.resolve",
      });
      if (!gate.allowed) {
        await auditDenied({
          actorUserId,
          jobId: validJobId.data,
          requestId: body.data.requestId,
          reason: body.data.reason,
          code: gate.code,
        });
        return adminJson({ error: gate.code, code: gate.code }, 403);
      }

      try {
        const resolution = await resolveQuarantinedPracticeRunnerJob({
          actorUserId,
          runnerJobId: validJobId.data,
          ...body.data,
        });
        return adminJson({ resolution });
      } catch (error) {
        if (error instanceof PracticeRecoveryAdminError) {
          await auditDenied({
            actorUserId,
            jobId: validJobId.data,
            requestId: body.data.requestId,
            reason: body.data.reason,
            code: error.code,
            outcome: "failure",
          });
          return errorResponse(error);
        }
        await auditDenied({
          actorUserId,
          jobId: validJobId.data,
          requestId: body.data.requestId,
          reason: body.data.reason,
          code: "RECOVERY_RESOLUTION_FAILED",
          outcome: "failure",
        });
        return adminJson({
          error: "Practice recovery resolution is temporarily unavailable.",
          code: "RECOVERY_RESOLUTION_FAILED",
        }, 503);
      }
    },
  );
  if (response.status === 429) {
    await auditDenied({
      actorUserId,
      jobId: validJobId.data,
      requestId: body.data.requestId,
      reason: body.data.reason,
      code: "RATE_LIMITED",
    });
  }
  return response;
}
