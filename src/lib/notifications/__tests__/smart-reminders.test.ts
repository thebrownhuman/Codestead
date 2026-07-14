import { describe, expect, it } from "vitest";

import { dueKinds, insideQuietHours, localClock } from "../smart-reminders";

const base = {
  id: "learner-1",
  name: "Learner",
  email: "learner@example.test",
  last_meaningful_activity_at: null,
  timezone: "Asia/Kolkata",
  daily_study_enabled: true,
  revision_enabled: true,
  goal_enabled: true,
  challenge_enabled: true,
  weekly_summary_enabled: true,
  learning_email_enabled: true,
  daily_study_minute: 1_080,
  revision_minute: 1_140,
  quiet_hours_enabled: true,
  quiet_start_minute: 1_320,
  quiet_end_minute: 480,
  review_due: false,
  active_plan: true,
  upcoming_battle: false,
};

describe("smart reminder policy", () => {
  it("uses the learner's IANA time zone and a stable ISO week", () => {
    const clock = localClock(new Date("2026-07-13T13:30:00.000Z"), "Asia/Kolkata");
    expect(clock).toEqual({ dateKey: "2026-07-13", weekKey: "2026-W29", weekday: "Mon", minute: 1_140 });
  });

  it("falls back to UTC for a corrupt persisted time zone", () => {
    expect(localClock(new Date("2026-07-13T13:30:00.000Z"), "Not/AZone").minute).toBe(810);
  });

  it.each([
    [1_319, 1_320, 480, false],
    [1_320, 1_320, 480, true],
    [30, 1_320, 480, true],
    [480, 1_320, 480, false],
    [600, 600, 600, true],
  ])("evaluates wrapping quiet hours (%s, %s, %s)", (minute, start, end, expected) => {
    expect(insideQuietHours(minute, start, end)).toBe(expected);
  });

  it("prioritizes a due review over a generic daily nudge", () => {
    const result = dueKinds(
      { ...base, review_due: true, quiet_hours_enabled: false },
      new Date("2026-07-14T14:00:00.000Z"),
    );
    expect(result).toEqual([{ kind: "revision", periodKey: "2026-07-14" }]);
  });

  it("does not call opening the app learning and suppresses a nudge after meaningful activity", () => {
    const now = new Date("2026-07-14T14:00:00.000Z");
    expect(dueKinds({ ...base, quiet_hours_enabled: false }, now)).toEqual([
      { kind: "daily_study", periodKey: "2026-07-14" },
    ]);
    expect(dueKinds({
      ...base,
      quiet_hours_enabled: false,
      last_meaningful_activity_at: new Date("2026-07-14T04:00:00.000Z"),
    }, now)).toEqual([]);
  });

  it("keeps every evidence-backed due kind available so prior receipts cannot starve lower-priority reminders", () => {
    const result = dueKinds({
      ...base,
      review_due: true,
      upcoming_battle: true,
      quiet_hours_enabled: false,
    }, new Date("2026-07-13T14:00:00.000Z"));
    expect(result).toEqual([
      { kind: "revision", periodKey: "2026-07-13" },
      { kind: "challenge", periodKey: "2026-07-13" },
      { kind: "goal", periodKey: "2026-W29" },
    ]);
  });

  it("waits through quiet hours", () => {
    expect(dueKinds(base, new Date("2026-07-14T20:00:00.000Z"))).toEqual([]);
  });
});
