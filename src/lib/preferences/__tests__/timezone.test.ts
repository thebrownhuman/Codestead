import { describe, expect, it } from "vitest";

import { isIanaTimezone } from "../timezone";

describe("isIanaTimezone", () => {
  it.each(["Asia/Kolkata", "America/New_York", "UTC"])("accepts %s", (timezone) => {
    expect(isIanaTimezone(timezone)).toBe(true);
  });

  it.each(["Not/AZone", "abc", "", "   ", "Asia/Kolkata; drop"])("rejects %j", (timezone) => {
    expect(isIanaTimezone(timezone)).toBe(false);
  });
});
