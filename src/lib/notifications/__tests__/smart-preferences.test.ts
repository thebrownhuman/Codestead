import { describe, expect, it } from "vitest";

import {
  DEFAULT_SMART_REMINDER_PREFERENCES,
  normalizeIanaTimezone,
  SmartReminderPreferenceError,
} from "../smart-preferences";

describe("smart reminder preference validation", () => {
  it("keeps every optional engagement channel off until the learner opts in", () => {
    expect(DEFAULT_SMART_REMINDER_PREFERENCES).toMatchObject({
      dailyStudyEnabled: false,
      revisionEnabled: false,
      goalEnabled: false,
      challengeEnabled: false,
      weeklySummaryEnabled: false,
      learningEmailEnabled: false,
    });
  });

  it.each(["Asia/Kolkata", "America/New_York", "UTC"])("accepts IANA time zone %s", (timezone) => {
    expect(normalizeIanaTimezone(` ${timezone} `)).toBe(timezone);
  });

  it.each(["", "Not/AZone", "x".repeat(101)])("rejects invalid time zone %s", (timezone) => {
    expect(() => normalizeIanaTimezone(timezone)).toThrow(SmartReminderPreferenceError);
  });
});
