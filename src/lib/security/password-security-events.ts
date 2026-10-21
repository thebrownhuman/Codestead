import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { user, verification } from "@/lib/db/schema";
import { enqueueEmail } from "@/lib/notifications/outbox";
import { writeAuditEvent } from "./audit-writer";
import { hasCredentialPassword } from "./password-settings";

export type PasswordChangeKind = "reset" | "change" | "forced_change";

const AUDIT_ACTION: Record<PasswordChangeKind, string> = {
  reset: "account.password_reset",
  change: "account.password_change",
  forced_change: "account.forced_password_change",
};

/**
 * Better Auth's twoFactor plugin keeps "trust this device" grants as
 * verification rows (`trust-device-*`, value = user id). Session revocation
 * does not touch them, so a reset or change must, or a previously trusted
 * browser could skip the second factor with the new password.
 */
export async function clearTrustedDevices(userId: string) {
  await db.delete(verification).where(and(eq(verification.value, userId), like(verification.identifier, "trust-device-%")));
}

/**
 * Only an active, unbanned account that already has a password may be reset
 * by email. Google-only accounts must not gain an email-controlled password.
 */
export async function mayResetPassword(userId: string) {
  const [owner] = await db.select({ status: user.status, banned: user.banned }).from(user).where(eq(user.id, userId)).limit(1);
  if (!owner || owner.status !== "active" || owner.banned === true) return false;
  return hasCredentialPassword(userId);
}

/**
 * Audit row plus a link-free "your password was changed" notice. Called after
 * the password is already rotated, so failures are logged, never thrown.
 */
export async function recordPasswordChanged(input: { userId: string; kind: PasswordChangeKind; audit?: boolean }) {
  if (input.audit !== false) {
    try {
      await writeAuditEvent({
        actorUserId: input.userId,
        subjectUserId: input.userId,
        action: AUDIT_ACTION[input.kind],
        resourceType: "user",
        resourceId: input.userId,
        outcome: "success",
      });
    } catch {
      console.error("password_change_audit_failed");
    }
  }
  try {
    const [owner] = await db.select({ email: user.email, name: user.name }).from(user).where(eq(user.id, input.userId)).limit(1);
    if (!owner) return;
    await enqueueEmail({
      to: owner.email,
      userId: input.userId,
      template: "password-changed",
      variables: {
        name: owner.name,
        url: `${process.env.APP_URL ?? "http://localhost:3000"}/settings?section=device`,
      },
      idempotencySeed: `password-changed:${randomUUID()}`,
    });
  } catch {
    console.error("password_change_notice_failed");
  }
}
