import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  backupExpiryReport,
  deleteLearnerAccount,
  deletionIdentityHash,
} from "../deletion";

describe("account deletion tombstone identity", () => {
  const input = { userId: "learner-1", email: "Learner@Example.COM" };
  const key = "a deletion-only key with at least thirty-two bytes";

  it("creates a stable domain-separated keyed hash without retaining identity text", () => {
    const hash = deletionIdentityHash(input, key);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(deletionIdentityHash({ ...input, email: "learner@example.com" }, key));
    expect(hash).not.toContain("learner");
    expect(hash).not.toContain("example");
  });

  it("changes with identity or independent key and rejects a weak key", () => {
    expect(deletionIdentityHash(input, `${key}-different`)).not.toBe(deletionIdentityHash(input, key));
    expect(deletionIdentityHash({ ...input, userId: "learner-2" }, key)).not.toBe(deletionIdentityHash(input, key));
    expect(() => deletionIdentityHash(input, "short")).toThrow(/too short/i);
  });

  it("rejects malformed destructive requests before any database mutation", async () => {
    const base = {
      actorUserId: "admin-1",
      learnerId: "learner-1",
      reason: "Confirmed account deletion request",
    };
    await expect(deleteLearnerAccount({
      ...base,
      requestId: "------------------------------------",
    })).rejects.toThrow(/uuid/i);
    await expect(deleteLearnerAccount({
      ...base,
      requestId: "80000000-0000-4000-8000-000000000001",
      now: new Date(Number.NaN),
    })).rejects.toThrow(/timestamp/i);
    await expect(deleteLearnerAccount({
      ...base,
      requestId: "80000000-0000-4000-8000-000000000001",
      reason: "short",
    })).rejects.toThrow(/reason/i);
  });

  it("rejects an invalid backup-report timestamp before querying storage", async () => {
    await expect(backupExpiryReport(new Date(Number.NaN))).rejects.toThrow(/timestamp/i);
  });

  it("explicitly erases daily-review bindings before their attempts", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/data-lifecycle/deletion.ts"), "utf8");
    const itemDeletion = source.indexOf('delete from daily_review_item where user_id = $1');
    const sessionDeletion = source.indexOf('delete from daily_review_session where user_id = $1');
    const attemptDeletion = source.indexOf('delete from attempt where user_id = $1');

    expect(itemDeletion).toBeGreaterThan(-1);
    expect(sessionDeletion).toBeGreaterThan(itemDeletion);
    expect(attemptDeletion).toBeGreaterThan(sessionDeletion);
  });

  it("erases append-only reward receipts and ledger before source evidence", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/data-lifecycle/deletion.ts"), "utf8");
    const jobDeletion = source.indexOf("delete from reward_reconciliation_job where user_id = $1");
    const receiptDeletion = source.indexOf("delete from reward_operation_receipt where user_id = $1");
    const ledgerDeletion = source.indexOf("delete from reward_ledger where user_id = $1");
    const evidenceDeletion = source.indexOf("delete from mastery_evidence where user_id = $1");
    const attemptDeletion = source.indexOf("delete from attempt where user_id = $1");

    expect(jobDeletion).toBeGreaterThan(-1);
    expect(receiptDeletion).toBeGreaterThan(jobDeletion);
    expect(ledgerDeletion).toBeGreaterThan(receiptDeletion);
    expect(evidenceDeletion).toBeGreaterThan(ledgerDeletion);
    expect(attemptDeletion).toBeGreaterThan(ledgerDeletion);
  });

  it("withdraws every public projection and certificate receipt before owned source rows", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/data-lifecycle/deletion.ts"), "utf8");
    const publicProjectSnapshot = source.indexOf("delete from public_portfolio_project_snapshot where user_id = $1");
    const publicProject = source.indexOf("delete from public_portfolio_project where user_id = $1");
    const publicAchievement = source.indexOf("delete from public_portfolio_achievement where user_id = $1");
    const publicCertificate = source.indexOf("delete from public_portfolio_certificate where user_id = $1");
    const portfolioEvent = source.indexOf("delete from public_portfolio_event where user_id = $1 or actor_user_id = $1");
    const certificateReceipt = source.indexOf("delete from certificate_operation_receipt where user_id = $1");
    const certificate = source.indexOf("delete from course_certificate where user_id = $1");
    const achievement = source.indexOf("delete from user_achievement where user_id = $1");
    const project = source.indexOf("delete from project where user_id = $1");
    const enrollment = source.indexOf("delete from enrollment where user_id = $1");

    for (const position of [publicProjectSnapshot, publicProject, publicAchievement, publicCertificate, portfolioEvent, certificateReceipt, certificate]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(publicProjectSnapshot).toBeLessThan(publicProject);
    expect(publicProjectSnapshot).toBeLessThan(project);
    expect(publicProject).toBeLessThan(project);
    expect(publicAchievement).toBeLessThan(achievement);
    expect(publicCertificate).toBeLessThan(certificate);
    expect(certificateReceipt).toBeLessThan(certificate);
    expect(certificate).toBeLessThan(enrollment);
  });

  it("erases smart-reminder dispatch receipts before the preference row", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/data-lifecycle/deletion.ts"), "utf8");
    const dispatches = source.indexOf("delete from smart_reminder_dispatch where user_id = $1");
    const preferences = source.indexOf("delete from notification_preference where user_id = $1");

    expect(dispatches).toBeGreaterThan(-1);
    expect(preferences).toBeGreaterThan(dispatches);
  });

  it("erases community operation receipts before shared community projections", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/data-lifecycle/deletion.ts"), "utf8");
    const receipts = source.indexOf("delete from community_operation_receipt where user_id = $1");
    const reports = source.indexOf("delete from community_report where reporter_user_id = $1");
    const posts = source.indexOf("update community_post");

    expect(receipts).toBeGreaterThan(-1);
    expect(reports).toBeGreaterThan(receipts);
    expect(posts).toBeGreaterThan(receipts);
  });
});
