import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";
import type { EmailTemplate } from "./outbox";

export const INACTIVITY_POLICY_VERSION = "inactivity-2026-07.v2";
export const FIRST_REMINDER_AFTER_MS = 24 * 60 * 60 * 1_000;
export const SECOND_REMINDER_AFTER_MS = 72 * 60 * 60 * 1_000;
const MINIMUM_REMINDER_SPACING_MS = 48 * 60 * 60 * 1_000;
const SCHEDULER_ADVISORY_LOCK = "6043340953362451";

type SchedulerPool = Pick<Pool, "connect">;

type Candidate = {
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

type Administrator = { id: string; email: string };

export type InactivityScheduleResult = {
  opened: number;
  closed: number;
  learnerFirst: number;
  adminNotices: number;
  learnerSecond: number;
  consentSkipped: number;
  paused: number;
  quietHours: number;
  adminUnavailable: number;
};

function addMilliseconds(value: Date, milliseconds: number) {
  return new Date(value.getTime() + milliseconds);
}

function validDate(value: Date) {
  if (!Number.isFinite(value.getTime())) throw new Error("Scheduler time must be a valid date.");
}

/** Invalid or removed IANA identifiers fail closed to UTC instead of crashing the worker. */
export function resolveIanaTimeZone(value: string | null | undefined) {
  const candidate = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "UTC";
  }
}

export function localMinuteOfDay(at: Date, timeZone: string) {
  validDate(at);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: resolveIanaTimeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("Could not calculate the learner's local time.");
  }
  return hour * 60 + minute;
}

export function isWithinQuietHours(input: {
  at: Date;
  timeZone: string;
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}) {
  if (!input.enabled) return false;
  if (
    !Number.isInteger(input.startMinute) || input.startMinute < 0 || input.startMinute > 1_439 ||
    !Number.isInteger(input.endMinute) || input.endMinute < 0 || input.endMinute > 1_439
  ) {
    throw new Error("Quiet-hour boundaries must be minute offsets from 0 through 1439.");
  }
  // Equal boundaries deliberately mean an all-day pause. Disable quiet hours
  // explicitly when no quiet window is wanted.
  if (input.startMinute === input.endMinute) return true;
  const current = localMinuteOfDay(input.at, input.timeZone);
  return input.startMinute < input.endMinute
    ? current >= input.startMinute && current < input.endMinute
    : current >= input.startMinute || current < input.endMinute;
}

function applicationUrl(path: string) {
  const url = new URL(path, process.env.APP_URL ?? "http://localhost:3000");
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("APP_URL must be an HTTP(S) URL without embedded credentials.");
  }
  return url.toString();
}

function emailIdempotencyKey(template: EmailTemplate, to: string, seed: string) {
  return createHash("sha256")
    .update(`${template}:${to.toLowerCase()}:${seed}`)
    .digest("hex");
}

async function persistEmail(
  client: PoolClient,
  input: {
    to: string;
    userId: string;
    template: EmailTemplate;
    variables: Record<string, string>;
    seed: string;
  },
) {
  const to = input.to.trim().toLowerCase();
  const idempotencyKey = emailIdempotencyKey(input.template, to, input.seed);
  const inserted = await client.query(
    `insert into email_outbox
      (user_id,to_email,template,template_version,variables,idempotency_key,status,next_attempt_at)
     values ($1,$2,$3,'2',$4::jsonb,$5,'pending',now())
     on conflict (idempotency_key) do nothing
     returning id`,
    [input.userId, to, input.template, JSON.stringify(input.variables), idempotencyKey],
  );
  if (inserted.rowCount) return true;
  const durable = await client.query(
    "select 1 from email_outbox where idempotency_key = $1",
    [idempotencyKey],
  );
  return Boolean(durable.rowCount);
}

async function loadCandidateIds(client: PoolClient) {
  return client.query<{ user_id: string }>(
    `select u.id as user_id
       from "user" u
       join learner_profile lp on lp.user_id = u.id and lp.onboarding_completed_at is not null
      where u.role = 'learner' and u.status = 'active'
      order by u.id`,
  );
}

async function loadCandidate(client: PoolClient, userId: string) {
  return client.query<Candidate>(
    `select
       u.id as user_id, u.name, u.email, u.timezone,
       coalesce(u.last_meaningful_activity_at, lp.onboarding_completed_at) as last_activity_at,
       consent.decision as consent_decision,
       consent.policy_version as consent_policy_version,
       np.quiet_hours_enabled, np.quiet_start_minute, np.quiet_end_minute,
       np.inactivity_paused_until,
       ie.id as episode_id, ie.last_activity_at as episode_last_activity_at,
       ie.eligible_at, ie.second_eligible_at,
       ie.learner_first_queued_at, ie.admin_notice_queued_at, ie.learner_second_queued_at
     from "user" u
     join learner_profile lp on lp.user_id = u.id and lp.onboarding_completed_at is not null
     left join notification_preference np on np.user_id = u.id
     left join inactivity_episode ie on ie.user_id = u.id and ie.closed_at is null
     left join lateral (
       select cr.decision, cr.policy_version
       from consent_record cr
       where cr.user_id = u.id and cr.purpose = 'inactivity_mentor_notice'
       order by cr.occurred_at desc, cr.created_at desc, cr.id desc
       limit 1
     ) consent on true
     where u.id = $1 and u.role = 'learner' and u.status = 'active'
     for update of u`,
    [userId],
  );
}

async function openEpisode(client: PoolClient, userId: string, lastActivityAt: Date, now: Date) {
  const eligibleAt = addMilliseconds(lastActivityAt, FIRST_REMINDER_AFTER_MS);
  const secondEligibleAt = addMilliseconds(lastActivityAt, SECOND_REMINDER_AFTER_MS);
  const inserted = await client.query<{ id: string }>(
    `insert into inactivity_episode
      (user_id,last_activity_at,eligible_at,second_eligible_at,opened_at,policy_version,created_at,updated_at)
     values ($1,$2,$3,$4,$5,$6,$5,$5)
     on conflict (user_id) where closed_at is null do nothing
     returning id`,
    [userId, lastActivityAt, eligibleAt, secondEligibleAt, now, INACTIVITY_POLICY_VERSION],
  );
  if (inserted.rows[0]) {
    return { id: inserted.rows[0].id, eligibleAt, secondEligibleAt, opened: true };
  }
  const existing = await client.query<{
    id: string;
    eligible_at: Date;
    second_eligible_at: Date;
  }>(
    `select id, eligible_at, second_eligible_at
       from inactivity_episode where user_id = $1 and closed_at is null for update`,
    [userId],
  );
  const episode = existing.rows[0];
  if (!episode) throw new Error("Active inactivity episode disappeared during scheduling.");
  return {
    id: episode.id,
    eligibleAt: episode.eligible_at,
    secondEligibleAt: episode.second_eligible_at,
    opened: false,
  };
}

export async function scheduleInactivityReminders(
  now = new Date(),
  schedulerPool: SchedulerPool = pool,
): Promise<InactivityScheduleResult> {
  validDate(now);
  const client = await schedulerPool.connect();
  const result: InactivityScheduleResult = {
    opened: 0,
    closed: 0,
    learnerFirst: 0,
    adminNotices: 0,
    learnerSecond: 0,
    consentSkipped: 0,
    paused: 0,
    quietHours: 0,
    adminUnavailable: 0,
  };
  let schedulerLockHeld = false;
  try {
    // The session lock serializes scheduler workers without stretching every
    // learner row lock across the whole batch. PostgreSQL releases it if this
    // pooled connection is lost; the explicit unlock keeps a healthy pooled
    // session from retaining it after this run.
    await client.query("select pg_advisory_lock($1::bigint)", [SCHEDULER_ADVISORY_LOCK]);
    schedulerLockHeld = true;
    const administrator = (await client.query<Administrator>(
      `select id, email from "user"
        where role = 'admin' and status = 'active'
        order by created_at, id limit 1`,
    )).rows[0] ?? null;
    const candidateIds = (await loadCandidateIds(client)).rows;
    for (const { user_id: userId } of candidateIds) {
      await client.query("begin");
      try {
        // READ COMMITTED gives this statement a fresh snapshot after the row
        // lock is acquired. Activity committed while we were waiting is
        // therefore observed before eligibility or outbox decisions.
        const candidate = (await loadCandidate(client, userId)).rows[0];
        if (!candidate) {
          await client.query("commit");
          continue;
        }
      const lastActivityAt = new Date(candidate.last_activity_at);
      let episodeId = candidate.episode_id;
      let episodeLastActivityAt = candidate.episode_last_activity_at
        ? new Date(candidate.episode_last_activity_at)
        : null;
      let eligibleAt = candidate.eligible_at ? new Date(candidate.eligible_at) : null;
      let secondEligibleAt = candidate.second_eligible_at
        ? new Date(candidate.second_eligible_at)
        : null;
      let learnerFirstQueuedAt = candidate.learner_first_queued_at
        ? new Date(candidate.learner_first_queued_at)
        : null;
      let adminNoticeQueuedAt = candidate.admin_notice_queued_at
        ? new Date(candidate.admin_notice_queued_at)
        : null;
      let learnerSecondQueuedAt = candidate.learner_second_queued_at
        ? new Date(candidate.learner_second_queued_at)
        : null;

      if (episodeId && episodeLastActivityAt && lastActivityAt.getTime() > episodeLastActivityAt.getTime()) {
        const closed = await client.query(
          `update inactivity_episode
              set closed_at = $2, updated_at = $2
            where id = $1 and closed_at is null`,
          [episodeId, now],
        );
        result.closed += closed.rowCount ?? 0;
        episodeId = null;
        episodeLastActivityAt = null;
        eligibleAt = null;
        secondEligibleAt = null;
        learnerFirstQueuedAt = null;
        adminNoticeQueuedAt = null;
        learnerSecondQueuedAt = null;
      }

      const defaultEligibleAt = addMilliseconds(lastActivityAt, FIRST_REMINDER_AFTER_MS);
      if (now.getTime() < defaultEligibleAt.getTime() && !episodeId) {
        await client.query("commit");
        continue;
      }

      const currentConsent = candidate.consent_decision === "accepted" &&
        candidate.consent_policy_version === ENROLLMENT_DISCLOSURE_VERSION;
      if (!currentConsent) {
        if (now.getTime() >= defaultEligibleAt.getTime()) result.consentSkipped += 1;
        await client.query("commit");
        continue;
      }

      eligibleAt ??= defaultEligibleAt;
      secondEligibleAt ??= addMilliseconds(lastActivityAt, SECOND_REMINDER_AFTER_MS);
      if (!episodeId) {
        const episode = await openEpisode(client, candidate.user_id, lastActivityAt, now);
        episodeId = episode.id;
        eligibleAt = episode.eligibleAt;
        secondEligibleAt = episode.secondEligibleAt;
        if (episode.opened) result.opened += 1;
      }
      if (now.getTime() < eligibleAt.getTime()) {
        await client.query("commit");
        continue;
      }

      if (candidate.inactivity_paused_until && new Date(candidate.inactivity_paused_until).getTime() > now.getTime()) {
        result.paused += 1;
        await client.query("commit");
        continue;
      }
      const quiet = isWithinQuietHours({
        at: now,
        timeZone: candidate.timezone,
        enabled: candidate.quiet_hours_enabled ?? true,
        startMinute: candidate.quiet_start_minute ?? 1_320,
        endMinute: candidate.quiet_end_minute ?? 480,
      });
      if (quiet) {
        result.quietHours += 1;
        await client.query("commit");
        continue;
      }

      const firstQueuedBeforeRun = learnerFirstQueuedAt;
      let firstQueuedAt = firstQueuedBeforeRun;
      if (!firstQueuedAt) {
        const durable = await persistEmail(client, {
          to: candidate.email,
          userId: candidate.user_id,
          template: "inactivity-reminder",
          variables: { name: candidate.name, url: applicationUrl("/learn") },
          seed: `${episodeId}:learner-first`,
        });
        if (durable) {
          await client.query(
            `update inactivity_episode
                set learner_first_queued_at = $2, reminder_sent_at = coalesce(reminder_sent_at,$2), updated_at = $2
              where id = $1 and learner_first_queued_at is null`,
            [episodeId, now],
          );
          firstQueuedAt = now;
          result.learnerFirst += 1;
        }
      }

      if (firstQueuedAt && !adminNoticeQueuedAt) {
        if (!administrator) {
          result.adminUnavailable += 1;
        } else {
          const durable = await persistEmail(client, {
            to: administrator.email,
            userId: administrator.id,
            template: "inactivity-admin-notice",
            variables: { name: "administrator", url: applicationUrl("/admin") },
            seed: `${episodeId}:admin`,
          });
          if (durable) {
            await client.query(
              `update inactivity_episode
                  set admin_notice_queued_at = $2, updated_at = $2
                where id = $1 and admin_notice_queued_at is null`,
              [episodeId, now],
            );
            result.adminNotices += 1;
          }
        }
      }

      if (firstQueuedBeforeRun && !learnerSecondQueuedAt) {
        const spacedEligibleAt = new Date(Math.max(
          secondEligibleAt.getTime(),
          firstQueuedBeforeRun.getTime() + MINIMUM_REMINDER_SPACING_MS,
        ));
        if (now.getTime() >= spacedEligibleAt.getTime()) {
          const durable = await persistEmail(client, {
            to: candidate.email,
            userId: candidate.user_id,
            template: "inactivity-reminder-followup",
            variables: { name: candidate.name, url: applicationUrl("/learn") },
            seed: `${episodeId}:learner-second`,
          });
          if (durable) {
            await client.query(
              `update inactivity_episode
                  set learner_second_queued_at = $2, updated_at = $2
                where id = $1 and learner_second_queued_at is null`,
              [episodeId, now],
            );
            result.learnerSecond += 1;
          }
        }
      }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
    }
    return result;
  } finally {
    if (schedulerLockHeld) {
      await client.query("select pg_advisory_unlock($1::bigint)", [SCHEDULER_ADVISORY_LOCK])
        .catch(() => undefined);
    }
    client.release();
  }
}
