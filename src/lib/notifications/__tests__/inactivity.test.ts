import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INACTIVITY_POLICY_VERSION,
  FIRST_REMINDER_AFTER_MS,
  isWithinQuietHours,
  localMinuteOfDay,
  resolveIanaTimeZone,
  scheduleInactivityReminders,
  SECOND_REMINDER_AFTER_MS,
} from "../inactivity";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const TEST_EPISODE_ID = "40000000-0000-4000-8000-000000000004";

type OutboxReleaseRow = {
  id: string;
  operation_id: string;
  idempotency_authority_sha256: string;
  idempotency_original_payload_sha256: string;
  delivery_hold_version: string;
};

const OUTBOX_RELEASE_ROWS: Record<string, OutboxReleaseRow> = {
  "inactivity-reminder": {
    id: "50000000-0000-4000-8000-000000000001",
    operation_id: "51000000-0000-4000-8000-000000000001",
    idempotency_authority_sha256: "a".repeat(64),
    idempotency_original_payload_sha256: "b".repeat(64),
    delivery_hold_version: "task7-v1",
  },
  "inactivity-admin-notice": {
    id: "50000000-0000-4000-8000-000000000002",
    operation_id: "51000000-0000-4000-8000-000000000002",
    idempotency_authority_sha256: "c".repeat(64),
    idempotency_original_payload_sha256: "d".repeat(64),
    delivery_hold_version: "task7-v1",
  },
  "inactivity-reminder-followup": {
    id: "50000000-0000-4000-8000-000000000003",
    operation_id: "51000000-0000-4000-8000-000000000003",
    idempotency_authority_sha256: "e".repeat(64),
    idempotency_original_payload_sha256: "f".repeat(64),
    delivery_hold_version: "task7-v1",
  },
};

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
  emailInsertErrors?: Partial<Record<string, Error>>;
  emailReleaseErrors?: Partial<Record<string, Error>>;
  emailReleaseRows?: Partial<Record<string, Array<{
    outbox_id: string;
    operation_id: string;
  }>>>;
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
      return { rows: [{ id: TEST_EPISODE_ID }], rowCount: 1 };
    }
    if (statement.startsWith("select id, eligible_at, second_eligible_at from inactivity_episode")) {
      const original = input.candidates.find((row) => row.user_id === values[0])!;
      return {
        rows: [{
          id: TEST_EPISODE_ID,
          eligible_at: original.eligible_at ?? new Date(original.last_activity_at.getTime() + FIRST_REMINDER_AFTER_MS),
          second_eligible_at: original.second_eligible_at ?? new Date(original.last_activity_at.getTime() + SECOND_REMINDER_AFTER_MS),
        }],
        rowCount: 1,
      };
    }
    if (statement.startsWith("insert into email_outbox")) {
      const template = String(values[2]);
      const error = input.emailInsertErrors?.[template];
      if (error) throw error;
      if (input.emailInsertConflicts?.includes(template)) return { rows: [], rowCount: 0 };
      const outbox = OUTBOX_RELEASE_ROWS[template];
      if (!outbox) throw new Error(`Missing outbox release fixture for ${template}`);
      return { rows: [outbox], rowCount: 1 };
    }
    if (statement.includes("from public.release_email_outbox_delivery(")) {
      const releaseEntry = Object.entries(OUTBOX_RELEASE_ROWS)
        .find(([, outbox]) => outbox.id === values[0]);
      if (!releaseEntry) throw new Error(`Missing outbox release fixture for ${String(values[0])}`);
      const error = input.emailReleaseErrors?.[releaseEntry[0]];
      if (error) throw error;
      const outbox = releaseEntry[1];
      const rows = input.emailReleaseRows?.[releaseEntry[0]] ?? [{
        outbox_id: outbox.id,
        operation_id: outbox.operation_id,
      }];
      return { rows, rowCount: rows.length };
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
    expect(emailCalls.map((call) => call.statement.slice(call.statement.indexOf("returning")))).toEqual([
      "returning id, operation_id, idempotency_authority_sha256, idempotency_original_payload_sha256, delivery_hold_version",
      "returning id, operation_id, idempotency_authority_sha256, idempotency_original_payload_sha256, delivery_hold_version",
    ]);
    expect(emailCalls.map((call) => JSON.parse(String(call.values[3])))).toEqual([
      {
        inactivityEpisodeId: TEST_EPISODE_ID,
        inactivityPolicyVersion: INACTIVITY_POLICY_VERSION,
        name: "Learner first",
        url: "http://localhost:3000/learn",
      },
      {
        inactivityEpisodeId: TEST_EPISODE_ID,
        inactivityPolicyVersion: INACTIVITY_POLICY_VERSION,
        name: "administrator",
        url: "http://localhost:3000/admin",
      },
    ]);
    const releaseCalls = fake.calls.filter(
      (call) => call.statement.includes("from public.release_email_outbox_delivery("),
    );
    expect(releaseCalls).toEqual([
      {
        statement: "select released.outbox_id::text as outbox_id, released.operation_id::text as operation_id from public.release_email_outbox_delivery( $1::uuid, $2::uuid, $3::text, $4::text, $5::text ) as released",
        values: [
          OUTBOX_RELEASE_ROWS["inactivity-reminder"].id,
          OUTBOX_RELEASE_ROWS["inactivity-reminder"].operation_id,
          OUTBOX_RELEASE_ROWS["inactivity-reminder"].idempotency_authority_sha256,
          OUTBOX_RELEASE_ROWS["inactivity-reminder"].idempotency_original_payload_sha256,
          OUTBOX_RELEASE_ROWS["inactivity-reminder"].delivery_hold_version,
        ],
      },
      {
        statement: "select released.outbox_id::text as outbox_id, released.operation_id::text as operation_id from public.release_email_outbox_delivery( $1::uuid, $2::uuid, $3::text, $4::text, $5::text ) as released",
        values: [
          OUTBOX_RELEASE_ROWS["inactivity-admin-notice"].id,
          OUTBOX_RELEASE_ROWS["inactivity-admin-notice"].operation_id,
          OUTBOX_RELEASE_ROWS["inactivity-admin-notice"].idempotency_authority_sha256,
          OUTBOX_RELEASE_ROWS["inactivity-admin-notice"].idempotency_original_payload_sha256,
          OUTBOX_RELEASE_ROWS["inactivity-admin-notice"].delivery_hold_version,
        ],
      },
    ]);
    for (const [template, marker] of [
      ["inactivity-reminder", "set learner_first_queued_at"],
      ["inactivity-admin-notice", "set admin_notice_queued_at"],
    ] as const) {
      const outbox = OUTBOX_RELEASE_ROWS[template];
      const insertIndex = fake.calls.findIndex(
        (call) => call.statement.startsWith("insert into email_outbox") && call.values[2] === template,
      );
      const releaseIndex = fake.calls.findIndex(
        (call) => call.statement.includes("from public.release_email_outbox_delivery(") &&
          call.values[0] === outbox.id,
      );
      const markerIndex = fake.calls.findIndex((call) => call.statement.includes(marker));
      const commitIndex = fake.calls.findIndex((call) => call.statement === "commit");
      expect(insertIndex).toBeLessThan(releaseIndex);
      expect(releaseIndex).toBeLessThan(markerIndex);
      expect(markerIndex).toBeLessThan(commitIndex);
    }
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
      episode_id: TEST_EPISODE_ID,
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
          episode_id: TEST_EPISODE_ID,
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
    });
    await expect(scheduleInactivityReminders(NOW, fake.pool as never)).resolves.toMatchObject({
      opened: 0,
      learnerFirst: 1,
      adminNotices: 0,
      adminUnavailable: 1,
    });
    expect(fake.calls.some((call) => call.statement.startsWith("select id, eligible_at"))).toBe(true);
    expect(fake.calls.some(
      (call) => call.statement.includes("from public.release_email_outbox_delivery("),
    )).toBe(false);
  });

  it("repairs the episode marker when durable authority suppresses replay after outbox retention", async () => {
    const baseline = new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS);
    const fake = fakeScheduler({
      administrator: null,
      candidates: [candidate("retained-authority", {
        episode_id: TEST_EPISODE_ID,
        episode_last_activity_at: baseline,
        eligible_at: NOW,
        second_eligible_at: new Date(baseline.getTime() + SECOND_REMINDER_AFTER_MS),
      })],
      emailInsertConflicts: ["inactivity-reminder"],
    });
    await expect(
      scheduleInactivityReminders(NOW, fake.pool as never),
    ).resolves.toMatchObject({
      opened: 0,
      learnerFirst: 1,
      adminUnavailable: 1,
    });
    expect(fake.calls.some(
      (call) => call.statement.startsWith("select 1 from email_outbox"),
    )).toBe(false);
    expect(fake.calls.some(
      (call) => call.statement.includes("set learner_first_queued_at"),
    )).toBe(true);
    expect(fake.calls.some(
      (call) => call.statement.includes("from public.release_email_outbox_delivery("),
    )).toBe(false);
  });

  it.each([
    ["zero rows", []],
    [
      "multiple rows",
      [
        {
          outbox_id: OUTBOX_RELEASE_ROWS["inactivity-reminder"].id,
          operation_id: OUTBOX_RELEASE_ROWS["inactivity-reminder"].operation_id,
        },
        {
          outbox_id: OUTBOX_RELEASE_ROWS["inactivity-reminder"].id,
          operation_id: OUTBOX_RELEASE_ROWS["inactivity-reminder"].operation_id,
        },
      ],
    ],
    [
      "a different outbox",
      [{
        outbox_id: "52000000-0000-4000-8000-000000000001",
        operation_id: OUTBOX_RELEASE_ROWS["inactivity-reminder"].operation_id,
      }],
    ],
    [
      "a different operation",
      [{
        outbox_id: OUTBOX_RELEASE_ROWS["inactivity-reminder"].id,
        operation_id: "53000000-0000-4000-8000-000000000001",
      }],
    ],
  ] as const)(
    "rolls back before marker update or commit when release returns %s",
    async (_label, releaseRows) => {
      const fake = fakeScheduler({
        administrator: null,
        candidates: [candidate("invalid-release-result")],
        emailReleaseRows: {
          "inactivity-reminder": [...releaseRows],
        },
      });

      await expect(
        scheduleInactivityReminders(NOW, fake.pool as never),
      ).rejects.toMatchObject({
        name: "EmailOutboxReleaseReceiptError",
        code: "EMAIL_OUTBOX_RELEASE_RECEIPT_INVALID",
      });

      const releaseIndex = fake.calls.findIndex(
        (call) => call.statement.includes(
          "from public.release_email_outbox_delivery(",
        ),
      );
      const rollbackIndex = fake.calls.findIndex(
        (call) => call.statement === "rollback",
      );
      expect(releaseIndex).toBeGreaterThanOrEqual(0);
      expect(rollbackIndex).toBeGreaterThan(releaseIndex);
      expect(fake.calls.some(
        (call) => call.statement.includes("set learner_first_queued_at"),
      )).toBe(false);
      expect(fake.calls.some((call) => call.statement === "commit")).toBe(false);
      expect(fake.released()).toBe(true);
    },
  );

  it("rolls back and propagates a delivery-release failure before marker update or commit", async () => {
    const releaseFailure = Object.assign(
      new Error("mail delivery release identity is invalid"),
      { code: "23514" },
    );
    const fake = fakeScheduler({
      administrator: null,
      candidates: [candidate("release-failure")],
      emailReleaseErrors: { "inactivity-reminder": releaseFailure },
    });

    await expect(
      scheduleInactivityReminders(NOW, fake.pool as never),
    ).rejects.toBe(releaseFailure);

    const insertIndex = fake.calls.findIndex(
      (call) => call.statement.startsWith("insert into email_outbox"),
    );
    const releaseIndex = fake.calls.findIndex(
      (call) => call.statement.includes("from public.release_email_outbox_delivery("),
    );
    const rollbackIndex = fake.calls.findIndex((call) => call.statement === "rollback");
    expect(insertIndex).toBeLessThan(releaseIndex);
    expect(releaseIndex).toBeLessThan(rollbackIndex);
    expect(fake.calls.some(
      (call) => call.statement.includes("set learner_first_queued_at"),
    )).toBe(false);
    expect(fake.calls.some((call) => call.statement === "commit")).toBe(false);
    expect(fake.released()).toBe(true);
  });

  it("rolls back when durable authority rejects a payload conflict", async () => {
    const conflict = Object.assign(
      new Error("email outbox idempotency event payload conflict"),
      {
        code: "23505",
        constraint: "email_outbox_idempotency_authority_pkey",
      },
    );
    const fake = fakeScheduler({
      candidates: [candidate("payload-conflict")],
      emailInsertErrors: { "inactivity-reminder": conflict },
    });
    await expect(
      scheduleInactivityReminders(NOW, fake.pool as never),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "email_outbox_idempotency_authority_pkey",
    });
    expect(fake.calls.some((call) => call.statement === "rollback")).toBe(true);
    expect(fake.calls.some(
      (call) => call.statement.includes("set learner_first_queued_at"),
    )).toBe(false);
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
