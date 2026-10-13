import { describe, expect, it } from "vitest";
import { curriculumReleaseEvidenceSchema, generateReleaseEvidenceRequestSchema, notRunReportSchema } from "../contracts";

const input = { requestId: "f1000000-0000-4000-8000-000000000001", expectedVersion: 1,
  expectedContentHash: "a".repeat(64), reason: "Owner acknowledges beta checks have not run.",
  acknowledgeNotRun: true, notRunReason: "Live checks await the grading parity fix." };

describe("release generation boundary", () => {
  it("requires explicit acknowledgement and a non-empty reason", () => {
    expect(generateReleaseEvidenceRequestSchema.safeParse(input).success).toBe(true);
    expect(generateReleaseEvidenceRequestSchema.safeParse({ ...input, acknowledgeNotRun: false }).success).toBe(false);
    expect(generateReleaseEvidenceRequestSchema.safeParse({ ...input, notRunReason: " " }).success).toBe(false);
  });
  it("rejects client attestations and client passed reports", () => {
    for (const extra of [{ acknowledgedBy: "admin" }, { acknowledgedAt: new Date().toISOString() },
      { evidence: { sourceCoverage: { passed: true } } }, { sourceCoverage: { passed: true } }]) {
      expect(generateReleaseEvidenceRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });
  it("requires server acknowledgement metadata in stored not_run reports", () => {
    const report = { status: "not_run", reason: input.notRunReason };
    expect(notRunReportSchema.safeParse(report).success).toBe(false);
    expect(notRunReportSchema.safeParse({ ...report, acknowledgedBy: "admin-user-id", acknowledgedAt: "2026-10-07T12:00:00Z" }).success).toBe(true);
    expect(notRunReportSchema.safeParse({ ...report, acknowledgedBy: "", acknowledgedAt: "invalid" }).success).toBe(false);
  });
  it("keeps computed reports mandatory and passes hash-bound", () => {
    const notRun = { status: "not_run", reason: "manual", acknowledgedBy: "admin", acknowledgedAt: "2026-10-07T12:00:00Z" };
    for (const name of ["sourceCoverage", "skillCoverage", "dagMastery", "exclusions"] as const) {
      expect(curriculumReleaseEvidenceSchema.shape[name].safeParse(notRun).success).toBe(false);
    }
    expect(curriculumReleaseEvidenceSchema.shape.dagMastery.safeParse({ passed: true }).success).toBe(false);
    expect(curriculumReleaseEvidenceSchema.shape.security.safeParse({ passed: true, reportHash: "invalid" }).success).toBe(false);
    expect(curriculumReleaseEvidenceSchema.shape.security.safeParse({ ...notRun, passed: true }).success).toBe(false);
  });
});
