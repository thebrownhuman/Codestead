import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";

import { dueKinds, insideQuietHours, localClock } from "../smart-reminders";
import { scheduleSmartReminders } from "../smart-reminders";

const mocks = vi.hoisted(() => ({
  databaseExecute: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  db: {
    execute: mocks.databaseExecute,
    transaction: mocks.transaction,
  },
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

  it("locks the user and preference in separate deterministic order before revalidation", () => {
    const sourcePath = "../smart-reminders.ts";
    const source = readFileSync(
      new URL(sourcePath, import.meta.url),
      "utf8",
    );
    const dispatch = source.slice(
      source.indexOf("async function dispatch"),
      source.indexOf("export async function scheduleSmartReminders"),
    );
    const normalized = dispatch.replace(/\s+/gu, " ").toLowerCase();
    const userLock = normalized.indexOf(
      'select u.id from "user" u where u.id=${candidate.id} for update of u',
    );
    const preferenceLock = normalized.indexOf(
      "select p.user_id from notification_preference p where p.user_id=${candidate.id} for update of p",
    );
    const revalidation = normalized.indexOf(
      "select u.id,u.name,u.email,u.last_meaningful_activity_at, p.timezone",
    );

    expect(userLock).toBeGreaterThan(-1);
    expect(preferenceLock).toBeGreaterThan(userLock);
    expect(revalidation).toBeGreaterThan(preferenceLock);
    expect(normalized).not.toMatch(/for update of\s+u\s*,\s*p/u);
  });

  it("binds the live race to restricted exact backends and an adversarial waiter", () => {
    const integrationPath = "../../../../integration/community-battles.integration.test.ts";
    const integrationSource = readFileSync(
      new URL(integrationPath, import.meta.url),
      "utf8",
    );
    const schedulerPath = "../smart-reminders.ts";
    const schedulerSource = readFileSync(
      new URL(schedulerPath, import.meta.url),
      "utf8",
    );
    const normalized = integrationSource.replace(/\s+/gu, " ").toLowerCase();

    expect(schedulerSource).toContain("export async function scheduleSmartRemindersWithDatabase");
    expect(integrationSource).toContain("process.env.DATABASE_APP_URL");
    expect(integrationSource).not.toContain("process.env.DATABASE_MIGRATOR_URL");
    expect(integrationSource).toContain("(client as PoolClientWithProcessId).processID");
    expect(integrationSource).toContain('current_database()::text "databaseName"');
    expect(integrationSource).toContain('session_user::text "sessionUser"');
    expect(integrationSource).toContain('current_user::text "currentUser"');
    expect(integrationSource).toContain("drizzle(schedulerClient");
    expect(integrationSource).toContain("competingWaiter");
    expect(integrationSource).toContain("expect(schedulerPid).not.toBe(competingIdentity.pid)");
    expect(normalized).toContain("activity.pid=$1");
    expect(normalized).toContain("activity.datname=$2");
    expect(normalized).toContain("activity.usename=$3");
    expect(normalized).toContain("activity.application_name=$4");
    expect(normalized).toContain("activity.query ilike $5");
    expect(normalized).toContain("activity.query ilike $6");
    expect(normalized).toContain("activity.query ilike $7");
    expect(normalized).toContain("$8::integer = any(pg_blocking_pids(activity.pid))");
    expect(normalized).not.toContain("where waiting.pid <> pg_backend_pid() and not waiting.granted");
  });

  it.each([
    "../smart-reminders.ts",
    "../smart-preferences.ts",
    "../inactivity.ts",
    "../preferences.ts",
    "../../auth.ts",
    "../../security/lost-device-recovery.ts",
    "../../../app/api/session-revocation-requests/route.ts",
    "../../../app/api/admin/session-revocation-requests/[id]/decision/route.ts",
  ])("avoids multi-alias update locks in revocable path %s", (relativePath) => {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    expect(source).not.toMatch(
      /for\s+update\s+of\s+[a-z_][a-z0-9_]*\s*,/iu,
    );
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
    mocks.databaseExecute.mockResolvedValueOnce({
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
