import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { consentRecord, user } from "@/lib/db/schema";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";
import { writeAuditEvent } from "@/lib/security/audit-writer";
import { disclosureRenewalDecisions, ENROLLMENT_DISCLOSURE_VERSION, getCurrentConsentsFrom } from "./consent";

export async function renewDisclosures(userId: string, requestId: string) {
  const result = await db.transaction(async (tx) => {
    await lockUserAuthority(tx, userId);
    const [account] = await tx.select({ status: user.status }).from(user).where(eq(user.id, userId)).limit(1);
    if (account?.status !== "active") return null;
    const current = await getCurrentConsentsFrom(tx, userId);
    let decisions;
    try { decisions = disclosureRenewalDecisions(current, { userId, requestId, occurredAt: new Date() }); }
    catch { return null; }
    const inserted = await tx.insert(consentRecord).values(decisions)
      .onConflictDoNothing({ target: consentRecord.idempotencyKey }).returning({ id: consentRecord.id });
    return { replayed: inserted.length === 0, purposes: decisions.map((row) => row.purpose) };
  });
  if (!result) return NextResponse.json({ error: "Your disclosures could not be renewed. Refresh and review your account status." }, { status: 409 });
  await writeAuditEvent({ actorUserId: userId, subjectUserId: userId, action: "consent.disclosures_renewed",
    resourceType: "consent", resourceId: "retention_policy", outcome: "success",
    metadata: { policyVersion: ENROLLMENT_DISCLOSURE_VERSION, ...result } });
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "private, no-store" } });
}
