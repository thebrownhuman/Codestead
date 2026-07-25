import { describe, expect, it } from "vitest";

import {
  evaluateTemplateAccountSnapshot,
  type AccountMailAuthoritySnapshot,
} from "../template-authority-policy";

const activeLearner: AccountMailAuthoritySnapshot = {
  role: "learner",
  status: "active",
  banned: false,
  emailVerified: true,
};

const activeAdmin: AccountMailAuthoritySnapshot = {
  role: "admin",
  status: "active",
  banned: false,
  emailVerified: true,
};

function evaluate(
  template: string,
  account: AccountMailAuthoritySnapshot,
  templateVersion = "1",
) {
  return evaluateTemplateAccountSnapshot({
    template,
    templateVersion,
    account,
  });
}

describe("mail template producer-compatible account snapshots", () => {
  it.each([
    ["new-device", { ...activeLearner, status: "pending" }],
    ["new-device", activeLearner],
    ["new-device", activeAdmin],
    ["credential-changed", { ...activeLearner, status: "pending" }],
    ["credential-changed", activeLearner],
    ["fallback-grant-changed", { ...activeLearner, status: "pending" }],
    ["fallback-grant-changed", activeLearner],
  ] as const)("accepts the legitimate %s producer state", (template, account) => {
    expect(evaluate(template, account)).toEqual({
      kind: "account-snapshot-satisfied",
      deliveryAuthorityEstablished: false,
      remainingAuthority: "account-template-source",
    });
  });

  it.each([
    ["new-device", { ...activeLearner, status: "pending", emailVerified: false }],
    ["new-device", { ...activeAdmin, status: "pending" }],
    ["credential-changed", { ...activeLearner, status: "pending", emailVerified: false }],
    ["credential-changed", activeAdmin],
    ["fallback-grant-changed", { ...activeLearner, status: "pending", emailVerified: false }],
    ["fallback-grant-changed", activeAdmin],
  ] as const)("fails closed outside the %s producer states", (template, account) => {
    expect(evaluate(template, account).kind).toBe("account-snapshot-denied");
  });

  it.each([
    "session-revocation-updated",
    "session-revoked",
  ] as const)("allows only an active learner for %s", (template) => {
    expect(evaluate(template, activeLearner).kind).toBe(
      "account-snapshot-satisfied",
    );
    expect(evaluate(template, activeAdmin)).toEqual({
      kind: "account-snapshot-denied",
      deliveryAuthorityEstablished: false,
      code: "ACCOUNT_ROLE_NOT_ALLOWED",
    });
  });
});

describe("account snapshot result contract", () => {
  it("never represents an account snapshot as total delivery authority", () => {
    expect(evaluate("weekly-summary", activeLearner)).toEqual({
      kind: "account-snapshot-satisfied",
      deliveryAuthorityEstablished: false,
      remainingAuthority: "account-template-source",
    });
    expect(evaluate("access-request-admin", activeAdmin)).toEqual({
      kind: "account-snapshot-satisfied",
      deliveryAuthorityEstablished: false,
      remainingAuthority: "system-source",
    });
    expect(evaluate("account-deleted", {
      role: "learner",
      status: "deleted",
      banned: false,
      emailVerified: true,
    })).toEqual({
      kind: "account-snapshot-satisfied",
      deliveryAuthorityEstablished: false,
      remainingAuthority: "account-deletion-capability",
    });
  });

  it("marks denials and inapplicable external recipients as non-authority too", () => {
    expect(evaluate("invitation", activeLearner)).toEqual({
      kind: "account-snapshot-denied",
      deliveryAuthorityEstablished: false,
      code: "ACCOUNT_SNAPSHOT_NOT_APPLICABLE",
    });
    expect(evaluate("future-template", activeLearner)).toEqual({
      kind: "account-snapshot-denied",
      deliveryAuthorityEstablished: false,
      code: "UNKNOWN_TEMPLATE",
    });
  });
});
