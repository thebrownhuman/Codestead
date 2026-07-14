import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "@/lib/db/client";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";
import { computeAndPersistLeaderboardScore, loadCohortLeaderboards } from "@/lib/social/leaderboard-service";
import {
  listVisibleProfileOwners,
  loadVisibleCohortProfile,
  SocialProfileError,
  updateCohortProfile,
  withdrawCohortProfileForConsent,
} from "@/lib/social/profile-service";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const USER_A = "social-learner-a";
const USER_B = "social-learner-b";
const ADMIN = "social-admin";
const PUBLIC_A = "a1000000-0000-4000-8000-000000000001";
const PUBLIC_B = "a1000000-0000-4000-8000-000000000002";
const ACHIEVEMENT_ID = "a2000000-0000-4000-8000-000000000001";
const USER_ACHIEVEMENT_ID = "a2000000-0000-4000-8000-000000000002";
const PROJECT_ID = "a2000000-0000-4000-8000-000000000003";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Social integration tests require the disposable learncoding_integration database.");
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

async function seedPeopleAndSelections() {
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status)
     values ($1,$2,'Private Legal Name A','a-private@integration.invalid','learner','active'),
            ($3,$4,'Private Legal Name B','b-private@integration.invalid','learner','active'),
            ($5,$6,'Social Admin','social-admin@integration.invalid','admin','active')`,
    [USER_A, PUBLIC_A, USER_B, PUBLIC_B, ADMIN, "a1000000-0000-4000-8000-000000000003"],
  );
  await pool.query(
    `insert into achievement (id,slug,title,description,icon,rule_version,rule)
     values ($1,'social-evidence','Evidence Badge','Awarded from authoritative evidence.','medal','1','{}'::jsonb)`,
    [ACHIEVEMENT_ID],
  );
  await pool.query(
    `insert into user_achievement (id,user_id,achievement_id,evidence_id,visibility,awarded_at)
     values ($1,$2,$3,'evidence-private','private',$4)`,
    [USER_ACHIEVEMENT_ID, USER_A, ACHIEVEMENT_ID, NOW],
  );
  await pool.query(
    `insert into project (id,user_id,title,summary,status,visibility)
     values ($1,$2,'Selected portfolio project','A deliberately selected project summary safe for the cohort.','reviewed','private')`,
    [PROJECT_ID, USER_A],
  );
}

async function consent(input: { id: string; userId: string; purpose: "cohort_profile" | "leaderboard"; decision: "accepted" | "withdrawn"; at: Date }) {
  await pool.query(
    `insert into consent_record
      (id,user_id,purpose,policy_version,decision,data_categories,source,idempotency_key,occurred_at,created_at)
     values ($1,$2,$3,$4,$5,'[]'::jsonb,'settings',$6,$7,$7)`,
    [input.id, input.userId, input.purpose, ENROLLMENT_DISCLOSURE_VERSION, input.decision, `social:${input.id}`, input.at],
  );
}

function updateInput(overrides: Partial<Parameters<typeof updateCohortProfile>[0]> = {}) {
  return {
    actorUserId: USER_A,
    requestId: "a3000000-0000-4000-8000-000000000001",
    expectedVersion: 0,
    alias: "learner-alpha",
    bio: "A learner-controlled optional cohort bio.",
    showBio: false,
    showStreak: false,
    showMasterySummary: false,
    publish: false,
    selectedAchievementIds: [USER_ACHIEVEMENT_ID],
    selectedProjectIds: [PROJECT_ID],
    now: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seedPeopleAndSelections();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL closed-cohort privacy", () => {
  it("requires current bound consent plus explicit publication and serializes edits/withdrawal", async () => {
    await expect(updateCohortProfile(updateInput({ publish: true }))).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    const draftInput = updateInput();
    expect(await updateCohortProfile(draftInput)).toMatchObject({ rowVersion: 1, replayed: false, event: "created" });
    expect(await updateCohortProfile(draftInput)).toMatchObject({ rowVersion: 1, replayed: true });
    await expect(updateCohortProfile({ ...draftInput, alias: "mismatched-alias" })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(loadVisibleCohortProfile(PUBLIC_A)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listVisibleProfileOwners()).toEqual([]);
    const privateSelections = await pool.query<{ badge: string; project: string; selected_badges: string[]; selected_projects: string[] }>(
      `select
        (select visibility::text from user_achievement where id = $1) badge,
        (select visibility::text from project where id = $2) project,
        (select selected_achievement_ids from cohort_profile where user_id = $3) selected_badges,
        (select selected_project_ids from cohort_profile where user_id = $3) selected_projects`,
      [USER_ACHIEVEMENT_ID, PROJECT_ID, USER_A],
    );
    expect(privateSelections.rows[0]).toEqual({ badge: "private", project: "private", selected_badges: [USER_ACHIEVEMENT_ID], selected_projects: [PROJECT_ID] });

    const consentId = "a3000000-0000-4000-8000-000000000010";
    await consent({ id: consentId, userId: USER_A, purpose: "cohort_profile", decision: "accepted", at: NOW });
    const publishInput = updateInput({
      requestId: "a3000000-0000-4000-8000-000000000011",
      expectedVersion: 1,
      publish: true,
      showBio: true,
    });
    expect(await updateCohortProfile(publishInput)).toMatchObject({ rowVersion: 2, event: "published" });
    const projection = await loadVisibleCohortProfile(PUBLIC_A, NOW);
    expect(projection).toEqual({
      publicId: PUBLIC_A,
      alias: "learner-alpha",
      bio: "A learner-controlled optional cohort bio.",
      badges: [{ id: USER_ACHIEVEMENT_ID, title: "Evidence Badge", description: "Awarded from authoritative evidence.", icon: "medal" }],
      projects: [{ id: PROJECT_ID, title: "Selected portfolio project", summary: "A deliberately selected project summary safe for the cohort.", status: "reviewed" }],
    });
    const serialized = JSON.stringify(projection);
    for (const forbidden of ["Private Legal Name", "@integration.invalid", "score", "hours", "attempt", "hint", "code", "chat", "provider", "session"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    await consent({ id: "a3000000-0000-4000-8000-000000000016", userId: USER_B, purpose: "cohort_profile", decision: "accepted", at: NOW });
    await updateCohortProfile(updateInput({
      actorUserId: USER_B,
      requestId: "a3000000-0000-4000-8000-000000000017",
      alias: "learner-beta",
      bio: null,
      publish: true,
      selectedAchievementIds: [],
      selectedProjectIds: [],
    }));
    await expect(updateCohortProfile(updateInput({
      requestId: "a3000000-0000-4000-8000-000000000018",
      expectedVersion: 2,
      publish: true,
      alias: "Learner-Beta",
    }))).rejects.toMatchObject({ code: "ALIAS_TAKEN" });

    const concurrentInputs = [
      updateInput({ requestId: "a3000000-0000-4000-8000-000000000012", expectedVersion: 2, publish: true, alias: "learner-alpha-one" }),
      updateInput({ requestId: "a3000000-0000-4000-8000-000000000013", expectedVersion: 2, publish: true, alias: "learner-alpha-two" }),
    ];
    const concurrent = await Promise.allSettled(concurrentInputs.map(updateCohortProfile));
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(SocialProfileError);
    expect((concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "VERSION_CONFLICT" });
    const winner = concurrent.findIndex((result) => result.status === "fulfilled");
    expect(await updateCohortProfile(concurrentInputs[winner]!)).toMatchObject({ rowVersion: 3, replayed: true });

    const withdrawnConsentId = "a3000000-0000-4000-8000-000000000014";
    await consent({ id: withdrawnConsentId, userId: USER_A, purpose: "cohort_profile", decision: "withdrawn", at: new Date(NOW.getTime() + 1_000) });
    await expect(loadVisibleCohortProfile(PUBLIC_A, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await withdrawCohortProfileForConsent({ userId: USER_A, consentRequestId: withdrawnConsentId, now: new Date(NOW.getTime() + 1_000) });
    const hidden = await pool.query<{ is_published: boolean; badge: string; project: string; events: string; notices: string }>(
      `select cp.is_published,
        (select visibility::text from user_achievement where id = $2) badge,
        (select visibility::text from project where id = $3) project,
        (select count(*)::text from cohort_profile_event where user_id = $1) events,
        (select count(*)::text from notification where user_id = $1 and type = 'cohort_visibility_changed') notices
       from cohort_profile cp where cp.user_id = $1`,
      [USER_A, USER_ACHIEVEMENT_ID, PROJECT_ID],
    );
    expect(hidden.rows[0]).toEqual({ is_published: false, badge: "private", project: "private", events: "4", notices: "3" });
    await consent({ id: "a3000000-0000-4000-8000-000000000015", userId: USER_A, purpose: "cohort_profile", decision: "accepted", at: new Date(NOW.getTime() + 2_000) });
    await expect(loadVisibleCohortProfile(PUBLIC_A, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(pool.query(`update cohort_profile_event set reason = 'Attempted history rewrite should fail safely.' where user_id = $1`, [USER_A])).rejects.toMatchObject({ code: "23514" });
  });

  it("persists versioned capped scores and excludes users without both social opt-ins", async () => {
    await consent({ id: "a4000000-0000-4000-8000-000000000001", userId: USER_A, purpose: "cohort_profile", decision: "accepted", at: NOW });
    await consent({ id: "a4000000-0000-4000-8000-000000000002", userId: USER_A, purpose: "leaderboard", decision: "accepted", at: NOW });
    await updateCohortProfile(updateInput({ requestId: "a4000000-0000-4000-8000-000000000003", publish: true }));

    const courseId = "a5000000-0000-4000-8000-000000000001";
    const versionId = "a5000000-0000-4000-8000-000000000002";
    const moduleId = "a5000000-0000-4000-8000-000000000003";
    const lessonId = "a5000000-0000-4000-8000-000000000004";
    const enrollmentId = "a5000000-0000-4000-8000-000000000005";
    const sessionId = "a5000000-0000-4000-8000-000000000006";
    await pool.query(`insert into course (id,slug,title,summary,domain) values ($1,'social-course','Social Course','A disposable scoring course.','programming')`, [courseId]);
    await pool.query(`insert into course_version (id,course_id,version,stage,scope_statement,content_hash) values ($1,$2,'1.0.0','beta','Scoring scope',$3)`, [versionId, courseId, "a".repeat(64)]);
    await pool.query(`insert into course_module (id,course_version_id,slug,title,objective,position,estimated_minutes) values ($1,$2,'social.core','Social core','Scoring objective.',0,20)`, [moduleId, versionId]);
    await pool.query(`insert into lesson (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status) values ($1,$2,'social.lesson','Social lesson','Scoring lesson.',20,'beginner',0,'beta')`, [lessonId, moduleId]);
    await pool.query(`insert into enrollment (id,user_id,course_version_id,status,source,started_at) values ($1,$2,$3,'active','self',$4)`, [enrollmentId, USER_A, versionId, NOW]);
    await pool.query(`insert into learning_session (id,user_id,enrollment_id,goal,planned_minutes,status,started_at,last_activity_at) values ($1,$2,$3,'Score evidence',20,'active',$4,$4)`, [sessionId, USER_A, enrollmentId, new Date("2026-07-06T09:00:00Z")]);
    const conceptIds = ["a5000000-0000-4000-8000-000000000010", "a5000000-0000-4000-8000-000000000011"];
    for (let index = 0; index < conceptIds.length; index += 1) {
      await pool.query(`insert into concept (id,slug,title,domain,description) values ($1,$2,$3,'programming','Authoritative scoring concept.')`, [conceptIds[index], `social.concept-${index}`, `Concept ${index}`]);
      await pool.query(
        `insert into mastery_evidence (user_id,enrollment_id,concept_id,language_context,evidence_type,source_type,source_id,score,weight,validity,policy_version,recorded_by,recorded_at)
         values ($1,$2,$3,'Python','independent','attempt',$4,0.95,1,'valid','mastery-v1','adaptive-deterministic-engine',$5)`,
        [USER_A, enrollmentId, conceptIds[index], `mastery-source-${index}`, new Date(`2026-07-0${7 + index}T10:00:00Z`)],
      );
    }
    for (let day = 6; day <= 10; day += 1) {
      await pool.query(
        `insert into learning_session_event (session_id,user_id,client_event_id,type,subject_type,subject_id,metadata,occurred_at)
         values ($1,$2,$3,$4,'concept',$5,'{"meaningful":true}'::jsonb,$6)`,
        [sessionId, USER_A, `day-${day}`, day === 10 ? "remediation_recovered" : "lesson_completed", `subject-${day}`, new Date(`2026-07-${String(day).padStart(2, "0")}T11:00:00Z`)],
      );
    }
    await pool.query(`insert into project_review (project_id,commit_sha,analyzer_version,findings,status,created_at) values ($1,'commit-safe','1','[]'::jsonb,'complete',$2)`, [PROJECT_ID, new Date("2026-07-09T12:00:00Z")]);
    for (let index = 0; index < 5; index += 1) {
      const activityId = `a6000000-0000-4000-8000-00000000000${index}`;
      const attemptId = `a7000000-0000-4000-8000-00000000000${index}`;
      await pool.query(`insert into activity (id,lesson_id,slug,type,instructions,specification,difficulty,max_points) values ($1,$2,$3,'quiz','Independent evidence.','{}'::jsonb,'easy',100)`, [activityId, lessonId, `activity-${index}`]);
      await pool.query(
        `insert into attempt (id,user_id,activity_id,enrollment_id,kind,status,policy_version,content_version,score,passed,mastery_awarded,infrastructure_failure,graded_at)
         values ($1,$2,$3,$4,'quiz','graded','attempt-v1','1.0.0',1,true,true,false,$5)`,
        [attemptId, USER_A, activityId, enrollmentId, new Date("2026-07-11T12:00:00Z")],
      );
    }
    await pool.query(
      `insert into review_schedule
        (user_id,enrollment_id,concept_id,due_at,interval_days,ease_factor,reason,status,completed_attempt_id)
       values ($1,$2,$3,$4,1,2.5,'adaptive:v1:index=1;success=1;lapses=1;context=Python','completed',$5)`,
      [USER_A, enrollmentId, conceptIds[0], new Date("2026-07-10T12:00:00Z"), "a7000000-0000-4000-8000-000000000000"],
    );

    const concurrent = await Promise.all([
      computeAndPersistLeaderboardScore({ userId: USER_A, periodKind: "weekly", now: NOW }),
      computeAndPersistLeaderboardScore({ userId: USER_A, periodKind: "weekly", now: NOW }),
    ]);
    expect(concurrent.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(concurrent[0].totalPoints).toBe(456);
    expect(concurrent[0].components).toEqual({ consistency: 60, newMastery: 200, projects: 150, comeback: 40, xp: 6 });
    const [board, concurrentBoard] = await Promise.all([
      loadCohortLeaderboards(NOW),
      loadCohortLeaderboards(NOW),
    ]);
    expect(board.weekly.entries).toHaveLength(1);
    expect(board.weekly.entries[0]).toMatchObject({ alias: "learner-alpha", totalPoints: 456 });
    expect(board.allTime.entries[0]).toMatchObject({ alias: "learner-alpha", totalPoints: 460 });
    expect(concurrentBoard.weekly.entries).toEqual(board.weekly.entries);
    expect(concurrentBoard.allTime.entries).toEqual(board.allTime.entries);
    const publicPayload = JSON.stringify(board);
    for (const forbidden of [USER_A, "a-private@", "mastery-source", "subject-", "activity-"]) expect(publicPayload).not.toContain(forbidden);
    const initialSnapshots = await pool.query<{ period_kind: string; count: string; max_revision: string }>(
      `select period_kind,count(*)::text count,max(revision)::text max_revision
         from leaderboard_score_snapshot where user_id = $1
        group by period_kind order by period_kind`,
      [USER_A],
    );
    expect(initialSnapshots.rows).toEqual([
      { period_kind: "all_time", count: "1", max_revision: "1" },
      { period_kind: "weekly", count: "1", max_revision: "1" },
    ]);

    const replayedBoard = await loadCohortLeaderboards(NOW);
    expect(replayedBoard.weekly.entries).toEqual(board.weekly.entries);
    expect(replayedBoard.allTime.entries).toEqual(board.allTime.entries);
    const replayedSnapshots = await pool.query<{ count: string }>(
      `select count(*)::text count from leaderboard_score_snapshot where user_id = $1`,
      [USER_A],
    );
    expect(replayedSnapshots.rows[0]?.count).toBe("2");

    const secondProjectId = "a2000000-0000-4000-8000-000000000004";
    await pool.query(
      `insert into project (id,user_id,title,summary,status,visibility)
       values ($1,$2,'Second reviewed project','Additional independent project evidence.','reviewed','private')`,
      [secondProjectId, USER_A],
    );
    await pool.query(
      `insert into project_review (project_id,commit_sha,analyzer_version,findings,status,created_at)
       values ($1,'commit-safe-two','1','[]'::jsonb,'complete',$2)`,
      [secondProjectId, new Date(NOW.getTime() - 1_000)],
    );
    const revisedBoard = await loadCohortLeaderboards(NOW);
    expect(revisedBoard.weekly.entries[0]).toMatchObject({ alias: "learner-alpha", totalPoints: 606 });
    expect(revisedBoard.allTime.entries[0]).toMatchObject({ alias: "learner-alpha", totalPoints: 610 });
    const revisedSnapshots = await pool.query<{ period_kind: string; count: string; max_revision: string }>(
      `select period_kind,count(*)::text count,max(revision)::text max_revision
         from leaderboard_score_snapshot where user_id = $1
        group by period_kind order by period_kind`,
      [USER_A],
    );
    expect(revisedSnapshots.rows).toEqual([
      { period_kind: "all_time", count: "2", max_revision: "2" },
      { period_kind: "weekly", count: "2", max_revision: "2" },
    ]);
    await expect(pool.query(`update leaderboard_score_snapshot set total_points = 99999 where user_id = $1`, [USER_A])).rejects.toMatchObject({ code: "23514" });

    await consent({ id: "a4000000-0000-4000-8000-000000000004", userId: USER_A, purpose: "leaderboard", decision: "withdrawn", at: new Date(NOW.getTime() + 1_000) });
    expect((await loadCohortLeaderboards(NOW)).weekly.entries).toEqual([]);
    expect((await loadVisibleCohortProfile(PUBLIC_A, NOW)).alias).toBe("learner-alpha");
  });

  it("exports social evidence to its learner and erases it during administrator account deletion", async () => {
    await consent({ id: "a8000000-0000-4000-8000-000000000001", userId: USER_A, purpose: "cohort_profile", decision: "accepted", at: NOW });
    await consent({ id: "a8000000-0000-4000-8000-000000000002", userId: USER_A, purpose: "leaderboard", decision: "accepted", at: NOW });
    await updateCohortProfile(updateInput({ requestId: "a8000000-0000-4000-8000-000000000003", publish: true }));
    await computeAndPersistLeaderboardScore({ userId: USER_A, periodKind: "weekly", now: NOW });

    const exported = await createLearnerExport({
      learnerId: USER_A,
      actorUserId: ADMIN,
      requestId: "a8000000-0000-4000-8000-000000000004",
      now: NOW,
      maxRecords: 1_000,
      maxBytes: 2 * 1_024 * 1_024,
    });
    const exportText = await new Response(exported.stream).text();
    await exported.completion;
    expect(exportText).toContain('"category":"cohortProfile"');
    expect(exportText).toContain('"category":"cohortProfileHistory"');
    expect(exportText).toContain('"category":"leaderboardScoreEvidence"');
    expect(exportText).toContain("learner-alpha");

    const previousKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.DELETION_TOMBSTONE_KEY = "social-integration-deletion-key-long-enough";
    try {
      const report = await deleteLearnerAccount({
        actorUserId: ADMIN,
        learnerId: USER_A,
        requestId: "a8000000-0000-4000-8000-000000000005",
        reason: "Delete the synthetic social lifecycle learner.",
        now: NOW,
      });
      expect(report.deletedRows).toMatchObject({
        leaderboardScoreSnapshots: 1,
        cohortProfileEvents: 1,
        cohortProfile: 1,
        consentRecords: 2,
      });
      const remaining = await pool.query<{ profiles: string; events: string; snapshots: string; consents: string }>(
        `select
          (select count(*)::text from cohort_profile where user_id = $1) profiles,
          (select count(*)::text from cohort_profile_event where user_id = $1) events,
          (select count(*)::text from leaderboard_score_snapshot where user_id = $1) snapshots,
          (select count(*)::text from consent_record where user_id = $1) consents`,
        [USER_A],
      );
      expect(remaining.rows[0]).toEqual({ profiles: "0", events: "0", snapshots: "0", consents: "0" });
    } finally {
      if (previousKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousKey;
    }
  });
});
