import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { accessRequest, invitation, session } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/http/authz";
import { enqueueEmail } from "@/lib/notifications/outbox";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { authorizePrivilegedAction } from "@/lib/security/privileged-access";

const bodySchema = z.object({ reason: z.string().trim().min(8).max(500) });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireAdmin();
  if (!authz.session) return authz.response;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "A review reason is required." }, { status: 400 });
  const [authSession] = await db
    .select({ mfaVerifiedAt: session.mfaVerifiedAt })
    .from(session)
    .where(eq(session.id, authz.session.session.id))
    .limit(1);
  const authorization = authorizePrivilegedAction({
    actorRole: authz.session.user.role,
    mfaVerifiedAt: authSession?.mfaVerifiedAt,
    reason: body.data.reason,
    action: "role.change",
  });
  if (!authorization.allowed) {
    return NextResponse.json({ error: authorization.code }, { status: 403 });
  }

  const { id } = await context.params;
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  const invitationId = crypto.randomUUID();

  const candidate = await db.transaction(async (tx) => {
    const [pending] = await tx
      .select()
      .from(accessRequest)
      .where(and(eq(accessRequest.id, id), eq(accessRequest.status, "pending")))
      .limit(1)
      .for("update");
    if (!pending) return null;
    await tx.insert(invitation).values({
      id: invitationId,
      accessRequestId: pending.id,
      email: pending.email.toLowerCase(),
      tokenHash,
      expiresAt,
      createdBy: authz.session.user.id,
    });
    await tx
      .update(accessRequest)
      .set({
        status: "approved",
        decidedBy: authz.session.user.id,
        decisionReason: body.data.reason,
        decidedAt: new Date(),
      })
      .where(eq(accessRequest.id, pending.id));
    return pending;
  });
  if (!candidate) return NextResponse.json({ error: "Pending request not found." }, { status: 404 });

  const activationUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/activate?token=${rawToken}`;
  await enqueueEmail({
    to: candidate.email,
    template: "invitation",
    variables: { name: candidate.name, url: activationUrl },
    idempotencySeed: invitationId,
  });
  await writeAuditEvent({
    actorUserId: authz.session.user.id,
    action: "access_request.approve",
    resourceType: "access_request",
    resourceId: candidate.id,
    reason: body.data.reason,
    outcome: "success",
    metadata: { invitationId, expiresAt: expiresAt.toISOString() },
  });
  return NextResponse.json({ ok: true, expiresAt });
}
