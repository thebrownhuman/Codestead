/**
 * Step-up freshness windows (how long an authenticator verification on this
 * device session counts as "fresh").
 *
 * - Administrator privileged actions (role/credential management, data
 *   erasure/export, curriculum publication, revocations, …) keep a short
 *   5-minute step-up window via authorizePrivilegedAction.
 * - Learner self-service actions (own AI keys, onboarding) accept a
 *   verification from the last 24 hours on the same session, like a daily
 *   PingID prompt.
 *
 * Neither window applies to one-device takeover, password change, 2FA
 * disable or recovery: those always require a fresh code or password in the
 * same request.
 */
export const ADMIN_STEP_UP_MFA_MS = 5 * 60 * 1_000;
export const LEARNER_SELF_SERVICE_MFA_MS = 24 * 60 * 60 * 1_000;
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
