/**
 * Step-up freshness windows (how long an authenticator verification on this
 * device session counts as "fresh").
 *
 * Owner decision (PingID-style, 2026-09-26):
 * - Administrator privileged actions accept a verification from the last
 *   24 hours on the same session (authorizePrivilegedAction).
 * - Learner self-service actions (own AI keys, onboarding) need no extra code
 *   while the MFA-completed session lasts.
 * - A TOTP-verified browser is trusted for 24 hours at sign-in
 *   (auth.ts trustDeviceMaxAge); new or untrusted devices still need a code.
 *
 * Neither window applies to one-device takeover, password change, 2FA
 * disable or recovery: those always require a fresh code or password in the
 * same request.
 */
export const ADMIN_STEP_UP_MFA_MS = 24 * 60 * 60 * 1_000;
// Learner self-service (own AI keys, onboarding) needs no extra code while the
// MFA-completed session lasts.
export const LEARNER_SELF_SERVICE_MFA_MS = Number.POSITIVE_INFINITY;
const DEFAULT_FRESH_MFA_MS = ADMIN_STEP_UP_MFA_MS;

export type PrivilegedAction =
  | "credential.reveal"
  | "credential.replace"
  | "credential.test"
  | "credential.enable"
  | "credential.disable"
  | "credential.delete"
  | "fallback_grant.manage"
  | "session.revoke"
  | "user.impersonate"
  | "role.change"
  | "content.triage"
  | "backup.restore"
  | "data.export"
  | "account.delete"
  | "storage.quota.manage"
  | "appeal.decide"
  | "assessment.regrade"
  | "mentor.evidence.read"
  | "plan.manage"
  | "curriculum.stage"
  | "curriculum.review"
  | "curriculum.publish"
  | "curriculum.rollback"
  | "certificate.revoke"
  | "career.publish"
  | "career.retire"
  | "community.moderate.delete"
  | "notification.pause"
  | "exam.reexam.grant"
  | "runner.practice.quarantine.resolve";

export function isFreshMfa(
  verifiedAt: Date | null | undefined,
  now = new Date(),
  maxAgeMs = DEFAULT_FRESH_MFA_MS,
) {
  if (!verifiedAt) return false;
  const age = now.getTime() - verifiedAt.getTime();
  return age >= 0 && age <= maxAgeMs;
}

export function authorizePrivilegedAction(input: {
  actorRole: string | null | undefined;
  mfaVerifiedAt: Date | null | undefined;
  reason: string | null | undefined;
  action: PrivilegedAction;
  now?: Date;
}) {
  if (input.actorRole !== "admin") {
    return { allowed: false as const, code: "ADMIN_REQUIRED" };
  }
  if (!isFreshMfa(input.mfaVerifiedAt, input.now)) {
    return { allowed: false as const, code: "FRESH_MFA_REQUIRED" };
  }
  if (!input.reason || input.reason.trim().length < 8) {
    return { allowed: false as const, code: "REASON_REQUIRED" };
  }
  if (input.reason.length > 500) {
    return { allowed: false as const, code: "REASON_TOO_LONG" };
  }
  return { allowed: true as const, code: "AUTHORIZED" };
}
