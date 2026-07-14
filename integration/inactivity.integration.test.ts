import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "@/lib/db/client";
import { DrizzleLearningStore } from "@/lib/learning-service/drizzle-store";
import {
  FIRST_REMINDER_AFTER_MS,
  scheduleInactivityReminders,
  SECOND_REMINDER_AFTER_MS,
} from "@/lib/notifications/inactivity";
import { setInactivityPause } from "@/lib/notifications/preferences";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";

const ADMIN = "inactivity-admin";
const LEARNER = "inactivity-learner";
const LEARNER_PUBLIC = "b1000000-0000-4000-8000-000000000001";
const ADMIN_EMAIL = "admin-inactivity@integration.invalid";
const LEARNER_EMAIL = "learner-inactivity@integration.invalid";
const BLOCKED_LEARNER = "inactivity-z-blocked-learner";
const BLOCKED_LEARNER_PUBLIC = "b1000000-0000-4000-8000-000000000003";
const BLOCKED_LEARNER_EMAIL = "blocked-learner-inactivity@integration.invalid";
const NOW = new Date("2026-07-12T12:00:00.000Z");

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Inactivity integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const tables = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const names = tables.rows.map((row) => `"${row.table_name.replaceAll('"', '""')}"`).join(",");
  if (names) await pool.query(`truncate table ${names} restart identity cascade`);
}

async function seedLearner(input: {
  lastActivityAt?: Date | null;
  onboardingCompletedAt?: Date;
  timeZone?: string;
  quiet?: boolean;
  consentVersion?: string | null;
  pausedUntil?: Date | null;
} = {}) {
  const onboarding = input.onboardingCompletedAt ?? new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS);
  await pool.query(
    `insert into "user" (id,public_id,name,email,email_verified,role,status,timezone,last_meaningful_activity_at)
     values ($1,$2,'Inactivity Learner',$3,true,'learner','active',$4,$5),
            ($6,$7,'Inactivity Administrator',$8,true,'admin','active','UTC',null)`,
    [
      LEARNER, LEARNER_PUBLIC, LEARNER_EMAIL, input.timeZone ?? "UTC", input.lastActivityAt ?? null,
      ADMIN, "b1000000-0000-4000-8000-000000000002", ADMIN_EMAIL,
    ],
  );
  await pool.query(
    `insert into learner_profile (user_id,onboarding_completed_at) values ($1,$2)`,
    [LEARNER, onboarding],
  );
  if (input.consentVersion !== null) {
    await pool.query(
      `insert into consent_record
        (user_id,purpose,policy_version,decision,data_categories,source,idempotency_key,occurred_at)
       values ($1,'inactivity_mentor_notice',$2,'accepted','[]'::jsonb,'onboarding',$3,$4)`,
      [LEARNER, input.consentVersion ?? ENROLLMENT_DISCLOSURE_VERSION, `inactivity-consent:${input.consentVersion ?? "current"}`, onboarding],
    );
  }
  await pool.query(
    `insert into notification_preference
      (user_id,quiet_hours_enabled,quiet_start_minute,quiet_end_minute,inactivity_paused_until,inactivity_pause_reason,inactivity_paused_by)
     values ($1,$2,1320,480,$3,$4,$5)`,
    [
      LEARNER,
      input.quiet ?? false,
      input.pausedUntil ?? null,
      input.pausedUntil ? "Administrator-approved temporary reminder pause." : null,
      input.pausedUntil ? ADMIN : null,
    ],
  );
}

async function seedAdditionalLearner(input: {
  userId: string;
  publicId: string;
  email: string;
  lastActivityAt: Date;
}) {
  await pool.query(
    `insert into "user" (id,public_id,name,email,email_verified,role,status,timezone,last_meaningful_activity_at)
     values ($1,$2,'Blocked Inactivity Learner',$3,true,'learner','active','UTC',$4)`,
    [input.userId, input.publicId, input.email, input.lastActivityAt],
  );
  await pool.query(
    `insert into learner_profile (user_id,onboarding_completed_at) values ($1,$2)`,
    [input.userId, input.lastActivityAt],
  );
  await pool.query(
    `insert into consent_record
      (user_id,purpose,policy_version,decision,data_categories,source,idempotency_key,occurred_at)
     values ($1,'inactivity_mentor_notice',$2,'accepted','[]'::jsonb,'onboarding',$3,$4)`,
    [
      input.userId,
      ENROLLMENT_DISCLOSURE_VERSION,
      `inactivity-consent:${input.userId}`,
      input.lastActivityAt,
    ],
  );
  await pool.query(
    `insert into notification_preference
      (user_id,quiet_hours_enabled,quiet_start_minute,quiet_end_minute)
     values ($1,false,1320,480)`,
    [input.userId],
  );
}

async function waitForCommittedOutbox(userId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await pool.query(
      `select 1 from email_outbox
        where user_id = $1 and template = 'inactivity-reminder'`,
      [userId],
    );
    if (visible.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for a committed reminder for ${userId}.`);
}

beforeEach(truncateApplicationTables);
afterAll(() => pool.end());

describe("real PostgreSQL inactivity episodes", () => {
  it("enforces exact 24h/72h boundaries, one admin notice, and no duplicates under concurrent workers", async () => {
    const lastActivityAt = new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS);
    await seedLearner({ lastActivityAt });

    expect(await scheduleInactivityReminders(new Date(NOW.getTime() - 1))).toMatchObject({
      opened: 0, learnerFirst: 0, adminNotices: 0, learnerSecond: 0,
    });
    const first = await scheduleInactivityReminders(NOW);
    expect(first).toMatchObject({ opened: 1, learnerFirst: 1, adminNotices: 1, learnerSecond: 0 });

    const duplicateWorkers = await Promise.all([
      scheduleInactivityReminders(NOW),
      scheduleInactivityReminders(NOW),
      scheduleInactivityReminders(NOW),
    ]);
    expect(duplicateWorkers.every((result) =>
      result.learnerFirst === 0 && result.adminNotices === 0 && result.learnerSecond === 0,
    )).toBe(true);

    const beforeSecond = new Date(lastActivityAt.getTime() + SECOND_REMINDER_AFTER_MS - 1);
    expect(await scheduleInactivityReminders(beforeSecond)).toMatchObject({ learnerSecond: 0 });
    const secondAt = new Date(lastActivityAt.getTime() + SECOND_REMINDER_AFTER_MS);
    expect(await scheduleInactivityReminders(secondAt)).toMatchObject({ learnerSecond: 1 });
    expect(await scheduleInactivityReminders(new Date(secondAt.getTime() + 30 * 24 * 60 * 60_000))).toMatchObject({
      learnerFirst: 0, adminNotices: 0, learnerSecond: 0,
    });

    const outbox = await pool.query<{
      to_email: string;
      template: string;
      variables: Record<string, string>;
      idempotency_key: string;
    }>("select to_email,template,variables,idempotency_key from email_outbox order by template");
    expect(outbox.rows).toHaveLength(3);
    expect(new Set(outbox.rows.map((row) => row.idempotency_key)).size).toBe(3);
    expect(outbox.rows.map((row) => row.template).sort()).toEqual([
      "inactivity-admin-notice",
      "inactivity-reminder",
      "inactivity-reminder-followup",
    ]);
    const adminNotice = outbox.rows.find((row) => row.template === "inactivity-admin-notice")!;
    expect(adminNotice.to_email).toBe(ADMIN_EMAIL);
    expect(adminNotice.variables).toEqual({ name: "administrator", url: "http://localhost:3000/admin" });
    for (const row of outbox.rows) {
      const serialized = JSON.stringify(row.variables).toLowerCase();
      for (const forbidden of [
        "score", "mistake", "code", "chat", "provider", "nvapi", "raw hours", LEARNER_EMAIL,
      ]) expect(serialized).not.toContain(forbidden.toLowerCase());
    }
  });

  it("closes on committed authoritative learning, then permits exactly one later episode", async () => {
    const firstBaseline = new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS);
    await seedLearner({ lastActivityAt: firstBaseline });
    await scheduleInactivityReminders(NOW);

    const reactivatedAt = new Date(NOW.getTime() + 60 * 60_000);
    const store = new DrizzleLearningStore();
    await store.transaction(async (transaction) => {
      // Domain services call this boundary only after validating independent,
      // authoritative evidence. This test isolates its atomic episode close;
      // lesson-evidence authorization is covered by the learner journey.
      await transaction.touchMeaningfulActivity(LEARNER, reactivatedAt);
    });
    const immediateClose = await pool.query<{ closed_at: Date | null }>(
      "select closed_at from inactivity_episode where user_id = $1 and opened_at = $2",
      [LEARNER, NOW],
    );
    expect(immediateClose.rows[0]?.closed_at?.toISOString()).toBe(reactivatedAt.toISOString());
    expect(await scheduleInactivityReminders(reactivatedAt)).toMatchObject({ closed: 0, opened: 0 });
    expect(await scheduleInactivityReminders(new Date(reactivatedAt.getTime() + FIRST_REMINDER_AFTER_MS - 1))).toMatchObject({ opened: 0 });
    expect(await scheduleInactivityReminders(new Date(reactivatedAt.getTime() + FIRST_REMINDER_AFTER_MS))).toMatchObject({
      opened: 1, learnerFirst: 1, adminNotices: 1,
    });
    const episodes = await pool.query<{ closed_at: Date | null }>(
      "select closed_at from inactivity_episode where user_id = $1 order by opened_at",
      [LEARNER],
    );
    expect(episodes.rows).toHaveLength(2);
    expect(episodes.rows[0]?.closed_at).not.toBeNull();
    expect(episodes.rows[1]?.closed_at).toBeNull();
  });

  it("requires current consent and honors an administrator pause", async () => {
    await seedLearner({
      lastActivityAt: new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS),
      consentVersion: "stale-disclosure.v1",
    });
    expect(await scheduleInactivityReminders(NOW)).toMatchObject({ consentSkipped: 1, opened: 0 });
    expect((await pool.query("select 1 from email_outbox")).rowCount).toBe(0);

    await pool.query(
      `insert into consent_record
        (user_id,purpose,policy_version,decision,data_categories,source,idempotency_key,occurred_at)
       values ($1,'inactivity_mentor_notice',$2,'accepted','[]'::jsonb,'settings','inactivity-consent:current',$3)`,
      [LEARNER, ENROLLMENT_DISCLOSURE_VERSION, new Date(NOW.getTime() + 1)],
    );
    const pauseUntil = new Date(NOW.getTime() + 2 * 60 * 60_000);
    expect(await setInactivityPause({
      actorUserId: ADMIN,
      learnerPublicId: LEARNER_PUBLIC,
      expectedVersion: 1,
      pausedUntil: pauseUntil,
      reason: "Administrator-approved examination pause.",
      now: new Date(NOW.getTime() + 1),
    })).toMatchObject({ rowVersion: 2, inactivityPausedUntil: pauseUntil });
    expect(await scheduleInactivityReminders(new Date(NOW.getTime() + 1))).toMatchObject({
      opened: 1, paused: 1, learnerFirst: 0, adminNotices: 0,
    });
    expect((await pool.query("select 1 from email_outbox")).rowCount).toBe(0);
    expect(await scheduleInactivityReminders(pauseUntil)).toMatchObject({ learnerFirst: 1, adminNotices: 1 });

    const competingChanges = await Promise.allSettled([
      setInactivityPause({
        actorUserId: ADMIN,
        learnerPublicId: LEARNER_PUBLIC,
        expectedVersion: 2,
        pausedUntil: null,
        reason: "Resume reminders after the approved pause.",
        now: pauseUntil,
      }),
      setInactivityPause({
        actorUserId: ADMIN,
        learnerPublicId: LEARNER_PUBLIC,
        expectedVersion: 2,
        pausedUntil: new Date(pauseUntil.getTime() + 60 * 60_000),
        reason: "Extend the approved pause for one additional hour.",
        now: pauseUntil,
      }),
    ]);
    expect(competingChanges.filter((change) => change.status === "fulfilled")).toHaveLength(1);
    expect(competingChanges.filter((change) => change.status === "rejected")).toHaveLength(1);
    expect((competingChanges.find((change) => change.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("defers both first messages during the learner's local quiet hours", async () => {
    const quietInstant = new Date("2026-07-12T16:30:00.000Z"); // 22:00 in Asia/Kolkata.
    await seedLearner({
      lastActivityAt: new Date(quietInstant.getTime() - FIRST_REMINDER_AFTER_MS),
      onboardingCompletedAt: new Date(quietInstant.getTime() - FIRST_REMINDER_AFTER_MS),
      timeZone: "Asia/Kolkata",
      quiet: true,
    });
    expect(await scheduleInactivityReminders(quietInstant)).toMatchObject({
      opened: 1, quietHours: 1, learnerFirst: 0, adminNotices: 0,
    });
    expect((await pool.query("select 1 from email_outbox")).rowCount).toBe(0);

    const quietEnd = new Date("2026-07-13T02:30:00.000Z"); // 08:00 in Asia/Kolkata.
    expect(await scheduleInactivityReminders(quietEnd)).toMatchObject({ learnerFirst: 1, adminNotices: 1 });
  });

  it("releases each learner row before continuing to a blocked later learner", async () => {
    const baseline = new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS);
    await seedLearner({ lastActivityAt: baseline });
    await seedAdditionalLearner({
      userId: BLOCKED_LEARNER,
      publicId: BLOCKED_LEARNER_PUBLIC,
      email: BLOCKED_LEARNER_EMAIL,
      lastActivityAt: baseline,
    });

    const blockedLearnerTransaction = await pool.connect();
    const unrelatedWriter = await pool.connect();
    let scheduling: ReturnType<typeof scheduleInactivityReminders> | null = null;
    try {
      await blockedLearnerTransaction.query("begin");
      await blockedLearnerTransaction.query(
        `select id from "user" where id = $1 for update`,
        [BLOCKED_LEARNER],
      );

      scheduling = scheduleInactivityReminders(NOW);
      // Visibility proves the first learner's outbox transaction committed
      // while the same scheduler invocation is still waiting on the second.
      await waitForCommittedOutbox(LEARNER);

      await unrelatedWriter.query("begin");
      await unrelatedWriter.query("set local statement_timeout = '1000ms'");
      await expect(unrelatedWriter.query(
        `update "user" set last_meaningful_activity_at = $2 where id = $1 returning id`,
        [LEARNER, new Date(NOW.getTime() + 60_000)],
      )).resolves.toMatchObject({ rowCount: 1 });
      await unrelatedWriter.query("commit");
    } finally {
      await unrelatedWriter.query("rollback").catch(() => undefined);
      unrelatedWriter.release();
      await blockedLearnerTransaction.query("commit").catch(() => undefined);
      blockedLearnerTransaction.release();
    }

    expect(await scheduling).toMatchObject({
      opened: 2, learnerFirst: 2, adminNotices: 2,
    });
    const learnerReminders = await pool.query<{ user_id: string }>(
      `select user_id from email_outbox
        where template = 'inactivity-reminder'
        order by user_id`,
    );
    expect(learnerReminders.rows.map((row) => row.user_id)).toEqual([LEARNER, BLOCKED_LEARNER]);
  });

  it("observes meaningful activity committed while a scheduler is waiting on the learner row", async () => {
    await seedLearner({ lastActivityAt: new Date(NOW.getTime() - FIRST_REMINDER_AFTER_MS) });
    const activityTransaction = await pool.connect();
    try {
      await activityTransaction.query("begin");
      await activityTransaction.query("select id from \"user\" where id = $1 for update", [LEARNER]);
      await activityTransaction.query(
        `update "user" set last_meaningful_activity_at = $2 where id = $1`,
        [LEARNER, NOW],
      );
      const scheduling = scheduleInactivityReminders(NOW);
      await new Promise((resolve) => setTimeout(resolve, 25));
      await activityTransaction.query("commit");
      expect(await scheduling).toMatchObject({ opened: 0, learnerFirst: 0, adminNotices: 0 });
      expect((await pool.query("select 1 from email_outbox")).rowCount).toBe(0);
      expect((await pool.query(
        "select 1 from inactivity_episode where user_id = $1 and closed_at is null",
        [LEARNER],
      )).rowCount).toBe(0);
    } finally {
      await activityTransaction.query("rollback").catch(() => undefined);
      activityTransaction.release();
    }
  });
});
