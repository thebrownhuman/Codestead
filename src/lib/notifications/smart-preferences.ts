import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";

export type SmartReminderPreferenceValues = {
  dailyStudyEnabled: boolean;
  revisionEnabled: boolean;
  goalEnabled: boolean;
  challengeEnabled: boolean;
  weeklySummaryEnabled: boolean;
  learningEmailEnabled: boolean;
  timezone: string;
  dailyStudyMinute: number;
  revisionMinute: number;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
};

export const DEFAULT_SMART_REMINDER_PREFERENCES: Readonly<SmartReminderPreferenceValues> = Object.freeze({
  // Engagement messages are optional. Absence of a preference row is never
  // interpreted as consent for either in-app nudges or learning email.
  dailyStudyEnabled: false,
  revisionEnabled: false,
  goalEnabled: false,
  challengeEnabled: false,
  weeklySummaryEnabled: false,
  learningEmailEnabled: false,
  timezone: "UTC",
  dailyStudyMinute: 1_080,
  revisionMinute: 1_140,
  quietHoursEnabled: true,
  quietStartMinute: 1_320,
  quietEndMinute: 480,
});

export type SmartReminderPreferences = SmartReminderPreferenceValues & {
  rowVersion: number;
};

export class SmartReminderPreferenceError extends Error {
  constructor(
    readonly code: "INVALID_TIMEZONE" | "INVALID_MINUTE" | "VERSION_CONFLICT" | "USER_NOT_FOUND",
    readonly status: number,
  ) {
    super(code);
    this.name = "SmartReminderPreferenceError";
  }
}

type PreferenceRow = {
  daily_study_enabled: boolean | null;
  revision_enabled: boolean | null;
  goal_enabled: boolean | null;
  challenge_enabled: boolean | null;
  weekly_summary_enabled: boolean | null;
  learning_email_enabled: boolean | null;
  timezone: string | null;
  daily_study_minute: number | null;
  revision_minute: number | null;
  quiet_hours_enabled: boolean | null;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  row_version: string | number | null;
  user_timezone: string | null;
};

function validMinute(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_439) {
    throw new SmartReminderPreferenceError("INVALID_MINUTE", 400);
  }
  return value;
}

export function normalizeIanaTimezone(value: string) {
  const timezone = value.trim();
  if (!timezone || timezone.length > 100) {
    throw new SmartReminderPreferenceError("INVALID_TIMEZONE", 400);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new SmartReminderPreferenceError("INVALID_TIMEZONE", 400);
  }
  return timezone;
}

function rowToView(row: PreferenceRow | undefined): SmartReminderPreferences {
  const defaults = DEFAULT_SMART_REMINDER_PREFERENCES;
  return {
    dailyStudyEnabled: row?.daily_study_enabled ?? defaults.dailyStudyEnabled,
    revisionEnabled: row?.revision_enabled ?? defaults.revisionEnabled,
    goalEnabled: row?.goal_enabled ?? defaults.goalEnabled,
    challengeEnabled: row?.challenge_enabled ?? defaults.challengeEnabled,
    weeklySummaryEnabled: row?.weekly_summary_enabled ?? defaults.weeklySummaryEnabled,
    learningEmailEnabled: row?.learning_email_enabled ?? defaults.learningEmailEnabled,
    timezone: row?.timezone ?? row?.user_timezone ?? defaults.timezone,
    dailyStudyMinute: Number(row?.daily_study_minute ?? defaults.dailyStudyMinute),
    revisionMinute: Number(row?.revision_minute ?? defaults.revisionMinute),
    quietHoursEnabled: row?.quiet_hours_enabled ?? defaults.quietHoursEnabled,
    quietStartMinute: Number(row?.quiet_start_minute ?? defaults.quietStartMinute),
    quietEndMinute: Number(row?.quiet_end_minute ?? defaults.quietEndMinute),
    rowVersion: Number(row?.row_version ?? 0),
  };
}

async function selectPreference(queryable: Pick<PoolClient, "query">, userId: string, lock = false) {
  const result = await queryable.query<PreferenceRow>(
    `select p.daily_study_enabled,p.revision_enabled,p.goal_enabled,p.challenge_enabled,
            p.weekly_summary_enabled,p.learning_email_enabled,p.timezone,p.daily_study_minute,
            p.revision_minute,p.quiet_hours_enabled,p.quiet_start_minute,p.quiet_end_minute,
            p.row_version,u.timezone as user_timezone
       from "user" u left join notification_preference p on p.user_id = u.id
      where u.id = $1 and u.status = 'active'
      ${lock ? "for update of u" : ""}`,
    [userId],
  );
  return result.rows[0];
}

export async function loadSmartReminderPreferences(userId: string) {
  const row = await selectPreference(pool, userId);
  if (!row) throw new SmartReminderPreferenceError("USER_NOT_FOUND", 404);
  return rowToView(row);
}

export async function updateSmartReminderPreferences(input: {
  userId: string;
  expectedVersion: number;
  dailyStudyEnabled: boolean;
  revisionEnabled: boolean;
  goalEnabled: boolean;
  challengeEnabled: boolean;
  weeklySummaryEnabled: boolean;
  learningEmailEnabled: boolean;
  timezone: string;
  dailyStudyMinute: number;
  revisionMinute: number;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  now?: Date;
}): Promise<SmartReminderPreferences> {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new SmartReminderPreferenceError("VERSION_CONFLICT", 409);
  }
  const timezone = normalizeIanaTimezone(input.timezone);
  const dailyStudyMinute = validMinute(input.dailyStudyMinute);
  const revisionMinute = validMinute(input.revisionMinute);
  const quietStartMinute = validMinute(input.quietStartMinute);
  const quietEndMinute = validMinute(input.quietEndMinute);
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = await selectPreference(client, input.userId, true);
    if (!current) throw new SmartReminderPreferenceError("USER_NOT_FOUND", 404);
    const currentVersion = Number(current.row_version ?? 0);
    if (currentVersion !== input.expectedVersion) {
      throw new SmartReminderPreferenceError("VERSION_CONFLICT", 409);
    }
    const values = [
      input.userId,
      input.dailyStudyEnabled,
      input.revisionEnabled,
      input.goalEnabled,
      input.challengeEnabled,
      input.weeklySummaryEnabled,
      input.learningEmailEnabled,
      timezone,
      dailyStudyMinute,
      revisionMinute,
      input.quietHoursEnabled,
      quietStartMinute,
      quietEndMinute,
      currentVersion + 1,
      now,
    ];
    if (currentVersion === 0) {
      await client.query(
        `insert into notification_preference
          (user_id,daily_study_enabled,revision_enabled,goal_enabled,challenge_enabled,
           weekly_summary_enabled,learning_email_enabled,timezone,daily_study_minute,
           revision_minute,quiet_hours_enabled,quiet_start_minute,quiet_end_minute,
           row_version,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
        values,
      );
    } else {
      const updated = await client.query(
        `update notification_preference set
           daily_study_enabled=$2,revision_enabled=$3,goal_enabled=$4,challenge_enabled=$5,
           weekly_summary_enabled=$6,learning_email_enabled=$7,timezone=$8,daily_study_minute=$9,
           revision_minute=$10,quiet_hours_enabled=$11,quiet_start_minute=$12,quiet_end_minute=$13,
           row_version=$14,updated_at=$15
         where user_id=$1 and row_version=$16`,
        [...values, currentVersion],
      );
      if (updated.rowCount !== 1) throw new SmartReminderPreferenceError("VERSION_CONFLICT", 409);
    }
    await client.query("commit");
    return {
      dailyStudyEnabled: input.dailyStudyEnabled,
      revisionEnabled: input.revisionEnabled,
      goalEnabled: input.goalEnabled,
      challengeEnabled: input.challengeEnabled,
      weeklySummaryEnabled: input.weeklySummaryEnabled,
      learningEmailEnabled: input.learningEmailEnabled,
      timezone,
      dailyStudyMinute,
      revisionMinute,
      quietHoursEnabled: input.quietHoursEnabled,
      quietStartMinute,
      quietEndMinute,
      rowVersion: currentVersion + 1,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
