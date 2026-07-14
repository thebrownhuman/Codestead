const DEFAULT_FRESH_MFA_MS = 5 * 60 * 1_000;

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
