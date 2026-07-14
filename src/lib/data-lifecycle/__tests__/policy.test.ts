import { describe, expect, it } from "vitest";

import {
  addUtcMonths,
  RETENTION_POLICY,
  retentionCutoff,
  retentionCutoffManifest,
  subtractUtcMonths,
} from "../policy";

describe("versioned retention policy", () => {
  it("matches the approved category defaults without an automatic evidence or audit purge", () => {
    expect(RETENTION_POLICY.version).toBe("2026-07-14.v4");
    expect(RETENTION_POLICY.categories.rawChat.duration).toEqual({ unit: "months", value: 12 });
    expect(RETENTION_POLICY.categories.rawCode.duration).toEqual({ unit: "months", value: 12 });
    expect(RETENTION_POLICY.categories.aiRequestMetadataAndAttachments.duration).toEqual({ unit: "months", value: 12 });
    expect(RETENTION_POLICY.categories.securitySessionHistory).toMatchObject({
      duration: { unit: "days", value: 90 }, exception: "official_evidence",
    });
    expect(RETENTION_POLICY.categories.adminAudit).toMatchObject({
      duration: { unit: "minimum_months", value: 24 }, action: "retain_no_automatic_purge",
    });
    expect(RETENTION_POLICY.categories.masteryAndOfficialEvidence.action).toBe("delete_only_with_account");
    expect(RETENTION_POLICY.categories.learnerDraftsAndSyncReceipts).toMatchObject({
      duration: { unit: "until_admin_account_deletion" }, action: "delete_only_with_account",
    });
    expect(RETENTION_POLICY.categories.projectRevisionHistory).toMatchObject({
      duration: { unit: "until_admin_account_deletion" }, action: "delete_only_with_account",
    });
    expect(RETENTION_POLICY.categories.certificatesAndPublicPortfolio).toMatchObject({
      duration: { unit: "until_admin_account_deletion" }, action: "delete_only_with_account",
    });
  });

  it("uses calendar-correct UTC month cutoffs, including leap-day clamping", () => {
    expect(subtractUtcMonths(new Date("2024-02-29T12:34:56.789Z"), 12).toISOString())
      .toBe("2023-02-28T12:34:56.789Z");
    expect(addUtcMonths(new Date("2024-02-29T12:34:56.789Z"), 12).toISOString())
      .toBe("2025-02-28T12:34:56.789Z");
    expect(subtractUtcMonths(new Date("2025-03-31T01:02:03.004Z"), 1).toISOString())
      .toBe("2025-02-28T01:02:03.004Z");
    expect(subtractUtcMonths(new Date("2025-01-15T01:02:03.004Z"), 2).toISOString())
      .toBe("2024-11-15T01:02:03.004Z");
  });

  it("creates explicit UTC cutoffs from one immutable job timestamp", () => {
    const manifest = retentionCutoffManifest(new Date("2026-07-12T00:00:00.000Z"));
    expect(manifest.rawChat).toBe("2025-07-12T00:00:00.000Z");
    expect(manifest.securitySessionHistory).toBe("2026-04-13T00:00:00.000Z");
    expect(manifest.adminAuditMinimum).toBe("2024-07-12T00:00:00.000Z");
    expect(Object.values(manifest).every((value) => value.endsWith("Z"))).toBe(true);
  });

  it("uses exact UTC day durations and rejects invalid policy arithmetic", () => {
    const now = new Date("2026-07-12T00:00:00.000Z");
    expect(retentionCutoff(now, { unit: "days", value: 90 })?.toISOString())
      .toBe("2026-04-13T00:00:00.000Z");
    expect(retentionCutoff(now, { unit: "until_admin_account_deletion" })).toBeNull();
    expect(() => subtractUtcMonths(now, -1)).toThrow(/non-negative/i);
    expect(() => addUtcMonths(now, 1.5)).toThrow(/whole month/i);
    expect(() => retentionCutoff(now, { unit: "days", value: -1 })).toThrow(/whole day/i);
    expect(() => retentionCutoff(new Date(Number.NaN), { unit: "days", value: 1 }))
      .toThrow(/valid utc date/i);
  });
});
