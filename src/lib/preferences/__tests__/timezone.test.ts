import { describe, expect, it } from "vitest";

import { isIanaTimezone, resolveIanaTimezone } from "../timezone";

describe("isIanaTimezone", () => {
  it.each(["Asia/Kolkata", "America/New_York", "UTC"])("accepts %s", (timezone) => {
    expect(isIanaTimezone(timezone)).toBe(true);
  });

  it.each(["Not/AZone", "abc", "", "   ", "Asia/Kolkata; drop"])("rejects %j", (timezone) => {
    expect(isIanaTimezone(timezone)).toBe(false);
  });

  // Intl reads "+05:30" as UTC+05:30 but Postgres AT TIME ZONE reads a bare
  // offset with the POSIX sign (UTC-05:30), so the two would disagree by hours.
  it.each(["+05:30", "-08:00", "+0530", "+05", " +05:30 "])("rejects the numeric offset %j", (timezone) => {
    expect(isIanaTimezone(timezone)).toBe(false);
  });
});

describe("resolveIanaTimezone", () => {
  it("returns a trimmed IANA zone unchanged", () => {
    expect(resolveIanaTimezone(" Asia/Kolkata ")).toBe("Asia/Kolkata");
    expect(resolveIanaTimezone("Etc/GMT+5")).toBe("Etc/GMT+5");
  });

  it.each([null, undefined, "", "Not/AZone", "+05:30", "-08:00"])("falls back to UTC for %j", (timezone) => {
    expect(resolveIanaTimezone(timezone)).toBe("UTC");
  });
});
