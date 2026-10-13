import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { DrizzleLearningStore } from "@/lib/learning-service/drizzle-store";
import { buildDashboardActivityQuery, type DashboardActivitySummary } from "@/lib/dashboard/history";
import { dashboardLocalDateKey, deriveActivityProjection, type DashboardActivityEvent } from "@/lib/dashboard/learner";
import { LESSON_COMPLETION_AUTHORITY } from "@/lib/learning-service/types";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

const NOW = new Date("2026-10-01T00:30:00Z");
const LESSON = "11111111-1111-4111-8111-111111111111";
const DELETED_LESSON = "22222222-2222-4222-8222-222222222222";
type Event = { owner?: string; at: string; subjectId?: string; authority?: boolean };
type Attempt = { owner?: string; enrollmentOwner?: string; at: string | null; status?: string };
const fixtures: Array<{ name: string; now?: Date; events: Event[]; attempts: Attempt[] }> = [
  { name: "empty learner", events: [], attempts: [] },
  { name: "one event", events: [{ at: NOW.toISOString(), subjectId: LESSON }], attempts: [] },
  { name: "UTC midnight, duplicate completion, invalid/deleted lesson and foreign owners", events: [
    { at: "2026-09-30T23:59:59Z", subjectId: `\t\u00a0${LESSON.toUpperCase()}\ufeff\n` },
    { at: NOW.toISOString(), subjectId: LESSON },
    { at: NOW.toISOString(), subjectId: DELETED_LESSON },
    { at: NOW.toISOString(), subjectId: "not-a-uuid" },
    { at: NOW.toISOString(), subjectId: LESSON, owner: "other" },
    { at: NOW.toISOString(), subjectId: LESSON, authority: false },
    { at: "2026-10-01T01:00:00Z", subjectId: LESSON },
    { at: "2024-01-01T00:00:00Z", subjectId: LESSON },
  ], attempts: [
    { at: "2026-09-30T23:59:59Z", status: "submitted" },
    { at: NOW.toISOString(), status: "grading" },
    { at: NOW.toISOString(), status: "graded" },
    { at: NOW.toISOString(), status: "created" },
    { at: null },
    { at: NOW.toISOString(), owner: "other" },
    { at: NOW.toISOString(), enrollmentOwner: "other" },
    { at: "2026-10-02T00:00:00Z" },
  ] },
  { name: "streak longer than one year and high-volume history", events: [{ at: "2024-01-01T00:00:00Z", subjectId: LESSON }], attempts: [
    ...Array.from({ length: 400 }, (_, i) => ({ at: new Date(NOW.getTime() - i * 86400000).toISOString() })),
    ...Array.from({ length: 2000 }, () => ({ at: "2024-01-01T00:00:00Z" })),
  ] },
  { name: "streak ending yesterday with an older gap", events: [], attempts: [
    { at: "2026-09-30T00:00:00Z" }, { at: "2026-09-29T00:00:00Z" }, { at: "2026-09-27T00:00:00Z" },
  ] },
  { name: "daylight-saving transition", now: new Date("2026-03-09T05:00:00Z"), events: [], attempts: [
    { at: "2026-03-08T06:59:00Z" }, { at: "2026-03-08T07:01:00Z" }, { at: "2026-03-09T04:00:00Z" },
  ] },
];

const COURSE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const VERSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const MODULE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const OWNER_ENROLLMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const OTHER_ENROLLMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
beforeAll(async () => {
  await resetDisposableIntegrationDatabase(pool);
  await db.insert(schema.user).values([
    { id: "owner", name: "Fixture owner", email: "owner@integration.invalid", status: "active" },
    { id: "other", name: "Other fixture", email: "other@integration.invalid", status: "active" },
  ]);
  await db.insert(schema.course).values({ id: COURSE, slug: "dashboard-fixture", title: "Fixture", summary: "Disposable dashboard fixture", domain: "programming" });
  await db.insert(schema.courseVersion).values({ id: VERSION, courseId: COURSE, version: "1.0.0", scopeStatement: "Disposable dashboard fixture", contentHash: "a".repeat(64) });
  await db.insert(schema.courseModule).values({ id: MODULE, courseVersionId: VERSION, slug: "fixture", title: "Fixture", objective: "Fixture", position: 0, estimatedMinutes: 10 });
  await db.insert(schema.lesson).values({ id: LESSON, moduleId: MODULE, slug: "fixture", title: "Fixture", objective: "Fixture", position: 0, estimatedMinutes: 10, difficulty: "beginner" });
  await db.insert(schema.enrollment).values([
    { id: OWNER_ENROLLMENT, userId: "owner", courseVersionId: VERSION, status: "active" },
    { id: OTHER_ENROLLMENT, userId: "other", courseVersionId: VERSION, status: "active" },
  ]);
});
afterAll(async () => { await pool.end(); });

describe("dashboard SQL history equivalence", () => {
  it("selects only the latest plan per enrollment while preserving revision order", async () => {
    const second = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await db.insert(schema.enrollment).values({ id: second, userId: "owner", courseVersionId: VERSION, status: "active" });
    const enrollments = [OWNER_ENROLLMENT, second];
    const client = await pool.connect();
    const queries: string[] = [];
    try {
      for (const [index, id] of enrollments.entries()) {
        await client.query(`insert into plan_revision (enrollment_id,revision,source,reason,policy_version,plan)
          select $1, n, 'initial', 'fixture', 'fixture', jsonb_build_array(jsonb_build_object(
            'schemaVersion',1,'id', $2::text || n::text,'skillId', 'fixture', 'trackId','fixture', 'languageContext','conceptual','kind','diagnostic'))
          from generate_series(1, $3::int) n`, [id, `plan-${index}-`, index ? 100 : 101]);
      }
      const prior = await client.query<{ enrollment_id: string; plan: Array<Record<string, unknown>> }>(
        "select enrollment_id, plan from plan_revision where enrollment_id = any($1::uuid[]) order by revision desc", [enrollments],
      );
      const seen = new Set<string>();
      const reference = prior.rows.filter((row) => {
        if (seen.has(row.enrollment_id)) return false;
        seen.add(row.enrollment_id); return true;
      }).flatMap((row) => row.plan);
      const database = drizzle(client, { schema, logger: { logQuery(query) { queries.push(query); } } });
      const snapshot = await new DrizzleLearningStore(database).transaction((transaction) => transaction.getAdaptiveSnapshot("owner"));
      expect(snapshot.planItems).toEqual(reference);
      expect(snapshot.planItems.map((item) => item.id)).toEqual(["plan-0-101", "plan-1-100"]);
      const planQuery = queries.find((query) => query.includes('"plan_revision"'));
      expect(planQuery).toMatch(/distinct on/i);
      expect(planQuery).toMatch(/order by.*revision.*desc/i);
    } finally {
      client.release();
    }
  });
  it.each(fixtures.flatMap((fixture) => ["UTC", "Asia/Calcutta", "America/New_York", "Pacific/Kiritimati"].map((zone) => ({ ...fixture, zone }))))(
    "$name ($zone)", async ({ events, attempts, zone, now = NOW }) => {
      const client = await pool.connect();
      const database = drizzle(client, { schema });
      try {
        await client.query("begin");
        await client.query("set local timezone = 'America/Los_Angeles'");
        await client.query("set local statement_timeout = '20s'");
        const sessions = await database.insert(schema.learningSession).values([
          { userId: "owner", enrollmentId: OWNER_ENROLLMENT, goal: "fixture", plannedMinutes: 10 },
          { userId: "other", enrollmentId: OTHER_ENROLLMENT, goal: "fixture", plannedMinutes: 10 },
        ]).returning({ id: schema.learningSession.id, userId: schema.learningSession.userId });
        if (events.length) {
          await database.insert(schema.sessionEvent).values(events.map((event, index) => ({
            sessionId: sessions.find((row) => row.userId === (event.owner ?? "owner"))!.id,
            userId: event.owner ?? "owner", clientEventId: `fixture-${index}`, type: "lesson_completed",
            occurredAt: new Date(event.at), subjectType: "lesson", subjectId: event.subjectId ?? null,
            metadata: event.authority === false ? {} : { authority: LESSON_COMPLETION_AUTHORITY },
          })));
        }
        // Distinct content versions avoid unrelated quadratic reward reconciliation.
        // Dashboard activity does not use content versions; all activity fields match the reference.
        for (let offset = 0; offset < attempts.length; offset += 50) {
          await database.insert(schema.attempt).values(attempts.slice(offset, offset + 50).map((row, index) => ({
            userId: row.owner ?? "owner", enrollmentId: row.enrollmentOwner === "other" ? OTHER_ENROLLMENT : OWNER_ENROLLMENT,
            kind: "practice" as const, status: (row.status ?? "graded") as typeof schema.attempt.$inferInsert.status,
            policyVersion: "fixture", contentVersion: `1.0.0-fixture.${offset + index}`, submittedAt: row.at ? new Date(row.at) : null,
          })));
        }
        const referenceRows: DashboardActivityEvent[] = [
          ...events.filter((row) => (row.owner ?? "owner") === "owner").map((row) => ({
            type: "lesson_completed", occurredAt: new Date(row.at), subjectType: "lesson", subjectId: row.subjectId ?? null, authoritative: row.authority !== false,
          })),
          ...attempts.filter((row) => (row.owner ?? "owner") === "owner" && (row.enrollmentOwner ?? "owner") === "owner" && ["submitted", "grading", "graded"].includes(row.status ?? "graded") && row.at !== null)
            .map((row) => ({ type: "attempt_submitted", occurredAt: new Date(row.at!), subjectType: "attempt", subjectId: null, authoritative: true })),
        ];
        // These tables have no deleted_at. Missing/deleted lesson IDs are excluded
        // by the same current-lesson lookup as the original projection.
        const query = new PgDialect().sqlToQuery(buildDashboardActivityQuery("owner", now, zone, dashboardLocalDateKey(now, zone)));
        const result = await client.query<DashboardActivitySummary>(query.sql, query.params);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.weeklyActivity).toHaveLength(7);
        expect(result.rows[0]).toEqual(deriveActivityProjection(referenceRows, now, new Set([LESSON]), zone));
      } finally {
        try { await client.query("rollback"); } finally { client.release(); }
      }
    },
    120_000,
  );
});
