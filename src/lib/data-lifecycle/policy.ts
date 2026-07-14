export const RETENTION_POLICY_VERSION = "2026-07-14.v4" as const;

export type RetentionDuration =
  | Readonly<{ unit: "days"; value: number }>
  | Readonly<{ unit: "months"; value: number }>
  | Readonly<{ unit: "until_admin_account_deletion" }>
  | Readonly<{ unit: "minimum_months"; value: number }>;

export const RETENTION_POLICY = Object.freeze({
  version: RETENTION_POLICY_VERSION,
  timezone: "UTC",
  categories: Object.freeze({
    rawChat: Object.freeze({ duration: { unit: "months", value: 12 } as const, action: "delete" as const }),
    rawCode: Object.freeze({ duration: { unit: "months", value: 12 } as const, action: "delete" as const }),
    aiRequestMetadataAndAttachments: Object.freeze({ duration: { unit: "months", value: 12 } as const, action: "delete" as const }),
    securitySessionHistory: Object.freeze({
      duration: { unit: "days", value: 90 } as const,
      action: "delete" as const,
      exception: "official_evidence" as const,
    }),
    adminAudit: Object.freeze({
      duration: { unit: "minimum_months", value: 24 } as const,
      action: "retain_no_automatic_purge" as const,
    }),
    temporaryObjects: Object.freeze({ duration: { unit: "days", value: 1 } as const, action: "delete" as const }),
    failedQuarantinedOrSoftDeletedObjects: Object.freeze({ duration: { unit: "days", value: 7 } as const, action: "delete" as const }),
    terminalEmailDeliveryRecords: Object.freeze({ duration: { unit: "days", value: 30 } as const, action: "delete" as const }),
    masteryAndOfficialEvidence: Object.freeze({
      duration: { unit: "until_admin_account_deletion" } as const,
      action: "delete_only_with_account" as const,
    }),
    learnerDraftsAndSyncReceipts: Object.freeze({
      duration: { unit: "until_admin_account_deletion" } as const,
      action: "delete_only_with_account" as const,
    }),
    projectRevisionHistory: Object.freeze({
      duration: { unit: "until_admin_account_deletion" } as const,
      action: "delete_only_with_account" as const,
    }),
    certificatesAndPublicPortfolio: Object.freeze({
      duration: { unit: "until_admin_account_deletion" } as const,
      action: "delete_only_with_account" as const,
    }),
    encryptedBackupsAfterAccountDeletion: Object.freeze({
      duration: { unit: "months", value: 12 } as const,
      action: "await_operator_verified_expiry" as const,
    }),
  }),
} as const);

function shiftUtcMonths(now: Date, deltaMonths: number) {
  const absoluteMonth = now.getUTCFullYear() * 12 + now.getUTCMonth() + deltaMonths;
  const year = Math.floor(absoluteMonth / 12);
  const month = ((absoluteMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const shifted = new Date(Date.UTC(
    year,
    month,
    Math.min(now.getUTCDate(), lastDay),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds(),
  ));
  if (!Number.isFinite(shifted.getTime())) {
    throw new Error("The requested UTC month shift is outside the supported date range.");
  }
  return shifted;
}

export function subtractUtcMonths(now: Date, months: number) {
  if (!Number.isSafeInteger(months) || months < 0 || !Number.isFinite(now.getTime())) {
    throw new Error("A valid UTC date and non-negative whole month count are required.");
  }
  return shiftUtcMonths(now, -months);
}

export function addUtcMonths(now: Date, months: number) {
  if (!Number.isSafeInteger(months) || months < 0 || !Number.isFinite(now.getTime())) {
    throw new Error("A valid UTC date and non-negative whole month count are required.");
  }
  return shiftUtcMonths(now, months);
}

export function retentionCutoff(now: Date, duration: RetentionDuration) {
  if (!Number.isFinite(now.getTime())) throw new Error("A valid UTC date is required.");
  if (duration.unit === "days") {
    if (!Number.isSafeInteger(duration.value) || duration.value < 0) {
      throw new Error("A non-negative whole day count is required.");
    }
    const cutoff = new Date(now.getTime() - duration.value * 86_400_000);
    if (!Number.isFinite(cutoff.getTime())) {
      throw new Error("The requested UTC day shift is outside the supported date range.");
    }
    return cutoff;
  }
  if (duration.unit === "months" || duration.unit === "minimum_months") {
    return subtractUtcMonths(now, duration.value);
  }
  return null;
}

export function retentionCutoffManifest(now: Date) {
  const categories = RETENTION_POLICY.categories;
  return {
    rawChat: retentionCutoff(now, categories.rawChat.duration)!.toISOString(),
    rawCode: retentionCutoff(now, categories.rawCode.duration)!.toISOString(),
    aiRequestMetadataAndAttachments: retentionCutoff(
      now,
      categories.aiRequestMetadataAndAttachments.duration,
    )!.toISOString(),
    securitySessionHistory: retentionCutoff(
      now,
      categories.securitySessionHistory.duration,
    )!.toISOString(),
    adminAuditMinimum: retentionCutoff(now, categories.adminAudit.duration)!.toISOString(),
    temporaryObjects: retentionCutoff(now, categories.temporaryObjects.duration)!.toISOString(),
    failedQuarantinedOrSoftDeletedObjects: retentionCutoff(
      now,
      categories.failedQuarantinedOrSoftDeletedObjects.duration,
    )!.toISOString(),
    terminalEmailDeliveryRecords: retentionCutoff(
      now,
      categories.terminalEmailDeliveryRecords.duration,
    )!.toISOString(),
  } as const;
}
