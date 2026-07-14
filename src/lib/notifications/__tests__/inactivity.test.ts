import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIRST_REMINDER_AFTER_MS,
  isWithinQuietHours,
  localMinuteOfDay,
  resolveIanaTimeZone,
  scheduleInactivityReminders,
  SECOND_REMINDER_AFTER_MS,
} from "../inactivity";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";

const NOW = new Date("2026-07-12T12:00:00.000Z");

type SchedulerCandidate = {
  user_id: string;
  name: string;
  email: string;
  timezone: string;
  last_activity_at: Date;
  consent_decision: string | null;
  consent_policy_version: string | null;
  quiet_hours_enabled: boolean | null;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  inactivity_paused_until: Date | null;
  episode_id: string | null;
  episode_last_activity_at: Date | null;
  eligible_at: Date | null;
  second_eligible_at: Date | null;
  learner_first_queued_at: Date | null;
  admin_notice_queued_at: Date | null;
  learner_second_queued_at: Date | null;
};

function candidate(id: string, overrides: Partial<SchedulerCandidate> = {}): SchedulerCandidate {
  const baseline = new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS);
  return {
    user_id: id,
    name: `Learner ${id}`,
    email: `${id}@example.test`,
    timezone: "UTC",
    last_activity_at: baseline,
    consent_decision: "accepted",
    consent_policy_version: ENROLLMENT_DISCLOSURE_VERSION,
    quiet_hours_enabled: false,
    quiet_start_minute: 1_320,
    quiet_end_minute: 480,
    inactivity_paused_until: null,
    episode_id: null,
    episode_last_activity_at: null,
    eligible_at: null,
    second_eligible_at: null,
    learner_first_queued_at: null,
    admin_notice_queued_at: null,
    learner_second_queued_at: null,
    ...overrides,
  };
}

function fakeScheduler(input: {
  candidates: SchedulerCandidate[];
  administrator?: { id: string; email: string } | null;
  episodeInsertConflicts?: string[];
  emailInsertConflicts?: string[];
  durableEmailConflict?: boolean;
}) {
  const calls: Array<{ statement: string; values: unknown[] }> = [];
  let released = false;
  const query = vi.fn(async (statementInput: string, values: unknown[] = []) => {
    const statement = statementInput.replace(/\s+/g, " ").trim().toLowerCase();
    calls.push({ statement, values });
    if (
      statement === "begin" || statement === "commit" || statement === "rollback" ||
      statement.includes("pg_advisory_lock") || statement.includes("pg_advisory_unlock")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (statement.includes("select id, email from \"user\"") && statement.includes("role = 'admin'")) {
      const administrator = input.administrator === undefined
        ? { id: "admin-1", email: "admin@example.test" }
        : input.administrator;
      return { rows: administrator ? [administrator] : [], rowCount: administrator ? 1 : 0 };
    }
    if (
      statement.startsWith("select u.id as user_id") && statement.includes("join learner_profile") &&
      !statement.includes("where u.id = $1")
    ) {
      return {
        rows: input.candidates.map((row) => ({ user_id: row.user_id })),
        rowCount: input.candidates.length,
      };
    }
    if (
      statement.includes("from \"user\" u") && statement.includes("join learner_profile") &&
      statement.includes("where u.id = $1")
    ) {
      const selected = input.candidates.find((row) => row.user_id === values[0]);
      return { rows: selected ? [selected] : [], rowCount: selected ? 1 : 0 };
    }
    if (statement.includes("from \"user\" u") && statement.includes("join learner_profile")) {
      return { rows: input.candidates, rowCount: input.candidates.length };
    }
    if (statement.startsWith("insert into inactivity_episode")) {
      const userId = String(values[0]);
      if (input.episodeInsertConflicts?.includes(userId)) return { rows: [], rowCount: 0 };
      return { rows: [{ id: `episode-${userId}` }], rowCount: 1 };
    }
    if (statement.startsWith("select id, eligible_at, second_eligible_at from inactivity_episode")) {
      const original = input.candidates.find((row) => row.user_id === values[0])!;
      return {
        rows: [{
          id: `existing-${String(values[0])}`,
          eligible_at: original.eligible_at ?? new Date(original.last_activity_at.getTime() + FIRST_REMINDER_AFTER_MS),
          second_eligible_at: original.second_eligible_at ?? new Date(original.last_activity_at.getTime() + SECOND_REMINDER_AFTER_MS),
        }],
        rowCount: 1,
      };
    }
    if (statement.startsWith("insert into email_outbox")) {
      const template = String(values[2]);
      if (input.emailInsertConflicts?.includes(template)) return { rows: [], rowCount: 0 };
      return { rows: [{ id: `outbox-${template}` }], rowCount: 1 };
    }
    if (statement.startsWith("select 1 from email_outbox")) {
      return input.durableEmailConflict === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ "?column?": 1 }], rowCount: 1 };
    }
    if (statement.startsWith("update inactivity_episode")) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected scheduler query: ${statement}`);
  });
  const client = { query, release: () => { released = true; } };
  return {
    pool: { connect: vi.fn(async () => client) },
    query,
    calls,
    released: () => released,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("inactivity policy boundaries", () => {
  it("defines exact 24-hour and 72-hour thresholds", () => {
    expect(FIRST_REMINDER_AFTER_MS).toBe(86_400_000);
    expect(SECOND_REMINDER_AFTER_MS).toBe(259_200_000);
  });

  it("uses learner-local IANA time, including non-whole-hour offsets", () => {
    const instant = new Date("2026-07-12T16:45:00.000Z");
    expect(localMinuteOfDay(instant, "Asia/Kolkata")).toBe(22 * 60 + 15);
    expect(isWithinQuietHours({
      at: instant,
      timeZone: "Asia/Kolkata",
      enabled: true,
      startMinute: 22 * 60,
      endMinute: 8 * 60,
    })).toBe(true);
  });

  it("handles daylight-saving time through the IANA database", () => {
    expect(localMinuteOfDay(new Date("2026-01-15T12:00:00.000Z"), "America/New_York")).toBe(7 * 60);
    expect(localMinuteOfDay(new Date("2026-07-15T12:00:00.000Z"), "America/New_York")).toBe(8 * 60);
  });

  it("treats start as inclusive and end as exclusive across midnight", () => {
    const at = (iso: string) => isWithinQuietHours({
      at: new Date(iso), timeZone: "UTC", enabled: true,
      startMinute: 22 * 60, endMinute: 8 * 60,
    });
    expect(at("2026-07-12T21:59:00.000Z")).toBe(false);
    expect(at("2026-07-12T22:00:00.000Z")).toBe(true);
    expect(at("2026-07-13T07:59:00.000Z")).toBe(true);
    expect(at("2026-07-13T08:00:00.000Z")).toBe(false);
  });

  it("supports daytime, disabled, and deliberate all-day quiet windows", () => {
    const at = new Date("2026-07-12T12:00:00.000Z");
    expect(isWithinQuietHours({ at, timeZone: "UTC", enabled: true, startMinute: 9 * 60, endMinute: 17 * 60 })).toBe(true);
    expect(isWithinQuietHours({ at, timeZone: "UTC", enabled: false, startMinute: 0, endMinute: 0 })).toBe(false);
    expect(isWithinQuietHours({ at, timeZone: "UTC", enabled: true, startMinute: 0, endMinute: 0 })).toBe(true);
  });

  it("falls back to UTC for an invalid stored zone and rejects malformed inputs", () => {
    expect(resolveIanaTimeZone("Not/A_Zone")).toBe("UTC");
    expect(localMinuteOfDay(new Date("2026-07-12T12:34:00.000Z"), "Not/A_Zone")).toBe(12 * 60 + 34);
    expect(() => isWithinQuietHours({
      at: new Date(), timeZone: "UTC", enabled: true, startMinute: -1, endMinute: 10,
    })).toThrow("Quiet-hour boundaries");
    expect(() => localMinuteOfDay(new Date("invalid"), "UTC")).toThrow("valid date");
  });
});

describe("inactivity scheduler transaction branches", () => {
  it("uses a session scheduler lock but commits each learner decision separately", async () => {
    const fake = fakeScheduler({
      candidates: [
        candidate("future-a", { last_activity_at: new Date(NOW.getTime() - 60_000) }),
        candidate("future-b", { last_activity_at: new Date(NOW.getTime() - 120_000) }),
      ],
    });

    await scheduleInactivityReminders(NOW, fake.pool as never);

    expect(fake.calls.filter((call) => call.statement.includes("pg_advisory_lock"))).toHaveLength(1);
    expect(fake.calls.filter((call) => call.statement.includes("pg_advisory_unlock"))).toHaveLength(1);
    expect(fake.calls.filter((call) => call.statement === "begin")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.statement === "commit")).toHaveLength(2);
    const lockedReads = fake.calls.filter((call) =>
      call.statement.includes("where u.id = $1") && call.statement.includes("for update of u"),
    );
    expect(lockedReads.map((call) => call.values[0])).toEqual(["future-a", "future-b"]);
  });

  it("opens an exact-boundary episode and atomically queues separate learner/admin messages", async () => {
    const fake = fakeScheduler({ candidates: [candidate("first")] });
    await expect(scheduleInactivityReminders(NOW, fake.pool as never)).resolves.toEqual({
      opened: 1,
      closed: 0,
      learnerFirst: 1,
      adminNotices: 1,
      learnerSecond: 0,
      consentSkipped: 0,
      paused: 0,
      quietHours: 0,
      adminUnavailable: 0,
    });
    const emailCalls = fake.calls.filter((call) => call.statement.startsWith("insert into email_outbox"));
    expect(emailCalls.map((call) => call.values[2])).toEqual(["inactivity-reminder", "inactivity-admin-notice"]);
    expect(JSON.parse(String(emailCalls[1]?.values[3]))).toEqual({ name: "administrator", url: "http://localhost:3000/admin" });
    expect(fake.calls.at(-1)?.statement).toContain("pg_advisory_unlock");
    expect(fake.calls.filter((call) => call.statement === "begin")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.statement === "commit")).toHaveLength(1);
    expect(fake.released()).toBe(true);
  });

  it("queues only the final reminder at the 72-hour boundary and then has no further work", async () => {
    const baseline = new Date(NOW.getTime() - SECOND_REMINDER_AFTER_MS);
    const firstQueuedAt = new Date(NOW.getTime() - 48 * 60 * 60_000);
    const due = candidate("second", {
      last_activity_at: baseline,
      episode_id: "episode-second",
      episode_last_activity_at: baseline,
      eligible_at: new Date(baseline.getTime() + FIRST_REMINDER_AFTER_MS),
      second_eligible_at: NOW,
      learner_first_queued_at: firstQueuedAt,
      admin_notice_queued_at: firstQueuedAt,
    });
    const fake = fakeScheduler({ candidates: [due] });
    await expect(scheduleInactivityReminders(NOW, fake.pool as never)).resolves.toMatchObject({
      opened: 0, learnerFirst: 0, adminNotices: 0, learnerSecond: 1,
    });
    expect(fake.calls.filter((call) => call.statement.startsWith("insert into email_outbox"))[0]?.values[2])
      .toBe("inactivity-reminder-followup");

    const complete = fakeScheduler({
      candidates: [{ ...due, learner_second_queued_at: NOW }],
    });
    await expect(scheduleInactivityReminders(new Date(NOW.getTime() + 30 * 24 * 60 * 60_000), complete.pool as never))
      .resolves.toMatchObject({ learnerFirst: 0, adminNotices: 0, learnerSecond: 0 });
  });

  it("skips future/current-consent failures and defers paused, pre-eligible, and quiet learners", async () => {
    const baseline = new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS);
    const fake = fakeScheduler({
      candidates: [
        candidate("future", { last_activity_at: new Date(NOW.getTime() - 60_000) }),
        candidate("no-consent", { consent_decision: null, consent_policy_version: null }),
        candidate("paused", { inactivity_paused_until: new Date(NOW.getTime() + 60_000) }),
        candidate("quiet", { quiet_hours_enabled: true, quiet_start_minute: 0, quiet_end_minute: 0 }),
        candidate("not-yet", {
          episode_id: "episode-not-yet",
          episode_last_activity_at: baseline,
          eligible_at: new Date(NOW.getTime() + 1),
          second_eligible_at: new Date(NOW.getTime() + SECOND_REMINDER_AFTER_MS),
        }),
      ],
    });
    await expect(scheduleInactivityReminders(NOW, fake.pool as never)).resolves.toMatchObject({
      opened: 2,
      consentSkipped: 1,
      paused: 1,
      quietHours: 1,
      learnerFirst: 0,
    });
  });

  it("recovers an episode/outbox race without duplicates and records a missing administrator", async () => {
    const fake = fakeScheduler({
      candidates: [candidate("raced")],
      administrator: null,
      episodeInsertConflicts: ["raced"],
      emailInsertConflicts: ["inactivity-reminder"],
      durableEmailConflict: true,
    });
    await expect(scheduleInactivityReminders(NOW, fake.pool as never)).resolves.toMatchObject({
      opened: 0,
      learnerFirst: 1,
      adminNotices: 0,
      adminUnavailable: 1,
    });
    expect(fake.calls.some((call) => call.statement.startsWith("select id, eligible_at"))).toBe(true);
    expect(fake.calls.some((call) => call.statement.startsWith("select 1 from email_outbox"))).toBe(true);
  });

  it("does not mark delivery when a conflicting outbox key is not durable", async () => {
    const fake = fakeScheduler({
      candidates: [candidate("not-durable")],
      emailInsertConflicts: ["inactivity-reminder"],
      durableEmailConflict: false,
    });
    await expect(scheduleInactivityReminders(NOW, fake.pool as never)).resolves.toMatchObject({
      opened: 1, learnerFirst: 0, adminNotices: 0,
    });
  });

  it("rolls back and releases its client on unsafe URL configuration", async () => {
    vi.stubEnv("APP_URL", "https://user:password@learn.example.test");
    const fake = fakeScheduler({ candidates: [candidate("unsafe-url")] });
    await expect(scheduleInactivityReminders(NOW, fake.pool as never)).rejects.toThrow("APP_URL");
    expect(fake.calls.some((call) => call.statement === "rollback")).toBe(true);
    expect(fake.released()).toBe(true);
  });

  it("rejects an invalid scheduler clock before acquiring a connection", async () => {
    const fake = fakeScheduler({ candidates: [] });
    await expect(scheduleInactivityReminders(new Date(Number.NaN), fake.pool as never)).rejects.toThrow("valid date");
    expect(fake.pool.connect).not.toHaveBeenCalled();
  });
});
