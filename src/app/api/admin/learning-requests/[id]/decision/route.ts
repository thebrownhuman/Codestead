import { readBoundedJson } from "@/lib/http/bounded-json";
import { and, eq, notInArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { learningRequest, session, user } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { enqueueEmail } from "@/lib/notifications/outbox";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";
import { evaluateRequestOrigin } from "@/lib/security/request-origin-policy";
import { containsCredentialOrHiddenEvidence } from "@/lib/security/sensitive-text";
import { supportKinds } from "@/lib/learning-requests/support-contract";
import { fixSupportRequest } from "@/lib/learning-requests/support-service";

const bodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(8).max(500),
}).strict();
const fixedSchema = z.object({
  decision: z.literal("fixed"),
  reply: z.string().trim().max(500).default("").refine((text) => !containsCredentialOrHiddenEvidence(text) && !/\b(?:api[_ -]?key|secret|authorization|bearer)\s*[:=]\s*\S+/i.test(text)),
}).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const origin = evaluateRequestOrigin({ method: request.method, headers: request.headers, appUrl: process.env.APP_URL, production: process.env.NODE_ENV === "production" });
  if (!origin.allowed) return NextResponse.json({ error: origin.code }, { status: origin.status });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid request identifier." }, { status: 400 });
  const jsonBody = await readBoundedJson(request);
  if (jsonBody.response?.status === 413) return jsonBody.response;
  const raw = jsonBody.value;
  if (raw && typeof raw === "object" && "decision" in raw && raw.decision === "fixed") {
    const fixed = fixedSchema.safeParse(raw);
    if (!fixed.success) return NextResponse.json({ error: "Provide an optional reply up to 500 characters without credentials." }, { status: 400 });
    try {
      const result = await fixSupportRequest(authz.session.user.id, id, fixed.data.reply);
      return NextResponse.json(result ?? { error: "Open support request not found." }, { status: result ? 200 : 404, headers: { "Cache-Control": "private, no-store" } });
    } catch {
      return NextResponse.json({ error: "The request could not be marked fixed. Try again." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
  }
  const body = bodySchema.safeParse(raw);
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
      .where(and(eq(learningRequest.id, id), eq(learningRequest.status, "pending"), notInArray(learningRequest.kind, [...supportKinds])))
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
