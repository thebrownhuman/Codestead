import { describe, expect, it } from "vitest";

import { accountMayUseProtectedFeatures } from "../account-policy";

describe("account access policy", () => {
  it("allows active accounts", () => {
    expect(accountMayUseProtectedFeatures("active", false, true, true)).toBe(true);
  });

  it("blocks an active account whose MFA was removed", () => {
    expect(accountMayUseProtectedFeatures("active", false, false, true)).toBe(false);
  });

  it("blocks an active account whose current session did not complete MFA", () => {
    expect(accountMayUseProtectedFeatures("active", false, true, false)).toBe(false);
  });

  it("allows pending accounts only in explicit onboarding flows", () => {
    expect(accountMayUseProtectedFeatures("pending")).toBe(false);
    expect(accountMayUseProtectedFeatures("pending", true, false)).toBe(true);
  });

  it.each(["suspended", "deletion_pending", "deleted", undefined])(
    "blocks %s accounts even for onboarding",
    (status) => {
      expect(accountMayUseProtectedFeatures(status, true)).toBe(false);
    },
  );
});
