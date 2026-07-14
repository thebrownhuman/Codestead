import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { mentorEvidenceReadSchema } from "@/lib/admin-mentor/contracts";
import {
  MentorEvidenceError,
  readMentorEvidence,
  resolveMentorLearner,
} from "@/lib/admin-mentor/evidence-reader";
import { db } from "@/lib/db/client";
import { session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { withRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const learnerIdSchema = z.uuid();

async function deniedAudit(input: {
  readonly actorUserId: string;
  readonly subjectUserId?: string;
  readonly learnerPublicId?: string;
  readonly reason: string;
  readonly outcome?: "denied" | "failure";
  readonly code: string;
  readonly requestId?: string;
  readonly category?: string;
  readonly purpose?: string;
}) {
  await writeAuditEvent({
    actorUserId: input.actorUserId,
    subjectUserId: input.subjectUserId,
    action: "mentor.evidence.read",
    resourceType: "learner_evidence",
    resourceId: input.learnerPublicId,
    reason: input.reason,
    outcome: input.outcome ?? "denied",
    correlationId: input.requestId,
    metadata: {
      code: input.code,
      ...(input.category ? { category: input.category } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
    },
  }).catch(() => undefined);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ learnerId: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const actorUserId = authz.session.user.id;
  const { learnerId } = await context.params;
  const body = mentorEvidenceReadSchema.safeParse(await request.json().catch(() => null));
  if (!learnerIdSchema.safeParse(learnerId).success || !body.success) {
    await deniedAudit({
      actorUserId,
      learnerPublicId: learnerIdSchema.safeParse(learnerId).success ? learnerId : undefined,
      reason: "Invalid bounded mentor evidence read request.",
      code: "INVALID_REQUEST",
    });
    return adminJson({
      error: "Provide a valid learner, category, purpose, request id, bounded page size, and specific reason.",
    }, 400);
  }

  const response = await withRateLimit(
    {
      policy: "mentor_evidence_read_admin",
      identity: { kind: "user", value: actorUserId },
    },
    async () => {
      const learner = await resolveMentorLearner(learnerId);
      if (!learner) {
        await deniedAudit({
          actorUserId,
          learnerPublicId: learnerId,
          reason: body.data.reason,
          outcome: "failure",
          code: "LEARNER_NOT_FOUND",
          requestId: body.data.requestId,
          category: body.data.category,
          purpose: body.data.purpose,
        });
        return adminJson({ error: "Learner was not found." }, 404);
      }
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
        action: "mentor.evidence.read",
      });
      if (!gate.allowed) {
        await deniedAudit({
          actorUserId,
          subjectUserId: learner.id,
          learnerPublicId: learner.public_id,
          reason: body.data.reason,
          code: gate.code,
          requestId: body.data.requestId,
          category: body.data.category,
          purpose: body.data.purpose,
        });
        return adminJson({ error: gate.code }, 403);
      }

      let evidence: Awaited<ReturnType<typeof readMentorEvidence>>;
      try {
        evidence = await readMentorEvidence({
          learnerUserId: learner.id,
          category: body.data.category,
          cursor: body.data.cursor,
          limit: body.data.limit,
        });
      } catch (error) {
        const code = error instanceof MentorEvidenceError ? error.code : "MENTOR_EVIDENCE_READ_FAILED";
        await deniedAudit({
          actorUserId,
          subjectUserId: learner.id,
          learnerPublicId: learner.public_id,
          reason: body.data.reason,
          outcome: "failure",
          code,
          requestId: body.data.requestId,
          category: body.data.category,
          purpose: body.data.purpose,
        });
        return adminJson(
          { error: code === "INVALID_CURSOR" ? "The evidence cursor is invalid or expired." : "Mentor evidence is temporarily unavailable." },
          code === "INVALID_CURSOR" ? 400 : 503,
        );
      }

      const audited = await writeAuditEvent({
        actorUserId,
        subjectUserId: learner.id,
        action: "mentor.evidence.read",
        resourceType: "learner_evidence",
        resourceId: learner.public_id,
        reason: body.data.reason,
        outcome: "success",
        correlationId: body.data.requestId,
        metadata: {
          category: body.data.category,
          purpose: body.data.purpose,
          itemCount: evidence.items.length,
          hasMore: evidence.page.hasMore,
          responseBytes: evidence.safeguards.responseBytes,
          truncatedItemCount: evidence.safeguards.truncatedItemCount,
        },
      }).then(() => true).catch(() => false);
      if (!audited) {
        // Evidence was read inside the server but is withheld unless the
        // privileged disclosure itself is durably audited.
        return adminJson({ error: "The evidence read could not be audited, so no learner content was disclosed." }, 503);
      }
      return adminJson({
        evidence,
        purpose: body.data.purpose,
        autoClearSeconds: 300,
      });
    },
  );

  if (response.status === 429) {
    await deniedAudit({
      actorUserId,
      learnerPublicId: learnerId,
      reason: body.data.reason,
      code: "RATE_LIMITED",
      requestId: body.data.requestId,
      category: body.data.category,
      purpose: body.data.purpose,
    });
  }
  return response;
}
