import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";

import { dueKinds, insideQuietHours, localClock } from "../smart-reminders";
import { scheduleSmartReminders } from "../smart-reminders";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  db: { transaction: mocks.transaction },
  pool: { query: mocks.poolQuery },
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

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

  it("does not log Error names, codes, or messages containing mail canaries", async () => {
    vi.stubEnv("INTEGRATION_TEST", "1");
    const recipient = "private.person@recipient.example";
    const token = "bearer-token=smart-reminder-log-canary";
    const body = "private reminder body must not reach logs";
    const cause = Object.assign(new Error(
      `${body}; recipient=${recipient}; token=${token}`,
    ), {
      code: `CAUSE:${recipient}`,
    });
    const failure = Object.assign(new Error(body), {
      name: `ReminderFailure:${recipient}`,
      code: `DATABASE:${token}`,
      cause,
    });
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{ ...base, quiet_hours_enabled: false }],
    });
    mocks.transaction.mockRejectedValueOnce(failure);
    const logEntry = vi.spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(scheduleSmartReminders(
      new Date("2026-07-14T14:00:00.000Z"),
      1,
    )).resolves.toEqual({
      candidates: 1,
      dispatched: 0,
      failed: 1,
    });

    const entries = logEntry.mock.calls
      .map(([entry]) => String(entry))
      .filter((entry) => entry.includes('"event":"smart_reminder.dispatch_failed"'));
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!)).toEqual({
      event: "smart_reminder.dispatch_failed",
      kind: "daily_study",
      errorName: "ERROR",
    });
    for (const canary of [recipient, token, body]) {
      expect(entries[0]).not.toContain(canary);
    }
  });

  it("waits through quiet hours", () => {
    expect(dueKinds(base, new Date("2026-07-14T20:00:00.000Z"))).toEqual([]);
  });
});
