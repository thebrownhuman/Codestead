import { sql } from "drizzle-orm";

import { attempt, enrollment, lesson, sessionEvent } from "@/lib/db/schema";
import { LESSON_COMPLETION_AUTHORITY } from "@/lib/learning-service/types";

export type DashboardActivitySummary = {
  readonly meaningfulThisWeek: number;
  readonly streak: number;
  readonly weeklyActivity: readonly number[];
  readonly completedLessons: number;
};

// Match String.trim(), including Unicode whitespace, before normalizing IDs.
const trimCharacters = "\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const trimPattern = `^[${trimCharacters}]+|[${trimCharacters}]+$`;
const lessonIdPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/** Aggregate lifetime history in PostgreSQL; return one row and seven buckets.
 * Lifetime distinct days are required to preserve arbitrarily long streaks.
 * Timestamps remain UTC; calendar bucketing uses the learner's resolved zone.
 */
export function buildDashboardActivityQuery(userId: string, now: Date, timeZone: string, todayKey: string) {
  return sql`
    with meaningful as (
      select ${sessionEvent.occurredAt} occurred_at,
             ${sessionEvent.subjectType} subject_type,
             lower(regexp_replace(${sessionEvent.subjectId}, ${trimPattern}, '', 'g')) subject_id,
             true lesson_completion
      from ${sessionEvent}
      where ${sessionEvent.userId} = ${userId}
        and ${sessionEvent.type} = 'lesson_completed'
        and ${sessionEvent.metadata}->>'authority' = ${LESSON_COMPLETION_AUTHORITY}
        and ${sessionEvent.occurredAt} <= ${now.toISOString()}::timestamptz
      union all
      select ${attempt.submittedAt}, null::text, null::text, false
      from ${attempt}
      inner join ${enrollment} on ${enrollment.id} = ${attempt.enrollmentId}
        and ${enrollment.userId} = ${userId}
      where ${attempt.userId} = ${userId}
        and ${attempt.status} in ('submitted', 'grading', 'graded')
        and ${attempt.submittedAt} is not null
        and ${attempt.submittedAt} <= ${now.toISOString()}::timestamptz
    ), days as (
      select (occurred_at at time zone ${timeZone})::date as activity_day, count(*)::int actions
      from meaningful group by 1
    ), ranked_days as (
      select activity_day, activity_day + (row_number() over (order by activity_day desc))::int island
      from days
    ), anchor as (
      select activity_day, island from ranked_days
      where activity_day in (${todayKey}::date, ${todayKey}::date - 1)
      order by activity_day desc limit 1
    ), week as (
      select ${todayKey}::date - 6 + generated.day_offset as activity_day, coalesce(days.actions, 0)::int actions
      from generate_series(0, 6) generated(day_offset)
      left join days on days.activity_day = ${todayKey}::date - 6 + generated.day_offset
    )
    select (select coalesce(sum(actions), 0)::int from week) "meaningfulThisWeek",
           (select count(*)::int from ranked_days inner join anchor using (island)) streak,
           array(select actions from week order by activity_day) "weeklyActivity",
           (select count(distinct ${lesson.id})::int from meaningful
            inner join ${lesson} on ${lesson.id}::text = meaningful.subject_id
            where lesson_completion and subject_type = 'lesson'
              and subject_id ~ ${lessonIdPattern}) "completedLessons"
  `;
}

export function projectDashboardActivitySummary(row: DashboardActivitySummary | undefined): DashboardActivitySummary {
  return row ?? { meaningfulThisWeek: 0, streak: 0, weeklyActivity: [0, 0, 0, 0, 0, 0, 0], completedLessons: 0 };
}
