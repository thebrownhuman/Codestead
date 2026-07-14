import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { learningRequest, session, user } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { enqueueEmail } from "@/lib/notifications/outbox";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";

const bodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(8).max(500),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "A decision and specific reason are required." }, { status: 400 });
  const [authSession] = await db
    .select({ mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(eq(session.id, authz.session.session.id))
    .limit(1);
  const authorization = authorizePrivilegedAction({
    actorRole: authz.session.user.role,
    mfaVerifiedAt: authSession?.mfaVerifiedAt,
    reason: body.data.reason,
    action: "content.triage",
  });
  if (!authorization.allowed) return NextResponse.json({ error: authorization.code }, { status: 403 });

  const { id } = await context.params;
  const decidedAt = new Date();
  const candidate = await db.transaction(async (tx) => {
    const [pending] = await tx
      .select({
        id: learningRequest.id,
        userId: learningRequest.userId,
        subject: learningRequest.subject,
        learnerName: user.name,
        learnerEmail: user.email,
      })
      .from(learningRequest)
      .innerJoin(user, eq(user.id, learningRequest.userId))
      .where(and(eq(learningRequest.id, id), eq(learningRequest.status, "pending")))
      .limit(1)
      .for("update");
    if (!pending) return null;
    await tx
      .update(learningRequest)
      .set({
        status: body.data.decision,
        decisionBy: authz.session.user.id,
        decisionReason: body.data.reason,
        decidedAt,
      })
      .where(and(eq(learningRequest.id, pending.id), eq(learningRequest.status, "pending")));
    return pending;
  });
  if (!candidate) return NextResponse.json({ error: "Pending request not found." }, { status: 404 });

  await enqueueEmail({
    to: candidate.learnerEmail,
    userId: candidate.userId,
    template: "learning-request-updated",
    variables: {
      name: candidate.learnerName,
      subject: candidate.subject,
      url: `${process.env.APP_URL ?? "http://localhost:3000"}/requests`,
    },
    idempotencySeed: `${candidate.id}:${body.data.decision}`,
  });
  await writeAuditEvent({
    actorUserId: authz.session.user.id,
    subjectUserId: candidate.userId,
    action: `learning_request.${body.data.decision}`,
    resourceType: "learning_request",
    resourceId: candidate.id,
    reason: body.data.reason,
    outcome: "success",
    metadata: { decision: body.data.decision },
  });
  return NextResponse.json({ ok: true, decision: body.data.decision, decidedAt });
}
