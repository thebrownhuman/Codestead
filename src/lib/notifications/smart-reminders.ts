import { sql } from "drizzle-orm";

import { db, pool } from "@/lib/db/client";
import { notification, smartReminderDispatch } from "@/lib/db/schema";
import { enqueueEmailInTransaction, type EmailTemplate } from "@/lib/notifications/outbox";

export type SmartReminderKind = "daily_study" | "revision" | "goal" | "challenge" | "weekly_summary";

type Candidate = {
  id: string;
  name: string;
  email: string;
  last_meaningful_activity_at: Date | null;
  timezone: string;
  daily_study_enabled: boolean;
  revision_enabled: boolean;
  goal_enabled: boolean;
  challenge_enabled: boolean;
  weekly_summary_enabled: boolean;
  learning_email_enabled: boolean;
  daily_study_minute: number;
  revision_minute: number;
  quiet_hours_enabled: boolean;
  quiet_start_minute: number;
  quiet_end_minute: number;
  review_due: boolean;
  active_plan: boolean;
  upcoming_battle: boolean;
};

type LocalClock = {
  dateKey: string;
  weekKey: string;
  weekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  minute: number;
};

const copy: Record<SmartReminderKind, {
  title: string;
  body: string;
  actionUrl: string;
  template: EmailTemplate;
}> = {
  daily_study: {
    title: "One small coding step is enough",
    body: "No meaningful learning step is recorded today. Pick one short lesson or practice task when you are ready.",
    actionUrl: "/learn",
    template: "daily-study-reminder",
  },
  revision: {
    title: "A five-question refresh is ready",
    body: "Previous learning is due for retrieval practice. The review queue starts with the most useful concept to recall.",
    actionUrl: "/review",
    template: "revision-reminder",
  },
  goal: {
    title: "Choose this week's useful next step",
    body: "Your active roadmap is ready for a quick weekly check-in. Keep the goal realistic and evidence-based.",
    actionUrl: "/roadmap",
    template: "goal-reminder",
  },
  challenge: {
    title: "Your coding challenge is coming up",
    body: "A challenge you joined has an upcoming server-authoritative start time. Review its rules before it begins.",
    actionUrl: "/community?section=battles",
    template: "challenge-reminder",
  },
  weekly_summary: {
    title: "Your weekly learning summary is ready",
    body: "Review evidence-backed progress, strong concepts, and the next useful step. Missing activity is shown honestly.",
    actionUrl: "/learn",
    template: "weekly-summary",
  },
};

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return "UTC";
  }
}

function weekNumber(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil((((date.getTime() - start.getTime()) / 86_400_000) + 1) / 7) };
}

export function localClock(now: Date, requestedTimezone: string): LocalClock {
  const timezone = validTimezone(requestedTimezone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const week = weekNumber(year, month, day);
  return {
    dateKey: `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    weekKey: `${week.year}-W${week.week.toString().padStart(2, "0")}`,
    weekday: value("weekday") as LocalClock["weekday"],
    minute: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

function localDateKey(value: Date | null, timezone: string) {
  return value ? localClock(value, timezone).dateKey : null;
}

export function insideQuietHours(minute: number, start: number, end: number) {
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function dueKinds(candidate: Candidate, now: Date): Array<{ kind: SmartReminderKind; periodKey: string }> {
  const clock = localClock(now, candidate.timezone);
  if (candidate.quiet_hours_enabled && insideQuietHours(clock.minute, candidate.quiet_start_minute, candidate.quiet_end_minute)) return [];
  const due: Array<{ kind: SmartReminderKind; periodKey: string }> = [];
  if (candidate.revision_enabled && candidate.review_due && clock.minute >= candidate.revision_minute) {
    due.push({ kind: "revision", periodKey: clock.dateKey });
  } else if (
    candidate.daily_study_enabled
    && clock.minute >= candidate.daily_study_minute
    && localDateKey(candidate.last_meaningful_activity_at, candidate.timezone) !== clock.dateKey
  ) {
    due.push({ kind: "daily_study", periodKey: clock.dateKey });
  }
  if (candidate.challenge_enabled && candidate.upcoming_battle) {
    due.push({ kind: "challenge", periodKey: clock.dateKey });
  }
  if (candidate.goal_enabled && candidate.active_plan && clock.weekday === "Mon" && clock.minute >= candidate.daily_study_minute) {
    due.push({ kind: "goal", periodKey: clock.weekKey });
  }
  if (candidate.weekly_summary_enabled && clock.weekday === "Sun" && clock.minute >= candidate.daily_study_minute) {
    due.push({ kind: "weekly_summary", periodKey: clock.weekKey });
  }
  return due;
}

async function loadCandidates(now: Date, limit: number): Promise<Candidate[]> {
  const result = await pool.query<Candidate>(
    `select u.id,u.name,u.email,u.last_meaningful_activity_at,
            p.timezone,p.daily_study_enabled,p.revision_enabled,p.goal_enabled,
            p.challenge_enabled,p.weekly_summary_enabled,p.learning_email_enabled,
            p.daily_study_minute,p.revision_minute,p.quiet_hours_enabled,
            p.quiet_start_minute,p.quiet_end_minute,
            exists(
              select 1 from review_schedule rs
              join enrollment e on e.id = rs.enrollment_id and e.user_id = u.id
              where rs.due_at <= $1 and rs.status='scheduled' and e.status in ('active','completed')
            ) as review_due,
            exists(select 1 from enrollment e where e.user_id=u.id and e.status='active') as active_plan,
            exists(
              select 1 from coding_battle_participant bp
              join coding_battle b on b.id=bp.battle_id
              where bp.user_id=u.id and b.status='active' and b.starts_at > $1 and b.starts_at <= $1 + interval '48 hours'
            ) as upcoming_battle
       from "user" u
       join notification_preference p on p.user_id=u.id
      where u.role='learner' and u.status='active'
        and (p.daily_study_enabled or p.revision_enabled or p.goal_enabled
          or p.challenge_enabled or p.weekly_summary_enabled)
      order by u.id
      limit $2`,
    [now, limit],
  );
  return result.rows;
}

async function dispatch(candidate: Candidate, kind: SmartReminderKind, periodKey: string, now: Date) {
  return db.transaction(async (tx) => {
    // The scan is only a hint. Lock and rebuild the complete due decision in
    // the write transaction so a concurrent opt-out, email-off change,
    // activity, review completion, plan change, or battle change wins.
    const locked = await tx.execute(sql<Candidate>`
      select u.id,u.name,u.email,u.last_meaningful_activity_at,
             p.timezone,p.daily_study_enabled,p.revision_enabled,p.goal_enabled,
             p.challenge_enabled,p.weekly_summary_enabled,p.learning_email_enabled,
             p.daily_study_minute,p.revision_minute,p.quiet_hours_enabled,
             p.quiet_start_minute,p.quiet_end_minute,
             exists(
               select 1 from review_schedule rs
               join enrollment e on e.id = rs.enrollment_id and e.user_id = u.id
               where rs.due_at <= cast(${now} as timestamptz) and rs.status='scheduled'
                 and e.status in ('active','completed')
             ) as review_due,
             exists(
               select 1 from enrollment e
                where e.user_id=u.id and e.status='active'
             ) as active_plan,
             exists(
               select 1 from coding_battle_participant bp
               join coding_battle b on b.id=bp.battle_id
                where bp.user_id=u.id and b.status='active'
                  and b.starts_at > cast(${now} as timestamptz)
                  and b.starts_at <= cast(${now} as timestamptz) + interval '48 hours'
             ) as upcoming_battle
        from "user" u
        join notification_preference p on p.user_id=u.id
       where u.id=${candidate.id} and u.role='learner' and u.status='active'
       for update of u,p
    `);
    const current = locked.rows[0] as Candidate | undefined;
    if (!current) return false;
    const stillDue = dueKinds(current, now).some(
      (item) => item.kind === kind && item.periodKey === periodKey,
    );
    if (!stillDue) return false;
    const [receipt] = await tx
      .insert(smartReminderDispatch)
      .values({
        userId: current.id,
        kind,
        localPeriodKey: periodKey,
        timezone: current.timezone,
        evidence: {
          policyVersion: "smart-reminders-2026-07.v1",
          reviewDue: kind === "revision",
          activePlan: kind === "goal",
          upcomingBattle: kind === "challenge",
          noMeaningfulActivityToday: kind === "daily_study",
        },
        scheduledFor: now,
        dispatchedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: smartReminderDispatch.id });
    if (!receipt) return false;
    const item = copy[kind];
    await tx.insert(notification).values({
      userId: current.id,
      type: `smart_reminder.${kind}`,
      title: item.title,
      body: item.body,
      actionUrl: item.actionUrl,
      createdAt: now,
    });
    if (current.learning_email_enabled) {
      const appUrl = process.env.APP_URL ?? "http://localhost:3000";
      await enqueueEmailInTransaction(tx, {
        userId: current.id,
        to: current.email,
        template: item.template,
        variables: {
          name: current.name,
          url: new URL(item.actionUrl, appUrl).toString(),
          ...(kind === "weekly_summary" ? { summary: "Your private, evidence-backed weekly summary is ready inside Codestead." } : {}),
        },
        idempotencySeed: `smart-reminder:${receipt.id}`,
      });
    }
    return true;
  });
}

export async function scheduleSmartReminders(now = new Date(), limit = 100) {
  if (!Number.isFinite(now.getTime())) throw new Error("Smart-reminder clock is invalid.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Smart-reminder batch limit is invalid.");
  const candidates = await loadCandidates(now, limit);
  let dispatched = 0;
  let failed = 0;
  for (const candidate of candidates) {
    let dispatchedForCandidate = 0;
    for (const reminder of dueKinds(candidate, now)) {
      if (dispatchedForCandidate >= 2) break;
      try {
        if (await dispatch(candidate, reminder.kind, reminder.periodKey, now)) {
          dispatched += 1;
          dispatchedForCandidate += 1;
        }
      } catch (error) {
        failed += 1;
        const cause = error instanceof Error ? error.cause : undefined;
        const databaseCode = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
        const causeCode = typeof cause === "object" && cause !== null && "code" in cause
          ? String((cause as { code?: unknown }).code ?? "")
          : "";
        console.error(JSON.stringify({
          event: "smart_reminder.dispatch_failed",
          kind: reminder.kind,
          errorName: error instanceof Error ? error.name : "UnknownError",
          ...(databaseCode ? { databaseCode } : {}),
          ...(causeCode ? { causeCode } : {}),
          ...(process.env.INTEGRATION_TEST === "1" && cause instanceof Error
            ? { diagnosticCause: cause.message }
            : {}),
        }));
      }
    }
  }
  return { candidates: candidates.length, dispatched, failed };
}
