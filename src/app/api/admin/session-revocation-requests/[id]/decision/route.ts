import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { adminJson, secureAdminResponse } from "@/app/api/admin/dashboard/http";
import { db } from "@/lib/db/client";
import {
  authSessionHistory,
  session,
  sessionRevocationRequest,
  user,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { notifyRevocationDecision } from "@/lib/session-notifications";
import {
  writeAuditEvent,
  writeAuditEventInTransaction,
} from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { boundedUserAgent } from "@/lib/session-controls";

const bodySchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return secureAdminResponse(authz.response);
  const { id } = await context.params;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return adminJson({ error: "A decision and specific reason are required." }, 400);
  const [adminSession] = await db
    .select({ mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(
      and(
        eq(session.id, authz.session.session.id),
        eq(session.userId, authz.session.user.id),
      ),
    )
    .limit(1);
  const gate = authorizePrivilegedAction({
    actorRole: authz.account.role,
    mfaVerifiedAt: adminSession?.mfaVerifiedAt,
    reason: body.data.reason,
    action: "session.revoke",
  });
  const [record] = await db
    .select({
      id: sessionRevocationRequest.id,
      userId: sessionRevocationRequest.userId,
      sessionId: sessionRevocationRequest.sessionId,
      status: sessionRevocationRequest.status,
      requestChannel: sessionRevocationRequest.requestChannel,
      identityVerifiedAt: sessionRevocationRequest.identityVerifiedAt,
      role: user.role,
    })
    .from(sessionRevocationRequest)
    .innerJoin(user, eq(user.id, sessionRevocationRequest.userId))
    .where(eq(sessionRevocationRequest.id, id))
    .limit(1);
  if (!record || record.role !== "learner") {
    return adminJson({ error: "Revocation request not found." }, 404);
  }
  if (!gate.allowed) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      subjectUserId: record.userId,
      action: "session.revocation_decide",
      resourceType: "session_revocation_request",
      resourceId: id,
      reason: body.data.reason,
      outcome: "denied",
      metadata: { denialCode: gate.code, decision: body.data.decision },
    });
    return adminJson({ error: gate.code }, 403);
  }
  if (record.requestChannel === "email_proof" && !record.identityVerifiedAt) {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      subjectUserId: record.userId,
      action: "session.revocation_decide",
      resourceType: "session_revocation_request",
      resourceId: id,
      reason: body.data.reason,
      outcome: "denied",
      metadata: { denialCode: "IDENTITY_PROOF_REQUIRED", decision: body.data.decision },
    });
    return adminJson({ error: "The out-of-band identity proof is incomplete." }, 409);
  }
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        id: sessionRevocationRequest.id,
        userId: sessionRevocationRequest.userId,
        sessionId: sessionRevocationRequest.sessionId,
        status: sessionRevocationRequest.status,
        requestChannel: sessionRevocationRequest.requestChannel,
        identityVerifiedAt: sessionRevocationRequest.identityVerifiedAt,
        role: user.role,
      })
      .from(sessionRevocationRequest)
      .innerJoin(user, eq(user.id, sessionRevocationRequest.userId))
      .where(eq(sessionRevocationRequest.id, id))
      .limit(1)
      .for("update");
    if (!locked || locked.role !== "learner") return { kind: "not_found" as const };
    if (locked.requestChannel === "email_proof" && !locked.identityVerifiedAt) {
      return { kind: "identity_required" as const, userId: locked.userId };
    }
    if (locked.status !== "pending") {
      return locked.status === body.data.decision
        ? { kind: "replay" as const, userId: locked.userId, sessionId: locked.sessionId }
        : { kind: "conflict" as const, userId: locked.userId };
    }

    let ownedSession:
      | {
          id: string;
          deviceLabel: string | null;
          userAgent: string | null;
          createdAt: Date;
          lastSeenAt: Date;
          expiresAt: Date;
        }
      | undefined;
    if (body.data.decision === "approved") {
      [ownedSession] = await tx
        .select({
          id: session.id,
          deviceLabel: session.deviceLabel,
          userAgent: session.userAgent,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
        })
        .from(session)
        .where(and(eq(session.id, locked.sessionId), eq(session.userId, locked.userId)))
        .limit(1)
        .for("update");
      if (!ownedSession) return { kind: "session_missing" as const, userId: locked.userId };
    }

    await writeAuditEventInTransaction(tx, {
      actorUserId: authz.session.user.id,
      subjectUserId: locked.userId,
      action: "session.revocation_decide",
      resourceType: "session_revocation_request",
      resourceId: id,
      reason: body.data.reason,
      outcome: "allowed",
      metadata: { decision: body.data.decision, phase: "pre_mutation" },
    });

    if (ownedSession) {
      await tx
        .insert(authSessionHistory)
        .values({
          originalSessionId: ownedSession.id,
          userId: locked.userId,
          deviceLabel: ownedSession.deviceLabel,
          userAgent: boundedUserAgent(ownedSession.userAgent),
          startedAt: ownedSession.createdAt,
          lastSeenAt: ownedSession.lastSeenAt,
          expiresAt: ownedSession.expiresAt,
          endedAt: now,
          endReason: "lost_device_approved",
          revokedByUserId: authz.session.user.id,
        })
        .onConflictDoNothing({ target: authSessionHistory.originalSessionId });
      await tx
        .delete(session)
        .where(and(eq(session.id, locked.sessionId), eq(session.userId, locked.userId)));
    }

    const [decided] = await tx
      .update(sessionRevocationRequest)
      .set({
        status: body.data.decision,
        decidedBy: authz.session.user.id,
        decisionReason: body.data.reason,
        decidedAt: now,
      })
      .where(
        and(
          eq(sessionRevocationRequest.id, id),
          eq(sessionRevocationRequest.status, "pending"),
        ),
      )
      .returning({ id: sessionRevocationRequest.id });
    if (!decided) throw new Error("SESSION_REVOCATION_DECISION_RACE");

    await writeAuditEventInTransaction(tx, {
      actorUserId: authz.session.user.id,
      subjectUserId: locked.userId,
      action: "session.revocation_decide",
      resourceType: "session_revocation_request",
      resourceId: id,
      reason: body.data.reason,
      outcome: "success",
      metadata: { decision: body.data.decision, sessionId: locked.sessionId },
    });
    return { kind: "decided" as const, userId: locked.userId, sessionId: locked.sessionId };
  });

  if (outcome.kind === "not_found") return adminJson({ error: "Revocation request not found." }, 404);
  if (outcome.kind === "identity_required") {
    return adminJson({ error: "The out-of-band identity proof is incomplete." }, 409);
  }
  if (outcome.kind === "conflict") {
    return adminJson({ error: "This request has already been decided differently." }, 409);
  }
  if (outcome.kind === "session_missing") {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      subjectUserId: outcome.userId,
      action: "session.revocation_decide",
      resourceType: "session_revocation_request",
      resourceId: id,
      reason: body.data.reason,
      outcome: "failure",
      metadata: { decision: body.data.decision, failureCode: "SESSION_NOT_ACTIVE" },
    });
    return adminJson({ error: "The requested session is no longer active." }, 409);
  }
  if (outcome.kind === "replay") {
    await writeAuditEvent({
      actorUserId: authz.session.user.id,
      subjectUserId: outcome.userId,
      action: "session.revocation_decide",
      resourceType: "session_revocation_request",
      resourceId: id,
      reason: body.data.reason,
      outcome: "success",
      metadata: { decision: body.data.decision, sessionId: outcome.sessionId, replayed: true },
    });
    return adminJson({ ok: true, decision: body.data.decision, replayed: true });
  }
  await notifyRevocationDecision({
    userId: outcome.userId,
    decision: body.data.decision,
    reason: body.data.reason,
    idempotencySeed: `${id}:${body.data.decision}`,
  }).catch(() => undefined);
  return adminJson({ ok: true, decision: body.data.decision });
}
