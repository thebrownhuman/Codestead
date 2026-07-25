import { describe, expect, it } from "vitest";

import {
  evaluateTemplateAccountSnapshot,
  PRODUCTION_EMAIL_TEMPLATES,
  resolveEmailTemplateAuthorityPolicy,
  TEMPLATE_AUTHORITY_POLICIES,
  type AccountMailAuthoritySnapshot,
  type TemplateAccountSnapshotDecision,
} from "../template-authority-policy";

const EXPECTED_PRODUCTION_TEMPLATES = [
  "verify-email", "reset-password", "invitation", "access-request-admin",
  "lost-device-proof", "access-rejected", "learning-request-updated",
  "new-device", "session-revocation-requested",
  "session-revocation-updated", "session-revoked", "account-deleted",
  "credential-changed", "credential-revealed", "fallback-grant-changed",
  "learning-plan-changed", "storage-quota-changed", "inactivity-reminder",
  "inactivity-reminder-followup", "inactivity-admin-notice",
  "daily-study-reminder", "revision-reminder", "goal-reminder",
  "challenge-reminder", "mastery-awarded", "appeal-updated",
  "assessment-corrected", "weekly-summary", "backup-status",
] as const;

const activeLearner: AccountMailAuthoritySnapshot = {
  role: "learner", status: "active", banned: false, emailVerified: true,
};

function satisfied(
  remainingAuthority: Extract<
    TemplateAccountSnapshotDecision,
    { kind: "account-snapshot-satisfied" }
  >["remainingAuthority"] = "account-template-source",
): TemplateAccountSnapshotDecision {
  return {
    kind: "account-snapshot-satisfied",
    deliveryAuthorityEstablished: false,
    remainingAuthority,
  };
}

function denied(
  code: Extract<
    TemplateAccountSnapshotDecision,
    { kind: "account-snapshot-denied" }
  >["code"],
): TemplateAccountSnapshotDecision {
  return {
    kind: "account-snapshot-denied",
    deliveryAuthorityEstablished: false,
    code,
  };
}

describe("mail template authority policy", () => {
  it("enumerates every production template exactly once with no exam-result entry", () => {
    expect(PRODUCTION_EMAIL_TEMPLATES).toEqual(EXPECTED_PRODUCTION_TEMPLATES);
    expect(Object.keys(TEMPLATE_AUTHORITY_POLICIES)).toEqual(EXPECTED_PRODUCTION_TEMPLATES);
    expect(new Set(PRODUCTION_EMAIL_TEMPLATES).size)
      .toBe(PRODUCTION_EMAIL_TEMPLATES.length);
    expect(PRODUCTION_EMAIL_TEMPLATES).not.toContain("exam-result");
  });

  it("allows only version 2 for every inactivity template and version 1 otherwise", () => {
    const inactivityTemplates = new Set([
      "inactivity-reminder", "inactivity-reminder-followup",
      "inactivity-admin-notice",
    ]);

    for (const template of PRODUCTION_EMAIL_TEMPLATES) {
      const allowedVersion = inactivityTemplates.has(template) ? "2" : "1";
      const rejectedVersion = allowedVersion === "1" ? "2" : "1";
      expect(resolveEmailTemplateAuthorityPolicy(template, allowedVersion))
        .toMatchObject({ template, templateVersion: allowedVersion });
      expect(resolveEmailTemplateAuthorityPolicy(template, rejectedVersion)).toBeNull();
    }
  });

  it("fails closed for unknown templates and unknown versions", () => {
    expect(resolveEmailTemplateAuthorityPolicy("exam-result", "1")).toBeNull();
    expect(resolveEmailTemplateAuthorityPolicy("future-template", "1")).toBeNull();
    expect(resolveEmailTemplateAuthorityPolicy("weekly-summary", "999")).toBeNull();
    expect(evaluateTemplateAccountSnapshot({
      template: "future-template",
      templateVersion: "1",
      account: activeLearner,
    })).toEqual(denied("UNKNOWN_TEMPLATE"));
    expect(evaluateTemplateAccountSnapshot({
      template: "weekly-summary",
      templateVersion: "999",
      account: activeLearner,
    })).toEqual(denied("TEMPLATE_VERSION_NOT_ALLOWED"));
  });

  it("requires a pending unverified learner for verification mail", () => {
    const input = { template: "verify-email", templateVersion: "1" } as const;
    expect(evaluateTemplateAccountSnapshot({
      ...input,
      account: {
        role: "learner", status: "pending", banned: false, emailVerified: false,
      },
    })).toEqual(satisfied());
    expect(evaluateTemplateAccountSnapshot({
      ...input,
      account: {
        role: "learner", status: "pending", banned: false, emailVerified: true,
      },
    })).toEqual(denied("ACCOUNT_EMAIL_VERIFICATION_NOT_ALLOWED"));
  });

  it("allows reset mail for pending accounts or a verified active account", () => {
    const decisions = [
      { role: "learner", status: "pending", emailVerified: false, allowed: true },
      { role: "learner", status: "pending", emailVerified: true, allowed: true },
      { role: "learner", status: "active", emailVerified: true, allowed: true },
      { role: "learner", status: "active", emailVerified: false, allowed: false },
      { role: "admin", status: "active", emailVerified: true, allowed: true },
      { role: "admin", status: "pending", emailVerified: true, allowed: false },
    ] as const;

    for (const decision of decisions) {
      expect(evaluateTemplateAccountSnapshot({
        template: "reset-password",
        templateVersion: "1",
        account: {
          role: decision.role,
          status: decision.status,
          banned: false,
          emailVerified: decision.emailVerified,
        },
      }).kind).toBe(
        decision.allowed
          ? "account-snapshot-satisfied"
          : "account-snapshot-denied",
      );
    }
  });

  it("requires the exact account role, active state, ban state, and verification state", () => {
    expect(evaluateTemplateAccountSnapshot({
      template: "weekly-summary",
      templateVersion: "1",
      account: activeLearner,
    })).toEqual(satisfied());
    expect(evaluateTemplateAccountSnapshot({
      template: "weekly-summary",
      templateVersion: "1",
      account: { ...activeLearner, role: "admin" },
    })).toEqual(denied("ACCOUNT_ROLE_NOT_ALLOWED"));
    expect(evaluateTemplateAccountSnapshot({
      template: "weekly-summary",
      templateVersion: "1",
      account: { ...activeLearner, status: "suspended" },
    })).toEqual(denied("ACCOUNT_STATUS_NOT_ALLOWED"));
    expect(evaluateTemplateAccountSnapshot({
      template: "weekly-summary",
      templateVersion: "1",
      account: { ...activeLearner, banned: true },
    })).toEqual(denied("ACCOUNT_BANNED"));
    expect(evaluateTemplateAccountSnapshot({
      template: "weekly-summary",
      templateVersion: "1",
      account: { ...activeLearner, emailVerified: false },
    })).toEqual(denied("ACCOUNT_EMAIL_VERIFICATION_NOT_ALLOWED"));
  });

  it("enforces admin-only recipient policies without an ordinary-account fallback", () => {
    const activeAdmin: AccountMailAuthoritySnapshot = {
      role: "admin", status: "active", banned: false, emailVerified: true,
    };

    for (const template of [
      "session-revocation-requested", "inactivity-admin-notice", "backup-status",
    ] as const) {
      const templateVersion = template === "inactivity-admin-notice" ? "2" : "1";
      expect(evaluateTemplateAccountSnapshot({
        template,
        templateVersion,
        account: activeAdmin,
      })).toEqual(satisfied());
      expect(evaluateTemplateAccountSnapshot({
        template,
        templateVersion,
        account: activeLearner,
      })).toEqual(denied("ACCOUNT_ROLE_NOT_ALLOWED"));
    }

    expect(evaluateTemplateAccountSnapshot({
      template: "invitation",
      templateVersion: "1",
      account: activeLearner,
    })).toEqual(denied("ACCOUNT_SNAPSHOT_NOT_APPLICABLE"));
  });

  it("keeps deletion delivery dependent on its separate capability while encoding deleted-account state", () => {
    expect(TEMPLATE_AUTHORITY_POLICIES["account-deleted"]).toMatchObject({
      scope: "deletion-capability",
      capability: "account-deletion-notice-v1",
    });
    expect(evaluateTemplateAccountSnapshot({
      template: "account-deleted",
      templateVersion: "1",
      account: {
        role: "learner", status: "deleted", banned: true, emailVerified: false,
      },
    })).toEqual(satisfied("account-deletion-capability"));
    expect(evaluateTemplateAccountSnapshot({
      template: "account-deleted",
      templateVersion: "1",
      account: activeLearner,
    })).toEqual(denied("ACCOUNT_STATUS_NOT_ALLOWED"));
  });
});
