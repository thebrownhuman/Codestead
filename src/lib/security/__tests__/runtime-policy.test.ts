import { describe, expect, it } from "vitest";

import { isApplicationAuthRequired } from "../runtime-policy";

describe("application authentication policy", () => {
  it("cannot be disabled in production", () => {
    expect(isApplicationAuthRequired("production", "false")).toBe(true);
    expect(isApplicationAuthRequired("production", undefined)).toBe(true);
  });

  it("is fail-closed when no development override is present", () => {
    expect(isApplicationAuthRequired("development", undefined)).toBe(true);
    expect(isApplicationAuthRequired("test", "true")).toBe(true);
  });

  it("allows the explicit local demo override outside production", () => {
    expect(isApplicationAuthRequired("development", "false")).toBe(false);
    expect(isApplicationAuthRequired("test", "false")).toBe(false);
  });
});
