import { pool } from "@/lib/db/client";

const MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1_000;

export class NotificationPreferenceError extends Error {
  constructor(
    readonly code: "ADMIN_REQUIRED" | "LEARNER_NOT_FOUND" | "VERSION_CONFLICT" | "INVALID_REASON" | "INVALID_PAUSE_UNTIL",
    readonly status: number,
  ) {
    super(code);
    this.name = "NotificationPreferenceError";
  }
}

export type InactivityPreferenceView = {
  learnerId: string;
  quietHoursEnabled: boolean;
  quietStartMinute: number;
  quietEndMinute: number;
  inactivityPausedUntil: Date | null;
  rowVersion: number;
};

function validNow(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new NotificationPreferenceError("INVALID_PAUSE_UNTIL", 400);
}

function reasonValue(reason: string) {
  const value = reason.trim();
  if (value.length < 8 || value.length > 500) {
    throw new NotificationPreferenceError("INVALID_REASON", 400);
  }
  return value;
}

export async function getInactivityPreference(
  learnerPublicId: string,
  now = new Date(),
): Promise<InactivityPreferenceView | null> {
  validNow(now);
  const result = await pool.query<{
    public_id: string;
    quiet_hours_enabled: boolean | null;
    quiet_start_minute: number | null;
    quiet_end_minute: number | null;
    inactivity_paused_until: Date | null;
    row_version: string | number | null;
  }>(
    `select u.public_id, p.quiet_hours_enabled, p.quiet_start_minute, p.quiet_end_minute,
            p.inactivity_paused_until, p.row_version
       from "user" u left join notification_preference p on p.user_id = u.id
      where u.public_id = $1 and u.role = 'learner' and u.status = 'active'`,
    [learnerPublicId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    learnerId: row.public_id,
    quietHoursEnabled: row.quiet_hours_enabled ?? true,
    quietStartMinute: row.quiet_start_minute ?? 1_320,
    quietEndMinute: row.quiet_end_minute ?? 480,
    inactivityPausedUntil: row.inactivity_paused_until && row.inactivity_paused_until.getTime() > now.getTime()
      ? row.inactivity_paused_until
      : null,
    rowVersion: Number(row.row_version ?? 0),
  };
}

export async function setInactivityPause(input: {
  actorUserId: string;
  learnerPublicId: string;
  expectedVersion: number;
  pausedUntil: Date | null;
  reason: string;
  now?: Date;
}): Promise<InactivityPreferenceView> {
  const now = input.now ?? new Date();
  validNow(now);
  const reason = reasonValue(input.reason);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new NotificationPreferenceError("VERSION_CONFLICT", 409);
  }
  if (input.pausedUntil) {
    validNow(input.pausedUntil);
    const duration = input.pausedUntil.getTime() - now.getTime();
    if (duration <= 0 || duration > MAX_PAUSE_MS) {
      throw new NotificationPreferenceError("INVALID_PAUSE_UNTIL", 400);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const actor = await client.query(
      `select 1 from "user" where id = $1 and role = 'admin' and status = 'active'`,
      [input.actorUserId],
    );
    if (!actor.rowCount) throw new NotificationPreferenceError("ADMIN_REQUIRED", 403);
    const target = await client.query<{ id: string; public_id: string }>(
      `select id,public_id from "user"
        where public_id = $1 and role = 'learner' and status = 'active'
        for update`,
      [input.learnerPublicId],
    );
    const learner = target.rows[0];
    if (!learner) throw new NotificationPreferenceError("LEARNER_NOT_FOUND", 404);
    const current = await client.query<{
      row_version: string | number;
      quiet_hours_enabled: boolean;
      quiet_start_minute: number;
      quiet_end_minute: number;
    }>(
      `select row_version,quiet_hours_enabled,quiet_start_minute,quiet_end_minute
         from notification_preference where user_id = $1 for update`,
      [learner.id],
    );
    const currentVersion = Number(current.rows[0]?.row_version ?? 0);
    if (currentVersion !== input.expectedVersion) {
      throw new NotificationPreferenceError("VERSION_CONFLICT", 409);
    }
    const resultingVersion = currentVersion + 1;
    if (currentVersion === 0) {
      await client.query(
        `insert into notification_preference
          (user_id,inactivity_paused_until,inactivity_pause_reason,inactivity_paused_by,row_version,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$6)`,
        [learner.id, input.pausedUntil, input.pausedUntil ? reason : null, input.pausedUntil ? input.actorUserId : null, resultingVersion, now],
      );
    } else {
      const updated = await client.query(
        `update notification_preference
            set inactivity_paused_until = $2,
                inactivity_pause_reason = $3,
                inactivity_paused_by = $4,
                row_version = row_version + 1,
                updated_at = $5
          where user_id = $1 and row_version = $6`,
        [learner.id, input.pausedUntil, input.pausedUntil ? reason : null, input.pausedUntil ? input.actorUserId : null, now, currentVersion],
      );
      if (updated.rowCount !== 1) throw new NotificationPreferenceError("VERSION_CONFLICT", 409);
    }
    await client.query(
      `insert into notification (user_id,type,title,body,action_url,created_at)
       values ($1,'inactivity_preference_changed',$2,$3,'/settings',$4)`,
      [
        learner.id,
        input.pausedUntil ? "Learning reminders paused" : "Learning reminders resumed",
        input.pausedUntil
          ? `The administrator paused inactivity reminders until ${input.pausedUntil.toISOString()}.`
          : "The administrator resumed inactivity reminders.",
        now,
      ],
    );
    await client.query("commit");
    return {
      learnerId: learner.public_id,
      quietHoursEnabled: current.rows[0]?.quiet_hours_enabled ?? true,
      quietStartMinute: current.rows[0]?.quiet_start_minute ?? 1_320,
      quietEndMinute: current.rows[0]?.quiet_end_minute ?? 480,
      inactivityPausedUntil: input.pausedUntil,
      rowVersion: resultingVersion,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
