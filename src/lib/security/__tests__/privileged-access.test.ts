import { describe, expect, it } from "vitest";

import {
  ADMIN_STEP_UP_MFA_MS,
  authorizePrivilegedAction,
  isFreshMfa,
  LEARNER_SELF_SERVICE_MFA_MS,
} from "../privileged-access";

describe("privileged access", () => {
  const now = new Date("2026-07-12T00:00:00Z");

  it("requires a recent MFA assertion", () => {
    expect(isFreshMfa(new Date(now.getTime() - 60_000), now)).toBe(true);
    expect(isFreshMfa(new Date(now.getTime() - 25 * 60 * 60_000), now)).toBe(false);
  });

  it("requires admin role, fresh MFA, and a meaningful reason", () => {
    expect(
      authorizePrivilegedAction({
        actorRole: "admin",
        mfaVerifiedAt: new Date(now.getTime() - 60_000),
        reason: "Helping the learner replace an invalid key",
        action: "credential.reveal",
        now,
      }),
    ).toEqual({ allowed: true, code: "AUTHORIZED" });

    expect(
      authorizePrivilegedAction({
        actorRole: "learner",
        mfaVerifiedAt: now,
        reason: "A sufficiently clear reason",
        action: "credential.reveal",
        now,
      }).code,
    ).toBe("ADMIN_REQUIRED");
  });

  it.each(["data.export", "account.delete", "plan.manage"] as const)(
    "applies the same fresh-MFA and reason gate to %s",
    (action) => {
      expect(authorizePrivilegedAction({
        actorRole: "admin",
        mfaVerifiedAt: new Date(now.getTime() - 60_000),
        reason: "A reviewed lifecycle operation reason",
        action,
        now,
      })).toEqual({ allowed: true, code: "AUTHORIZED" });
      expect(authorizePrivilegedAction({
        actorRole: "admin",
        mfaVerifiedAt: new Date(now.getTime() - 25 * 60 * 60_000),
        reason: "A reviewed lifecycle operation reason",
        action,
        now,
      }).code).toBe("FRESH_MFA_REQUIRED");
    },
  );

  it.each([
    "credential.test",
    "credential.replace",
    "credential.enable",
    "credential.disable",
    "credential.delete",
  ] as const)("requires fresh MFA and reason for administrator %s", (action) => {
    expect(authorizePrivilegedAction({
      actorRole: "admin",
      mfaVerifiedAt: now,
      reason: "A specific credential lifecycle reason",
      action,
      now,
    })).toEqual({ allowed: true, code: "AUTHORIZED" });
    expect(authorizePrivilegedAction({
      actorRole: "admin",
      mfaVerifiedAt: new Date(now.getTime() - 25 * 60 * 60_000),
      reason: "A specific credential lifecycle reason",
      action,
      now,
    }).code).toBe("FRESH_MFA_REQUIRED");
  });

  it("keeps administrator privileged actions on the 24-hour step-up window", () => {
    const staleBeyondOneDay = new Date(now.getTime() - 25 * 60 * 60_000);
    expect(authorizePrivilegedAction({
      actorRole: "admin",
      mfaVerifiedAt: staleBeyondOneDay,
      reason: "Rotating a leaked provider key",
      action: "role.change",
      now,
    })).toEqual({ allowed: false, code: "FRESH_MFA_REQUIRED" });
    expect(ADMIN_STEP_UP_MFA_MS).toBe(24 * 60 * 60_000);
    expect(LEARNER_SELF_SERVICE_MFA_MS).toBe(Number.POSITIVE_INFINITY);
  });
});
