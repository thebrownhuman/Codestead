export type AccountStatus = "pending" | "active" | "suspended" | "deletion_pending" | "deleted";

export function accountMayUseProtectedFeatures(
  status: AccountStatus | string | null | undefined,
  allowPending = false,
  mfaEnabled = true,
  sessionMfaCompleted = false,
) {
  return (
    (status === "active" && mfaEnabled && sessionMfaCompleted) ||
    (allowPending && status === "pending")
  );
}
