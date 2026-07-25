import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createBattle,
  getBattle,
  listBattles,
  joinBattle,
  submitBattle,
} from "@/lib/battles/service";
import {
  addCommunityGroupMember,
  createCommunityGroup,
  createCommunityPost,
  createCommunityReply,
  deleteCommunityContent,
  editCommunityContent,
  listCommunity,
  listCommunityReports,
  moderateCommunityContent,
  reportCommunityContent,
} from "@/lib/community/service";
import { hashCurriculumValue } from "@/lib/curriculum-publication/hash";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import { pool } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { DrizzleLearningStore } from "@/lib/learning-service/drizzle-store";
import { LearningService } from "@/lib/learning-service/service";
import {
  scheduleSmartReminders,
  scheduleSmartRemindersWithDatabase,
} from "@/lib/notifications/smart-reminders";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";
import { createProjectRevision } from "@/lib/projects/revision-service";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";
import { truncateMutableApplicationTables } from "./helpers/truncate-application-tables";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const ADMIN = "community-battle-admin";
const LEARNER_A = "community-battle-a";
const LEARNER_B = "community-battle-b";
const LEARNER_C = "community-battle-c";
const PUBLIC_A = "cb000000-0000-4000-8000-000000000001";
const PUBLIC_B = "cb000000-0000-4000-8000-000000000002";
const PUBLIC_C = "cb000000-0000-4000-8000-000000000003";
const COURSE = "cb100000-0000-4000-8000-000000000001";
const VERSION = "cb100000-0000-4000-8000-000000000002";
const MODULE = "cb100000-0000-4000-8000-000000000003";
const LESSON = "cb100000-0000-4000-8000-000000000004";
const CONCEPT = "cb100000-0000-4000-8000-000000000005";
const ACTIVITY = "cb100000-0000-4000-8000-000000000006";
const ARTIFACT = "cb100000-0000-4000-8000-000000000007";
const PLAN_FOUNDATIONS_COURSE = "cb700000-0000-4000-8000-000000000001";
const PLAN_FOUNDATIONS_VERSION = "cb700000-0000-4000-8000-000000000002";
const PLAN_PYTHON_COURSE = "cb700000-0000-4000-8000-000000000003";
const PLAN_PYTHON_VERSION = "cb700000-0000-4000-8000-000000000004";
const ITEM = "python.variables.choice.1";
const LEARNER_A_ENROLLMENT = "cb600000-0000-4000-8000-000000000001";
const MEANINGFUL_SESSION = "cb700000-0000-4000-8000-000000000001";
const MEANINGFUL_ATTEMPT = "cb700000-0000-4000-8000-000000000002";
const MEANINGFUL_EVIDENCE = "cb700000-0000-4000-8000-000000000003";
const MEANINGFUL_PROJECT = "cb700000-0000-4000-8000-000000000004";
const PROJECT_REVISION_REQUEST = "cb700000-0000-4000-8000-000000000005";
let communityOperationSequence = 0;
let reminderRaceSequence = 0;

const reminderAppDatabaseUrl = process.env.DATABASE_APP_URL;
if (!reminderAppDatabaseUrl) {
  throw new Error("Community integration tests require DATABASE_APP_URL for restricted-role races.");
}
const parsedReminderAppUrl = new URL(reminderAppDatabaseUrl);
const expectedReminderAppRole = decodeURIComponent(parsedReminderAppUrl.username);
const expectedReminderDatabase = decodeURIComponent(parsedReminderAppUrl.pathname.slice(1));
const reminderAppPool = new Pool({
  connectionString: reminderAppDatabaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

function nextCommunityRequestId() {
  communityOperationSequence += 1;
  return `cc900000-0000-4000-8000-${String(communityOperationSequence).padStart(12, "0")}`;
}

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Community integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  await truncateMutableApplicationTables(pool);
}

function assessmentBank() {
  return {
    $schema: "../../schema/assessment-bank.schema.json",
    format: "assessment-bank",
    schemaVersion: "1.0.0",
    id: "bank.python.variables.v1",
    courseId: "python",
    courseVersion: "1.0.0",
    moduleId: "python.variables",
    skillId: "python.variables",
    title: "Reviewed Python variable assignments",
    publication: {
      stage: "approved",
      author: { id: "integration-human-author", displayName: "Integration Human Author", kind: "human" },
      authoredAt: "2026-07-14T09:00:00.000Z",
      aiAssisted: false,
      reviewer: {
        id: ADMIN,
        displayName: "Community Admin",
        kind: "human",
        reviewedAt: "2026-07-14T10:00:00.000Z",
        reviewVersion: "1.0.0",
      },
      changeSummary: "Synthetic deterministic battle fixture independently reviewed by a human.",
    },
    sourceRefs: ["python-tutorial"],
    items: [{
      id: ITEM,
      skillId: "python.variables",
      title: "Choose a variable assignment",
      kind: "mcq",
      prompt: "Which line stores the number 7 in score?",
      points: 1,
      evidenceLevel: "apply",
      examEligibility: {
        eligible: true,
        rationale: "The deterministic answer was independently reviewed for this disposable fixture.",
      },
      hints: ["The variable name belongs on the left side."],
      feedback: { correct: "That assignment is correct.", incorrect: "Review the direction of assignment." },
      rubric: {
        passPoints: 1,
        criteria: [{ id: "assignment", description: "Selects a valid assignment.", points: 1, critical: true }],
      },
      privateAuthorNotes: ["Disposable integration answer oracle."],
      options: [
        { id: "a", text: "score = 7" },
        { id: "b", text: "7 = score" },
      ],
      answer: { correctOptionIds: ["a"], explanation: "Assignment stores the right-side value in the left-side name." },
    }],
  };
}

async function seedPeopleAndReviewedActivity() {
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status)
     values ($1,$2,'Private learner A','community-a@integration.invalid','learner','active'),
            ($3,$4,'Private learner B','community-b@integration.invalid','learner','active'),
            ($5,$6,'Private learner C','community-c@integration.invalid','learner','active'),
            ($7,$8,'Community Admin','community-admin@integration.invalid','admin','active')`,
    [LEARNER_A, PUBLIC_A, LEARNER_B, PUBLIC_B, LEARNER_C, PUBLIC_C,
      ADMIN, "cb000000-0000-4000-8000-000000000004"],
  );
  for (const [id, userId, alias] of [
    ["cb200000-0000-4000-8000-000000000001", LEARNER_A, "learner-alpha"],
    ["cb200000-0000-4000-8000-000000000002", LEARNER_B, "learner-beta"],
  ]) {
    await pool.query(
      `insert into consent_record
        (id,user_id,purpose,policy_version,decision,data_categories,source,idempotency_key,occurred_at,created_at)
       values ($1,$2,'cohort_profile',$3,'accepted','[]'::jsonb,'settings',$4,$5,$5)`,
      [id, userId, ENROLLMENT_DISCLOSURE_VERSION, `community:${id}`, NOW],
    );
    await pool.query(
      `insert into cohort_profile
        (user_id,alias,is_published,published_consent_record_id,published_at,row_version)
       values ($1,$2,true,$3,$4,1)`,
      [userId, alias, id, NOW],
    );
  }

  const bank = assessmentBank();
  const bankHash = hashCurriculumValue(bank);
  await pool.query(
    `insert into course (id,slug,title,summary,domain)
     values ($1,'community-python','Community Python','Reviewed battle fixture.','programming')`, [COURSE],
  );
  await pool.query(
    `insert into course_version
      (id,course_id,version,stage,scope_statement,content_hash)
     values ($1,$2,'1.0.0','beta','Reviewed community battle scope.',$3)`,
    [VERSION, COURSE, "c".repeat(64)],
  );
  await pool.query(
    `insert into course_module
      (id,course_version_id,slug,title,objective,position,estimated_minutes)
     values ($1,$2,'variables','Variables','Store values safely.',1,30)`, [MODULE, VERSION],
  );
  await pool.query(
    `insert into lesson
      (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status)
     values ($1,$2,'variable-assignment','Variable assignment','Practice reviewed assignments.',10,'beginner',1,'beta')`,
    [LESSON, MODULE],
  );
  await pool.query(
    `insert into concept (id,slug,title,domain,description)
     values ($1,'python.variables','Python variables','programming','Store named values in Python.')`, [CONCEPT],
  );
  // The materialized activity is deliberately forged. Battle creation must
  // rebuild the canonical prompt and grader from the reviewed bank instead.
  await pool.query(
    `insert into activity
      (id,lesson_id,concept_id,slug,type,instructions,specification,difficulty,max_points)
     values ($1,$2,$3,'variables-choice','quiz-mcq','UNREVIEWED MUTABLE WORDING',
       $4::jsonb,'beginner',100)`,
    [ACTIVITY, LESSON, CONCEPT, JSON.stringify({
      authoredItemId: ITEM,
      title: "Forged title",
      prompt: "Forged prompt",
      language: "Forged language",
      grading: { kind: "choice", acceptedAnswers: ["b"] },
    })],
  );
  await pool.query(
    `insert into curriculum_artifact
      (id,course_version_id,artifact_key,artifact_type,skill_key,source_path,content,content_hash,
       publication_stage,ai_assisted,provenance,review_status,row_version)
     values ($1,$2,'bank.python.variables.v1','assessment_bank','python.variables','integration/community-bank.json',
       $3::jsonb,$4,'published',false,'{"fixture":true}'::jsonb,'approved',2)`,
    [ARTIFACT, VERSION, JSON.stringify(bank), bankHash],
  );
  await pool.query(
    `insert into curriculum_review_event
      (artifact_id,reviewer_user_id,reviewer_kind,decision,request_id,content_hash,checklist,
       reviewed_item_ids,reason,resulting_version,occurred_at)
     values ($1,$2,'human','approved',$3,$4,'{"technical":true,"pedagogy":true,"accessibility":true}'::jsonb,
       $5::jsonb,'Independently reviewed deterministic battle fixture.',2,$6)`,
    [ARTIFACT, ADMIN, "cb300000-0000-4000-8000-000000000001", bankHash, JSON.stringify([ITEM]), NOW],
  );
  await pool.query(
    `insert into curriculum_publication_pointer
      (course_id,current_course_version_id,updated_by,reason,updated_at)
     values ($1,$2,$3,'Publish reviewed disposable battle fixture.',$4)`,
    [COURSE, VERSION, ADMIN, NOW],
  );
  const eligibleLearners = [
    [LEARNER_A, "cb600000-0000-4000-8000-000000000001", "cb600000-0000-4000-8000-000000000011"],
    [LEARNER_B, "cb600000-0000-4000-8000-000000000002", "cb600000-0000-4000-8000-000000000012"],
    [LEARNER_C, "cb600000-0000-4000-8000-000000000003", "cb600000-0000-4000-8000-000000000013"],
  ] as const;
  for (const [userId, enrollmentId, planId] of eligibleLearners) {
    await pool.query(
      `insert into enrollment
        (id,user_id,course_version_id,status,source,started_at)
       values ($1,$2,$3,'active','self',$4)`,
      [enrollmentId, userId, VERSION, NOW],
    );
    await pool.query(
      `insert into plan_revision
        (id,enrollment_id,revision,source,reason,policy_version,created_by,plan,created_at)
       values ($1,$2,1,'adaptive','Create the disposable battle-eligible plan.','adaptive-plan-v1',$3,$4::jsonb,$5)`,
      [planId, enrollmentId, ADMIN, JSON.stringify([{
        schemaVersion: 1,
        id: "variables-learn",
        kind: "learn",
        trackId: "python",
        courseVersion: "1.0.0",
        moduleId: "python.variables",
        skillId: "python.variables",
        title: "Python variables",
        position: 0,
        required: true,
        prerequisites: [],
        evidenceTypes: ["quiz"],
        languageContext: "python",
        goalPriority: 10,
        prerequisiteCentrality: 1,
      }]), NOW],
    );
  }
}

async function createInviteBattle(
  databasePool: Pick<typeof pool, "connect"> = pool,
) {
  return createBattle({
    actorUserId: LEARNER_A,
    requestId: "cb400000-0000-4000-8000-000000000001",
    activityId: ACTIVITY,
    scope: "invite",
    invitedPublicIds: [PUBLIC_B],
    startsAt: NOW,
    durationMinutes: 60,
    now: NOW,
  }, databasePool);
}

type PoolClientWithProcessId = PoolClient & {
  readonly processID?: number;
};

type ReminderBackendIdentity = {
  pid: number;
  databaseName: string;
  sessionUser: string;
  currentUser: string;
  applicationName: string;
};

type ReminderLockQuery = "user" | "preference";

const REMINDER_LOCK_QUERY_FRAGMENTS = {
  user: ["%select u.id%", '%from "user" u%', "%for update of u%"],
  preference: ["%select p.user_id%", "%from notification_preference p%", "%for update of p%"],
} satisfies Record<ReminderLockQuery, readonly [string, string, string]>;

async function captureReminderBackendIdentity(
  client: PoolClient,
): Promise<ReminderBackendIdentity> {
  const processId = (client as PoolClientWithProcessId).processID;
  if (!Number.isSafeInteger(processId)) {
    throw new Error("The restricted PostgreSQL client has no processID.");
  }
  const result = await client.query<ReminderBackendIdentity>(`
    select pg_backend_pid()::integer "pid",
           current_database()::text "databaseName",
           session_user::text "sessionUser",
           current_user::text "currentUser",
           current_setting('application_name')::text "applicationName"
  `);
  const identity = result.rows[0];
  if (!identity || identity.pid !== processId) {
    throw new Error("The restricted PostgreSQL backend PID does not match PoolClient.processID.");
  }
  if (
    identity.databaseName !== expectedReminderDatabase
    || identity.sessionUser !== expectedReminderAppRole
    || identity.currentUser !== expectedReminderAppRole
  ) {
    throw new Error("The reminder race backend is not using the production application role.");
  }
  return identity;
}

async function identifyReminderBackend(client: PoolClient, applicationName: string) {
  await client.query("select set_config('application_name',$1,false)", [applicationName]);
  return captureReminderBackendIdentity(client);
}

async function waitForBackendBlockers(
  observer: PoolClient,
  waitingPid: number,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await observer.query<{ blockers: number[] }>(
      "select pg_blocking_pids($1::integer) blockers",
      [waitingPid],
    );
    const blockers = result.rows[0]?.blockers ?? [];
    if (blockers.length > 0) return blockers;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${waitingPid} did not enter a PostgreSQL lock wait.`);
}

function createRestrictedAppPool() {
  return new Pool({
    connectionString: reminderAppDatabaseUrl,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

async function identifyRestrictedPoolBackend(databasePool: Pool, applicationName: string) {
  const client = await databasePool.connect();
  try {
    return await identifyReminderBackend(client, applicationName);
  } finally {
    client.release();
  }
}

async function waitForExactBackendLock(
  observer: PoolClient,
  waiting: ReminderBackendIdentity,
  blocker: ReminderBackendIdentity,
  queryFragments: readonly string[],
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await observer.query<{
      pid: number;
      backend_type: string;
      datname: string;
      usename: string;
      application_name: string;
      state: string | null;
      wait_event_type: string | null;
      query: string | null;
      blockers: number[];
    }>(`
      select activity.pid,activity.backend_type,activity.datname,activity.usename,
             activity.application_name,activity.state,activity.wait_event_type,
             activity.query,pg_blocking_pids(activity.pid) blockers
        from pg_stat_activity activity
       where activity.pid=$1
    `, [waiting.pid]);
    const row = result.rows[0];
    const normalizedQuery = row?.query?.toLowerCase() ?? "";
    if (
      row?.pid === waiting.pid
      && row.backend_type === "client backend"
      && row.datname === waiting.databaseName
      && row.usename === waiting.sessionUser
      && row.application_name === waiting.applicationName
      && row.state === "active"
      && row.wait_event_type === "Lock"
      && row.blockers.includes(blocker.pid)
      && queryFragments.every((fragment) => normalizedQuery.includes(fragment.toLowerCase()))
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Backend ${waiting.pid} did not enter the expected lock wait behind ${blocker.pid}.`,
  );
}

function pauseClientQuery(
  client: PoolClient,
  matches: (query: string) => boolean,
  timing: "before" | "after",
) {
  let reachedResolve!: () => void;
  let resumeResolve!: () => void;
  let paused = false;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resumeResolve = resolve;
  });
  const originalQuery = client.query.bind(client) as (
    query: string,
    values?: unknown[],
  ) => Promise<unknown>;
  client.query = (async (query: string, values?: unknown[]) => {
    const shouldPause = !paused && matches(query);
    if (shouldPause) paused = true;
    if (shouldPause && timing === "before") {
      reachedResolve();
      await resumed;
    }
    const result = await originalQuery(query, values);
    if (shouldPause && timing === "after") {
      reachedResolve();
      await resumed;
    }
    return result;
  }) as typeof client.query;
  return { reached, resume: () => resumeResolve() };
}

async function beginLearnerAuthorityErasure(client: PoolClient, userId: string) {
  await client.query("begin");
  await client.query(
    "select pg_advisory_xact_lock(hashtext($1))",
    [userAuthorityLockKey(userId)],
  );
  await client.query(`select id from "user" where id=$1 for update`, [userId]);
  await client.query("select set_config('app.account_deletion_authorized','1',true)");
}

async function finishLearnerAuthorityErasure(client: PoolClient, userId: string) {
  await client.query(
    `update "user" set status='deleted',row_version=row_version+1,updated_at=clock_timestamp()
      where id=$1`,
    [userId],
  );
  await client.query("delete from coding_battle_submission where user_id=$1", [userId]);
  await client.query("delete from coding_battle_participant where user_id=$1", [userId]);
  await client.query(
    "delete from plan_revision where enrollment_id in (select id from enrollment where user_id=$1)",
    [userId],
  );
  await client.query("delete from enrollment where user_id=$1", [userId]);
  await client.query("delete from learner_profile where user_id=$1", [userId]);
  await client.query("delete from cohort_profile where user_id=$1", [userId]);
  await client.query("delete from consent_record where user_id=$1", [userId]);
  await client.query("commit");
}

async function eraseLearnerAuthorityScope(databasePool: Pool, userId: string) {
  const client = await databasePool.connect();
  try {
    await beginLearnerAuthorityErasure(client, userId);
    await finishLearnerAuthorityErasure(client, userId);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedPlanInitializationPublications() {
  await pool.query(
    `insert into course (id,slug,title,summary,domain)
     values ($1,'programming-foundations','Programming foundations','Plan race fixture.','programming'),
            ($2,'python','Python','Plan race fixture.','programming')`,
    [PLAN_FOUNDATIONS_COURSE, PLAN_PYTHON_COURSE],
  );
  await pool.query(
    `insert into course_version
      (id,course_id,version,stage,scope_statement,content_hash)
     values ($1,$2,'0.1.0','beta','Plan race foundation scope.',$5),
            ($3,$4,'0.1.0','beta','Plan race Python scope.',$5)`,
    [PLAN_FOUNDATIONS_VERSION, PLAN_FOUNDATIONS_COURSE, PLAN_PYTHON_VERSION, PLAN_PYTHON_COURSE, "d".repeat(64)],
  );
  await pool.query(
    `insert into curriculum_publication_pointer
      (course_id,current_course_version_id,updated_by,reason,updated_at)
     values ($1,$2,$5,'Publish plan race foundation.',$6),
            ($3,$4,$5,'Publish plan race Python.',$6)`,
    [PLAN_FOUNDATIONS_COURSE, PLAN_FOUNDATIONS_VERSION, PLAN_PYTHON_COURSE, PLAN_PYTHON_VERSION, ADMIN, NOW],
  );
  await pool.query(
    `insert into learner_profile (user_id,self_reported_level,selected_tracks)
     values ($1,'beginner','["python"]'::jsonb)`,
    [LEARNER_A],
  );
}
async function waitForReminderLockWait(
  observer: PoolClient,
  scheduler: ReminderBackendIdentity,
  blocker: ReminderBackendIdentity,
  expectedQuery: ReminderLockQuery,
) {
  const queryFragments = REMINDER_LOCK_QUERY_FRAGMENTS[expectedQuery];
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const blocked = await observer.query<{ pid: number }>(`
      select activity.pid
        from pg_stat_activity activity
       where activity.pid=$1
         and activity.backend_type='client backend'
         and activity.datname=$2
         and activity.usename=$3
         and activity.application_name=$4
         and activity.state='active'
         and activity.wait_event_type='Lock'
         and activity.query ilike $5
         and activity.query ilike $6
         and activity.query ilike $7
         and $8::integer = any(pg_blocking_pids(activity.pid))
    `, [
      scheduler.pid,
      scheduler.databaseName,
      scheduler.sessionUser,
      scheduler.applicationName,
      ...queryFragments,
      blocker.pid,
    ]);
    if (blocked.rows[0]?.pid === scheduler.pid) return scheduler.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const diagnostics = await observer.query<{
    pid: number;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    blockers: number[];
    application_name: string;
    query: string | null;
  }>(`
    select activity.pid,activity.state,activity.wait_event_type,activity.wait_event,
           pg_blocking_pids(activity.pid) blockers,
           activity.application_name,left(activity.query,300) query
      from pg_stat_activity activity
     where activity.pid=$1
  `, [scheduler.pid]);
  throw new Error(
    `Scheduler backend ${scheduler.pid} did not reach its ${expectedQuery} lock behind backend ${blocker.pid}: ${JSON.stringify(diagnostics.rows)}`,
  );
}

async function runRestrictedPreferenceRace(runAt: Date, mutationSql: string) {
  const [writerClient, schedulerClient, observerClient] = await Promise.all([
    reminderAppPool.connect(),
    reminderAppPool.connect(),
    reminderAppPool.connect(),
  ]);
  const sequence = ++reminderRaceSequence;
  let scheduled: ReturnType<typeof scheduleSmartRemindersWithDatabase> | null = null;
  try {
    const writerIdentity = await identifyReminderBackend(
      writerClient,
      `codestead.reminder.preference-writer.${sequence}`,
    );
    const schedulerIdentity = await identifyReminderBackend(
      schedulerClient,
      `codestead.reminder.preference-scheduler.${sequence}`,
    );
    await identifyReminderBackend(
      observerClient,
      `codestead.reminder.preference-observer.${sequence}`,
    );
    const schedulerDatabase = drizzle(schedulerClient, { schema });

    await writerClient.query("begin");
    await writerClient.query(
      "select 1 from notification_preference where user_id=$1 for update",
      [LEARNER_A],
    );
    scheduled = scheduleSmartRemindersWithDatabase(schedulerDatabase, runAt);
    await waitForReminderLockWait(
      observerClient,
      schedulerIdentity,
      writerIdentity,
      "preference",
    );
    await writerClient.query(mutationSql, [LEARNER_A]);
    await writerClient.query("commit");
    return await scheduled;
  } finally {
    await writerClient.query("rollback").catch(() => undefined);
    if (scheduled) await scheduled.catch(() => undefined);
    writerClient.release();
    schedulerClient.release();
    observerClient.release();
  }
}

type ExactBlockedQueryFragments = readonly [string, string, string];

type MeaningfulWriterRaceResult = Readonly<{
  writerPid: number;
  schedulerPid: number;
  outcome:
    | Readonly<{ kind: "blocked"; pid: number; blockerPid: number }>
    | Readonly<{ kind: "completed" }>;
  schedule: Awaited<ReturnType<typeof scheduleSmartRemindersWithDatabase>>;
  counts: Readonly<{
    dispatches: string;
    notifications: string;
    outbox: string;
  }>;
}>;

function createRestrictedRacePool(applicationName: string) {
  return new Pool({
    connectionString: reminderAppDatabaseUrl,
    application_name: applicationName,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

async function identifySinglePoolBackend(
  databasePool: Pool,
  applicationName: string,
) {
  const client = await databasePool.connect();
  try {
    return await identifyReminderBackend(client, applicationName);
  } finally {
    client.release();
  }
}

async function waitForExactBlockedQuery(
  observer: PoolClient,
  waiting: ReminderBackendIdentity,
  blocker: ReminderBackendIdentity,
  fragments: ExactBlockedQueryFragments,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const blocked = await observer.query<{ pid: number }>(`
      select activity.pid
        from pg_stat_activity activity
       where activity.pid=$1
         and activity.backend_type='client backend'
         and activity.datname=$2
         and activity.usename=$3
         and activity.application_name=$4
         and activity.state='active'
         and activity.wait_event_type='Lock'
         and activity.query ilike $5
         and activity.query ilike $6
         and activity.query ilike $7
         and $8::integer = any(pg_blocking_pids(activity.pid))
    `, [
      waiting.pid,
      waiting.databaseName,
      waiting.sessionUser,
      waiting.applicationName,
      ...fragments,
      blocker.pid,
    ]);
    if (blocked.rows[0]?.pid === waiting.pid) return waiting.pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const diagnostics = await observer.query<{
    pid: number;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    blockers: number[];
    application_name: string;
    query: string | null;
  }>(`
    select activity.pid,activity.state,activity.wait_event_type,activity.wait_event,
           pg_blocking_pids(activity.pid) blockers,
           activity.application_name,left(activity.query,300) query
      from pg_stat_activity activity
     where activity.pid=$1
  `, [waiting.pid]);
  throw new Error(
    `Backend ${waiting.pid} did not reach its exact source lock behind backend ${blocker.pid}: ${JSON.stringify(diagnostics.rows)}`,
  );
}

async function observeSchedulerUserLock(
  observer: PoolClient,
  scheduler: ReminderBackendIdentity,
  writer: ReminderBackendIdentity,
  isSchedulerSettled: () => boolean,
) {
  const fragments = REMINDER_LOCK_QUERY_FRAGMENTS.user;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const blocked = await observer.query<{ pid: number }>(`
      select activity.pid
        from pg_stat_activity activity
       where activity.pid=$1
         and activity.backend_type='client backend'
         and activity.datname=$2
         and activity.usename=$3
         and activity.application_name=$4
         and activity.state='active'
         and activity.wait_event_type='Lock'
         and activity.query ilike $5
         and activity.query ilike $6
         and activity.query ilike $7
         and $8::integer = any(pg_blocking_pids(activity.pid))
    `, [
      scheduler.pid,
      scheduler.databaseName,
      scheduler.sessionUser,
      scheduler.applicationName,
      ...fragments,
      writer.pid,
    ]);
    if (blocked.rows[0]?.pid === scheduler.pid) {
      return { kind: "blocked" as const, pid: scheduler.pid, blockerPid: writer.pid };
    }
    if (isSchedulerSettled()) return { kind: "completed" as const };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Scheduler backend ${scheduler.pid} neither blocked behind writer ${writer.pid} nor completed.`,
  );
}

async function runRestrictedMeaningfulWriterRace(input: Readonly<{
  label: string;
  runAt: Date;
  sourceLockSql: string;
  sourceLockValues: readonly unknown[];
  writerQueryFragments: ExactBlockedQueryFragments;
  runWriter: (writerPool: Pool) => Promise<unknown>;
}>): Promise<MeaningfulWriterRaceResult> {
  const sequence = ++reminderRaceSequence;
  const sourcePool = createRestrictedRacePool(
    `codestead.reminder.${input.label}-source.${sequence}`,
  );
  const writerPool = createRestrictedRacePool(
    `codestead.reminder.${input.label}-writer.${sequence}`,
  );
  const schedulerPool = createRestrictedRacePool(
    `codestead.reminder.${input.label}-scheduler.${sequence}`,
  );
  const observerPool = createRestrictedRacePool(
    `codestead.reminder.${input.label}-observer.${sequence}`,
  );
  const sourceClient = await sourcePool.connect();
  const observerClient = await observerPool.connect();
  let sourceOpen = false;
  let writer: Promise<unknown> | null = null;
  let scheduled: ReturnType<typeof scheduleSmartRemindersWithDatabase> | null = null;
  try {
    const sourceIdentity = await identifyReminderBackend(
      sourceClient,
      `codestead.reminder.${input.label}-source.${sequence}`,
    );
    const writerIdentity = await identifySinglePoolBackend(
      writerPool,
      `codestead.reminder.${input.label}-writer.${sequence}`,
    );
    const schedulerIdentity = await identifySinglePoolBackend(
      schedulerPool,
      `codestead.reminder.${input.label}-scheduler.${sequence}`,
    );
    await identifyReminderBackend(
      observerClient,
      `codestead.reminder.${input.label}-observer.${sequence}`,
    );

    await sourceClient.query("begin");
    sourceOpen = true;
    await sourceClient.query(input.sourceLockSql, [...input.sourceLockValues]);
    writer = input.runWriter(writerPool);
    const blockedWriterPid = await waitForExactBlockedQuery(
      observerClient,
      writerIdentity,
      sourceIdentity,
      input.writerQueryFragments,
    );
    expect(blockedWriterPid).toBe(writerIdentity.pid);

    let schedulerSettled = false;
    scheduled = scheduleSmartRemindersWithDatabase(
      drizzle(schedulerPool, { schema }),
      input.runAt,
      1,
    );
    void scheduled.then(
      () => { schedulerSettled = true; },
      () => { schedulerSettled = true; },
    );
    const outcome = await observeSchedulerUserLock(
      observerClient,
      schedulerIdentity,
      writerIdentity,
      () => schedulerSettled,
    );

    await sourceClient.query("commit");
    sourceOpen = false;
    await writer;
    const schedule = await scheduled;
    const counts = await pool.query<{
      dispatches: string;
      notifications: string;
      outbox: string;
    }>(
      `select
         (select count(*)::text from smart_reminder_dispatch where user_id=$1) dispatches,
         (select count(*)::text from notification
           where user_id=$1 and type='smart_reminder.daily_study') notifications,
         (select count(*)::text from email_outbox where user_id=$1) outbox`,
      [LEARNER_A],
    );
    return {
      writerPid: writerIdentity.pid,
      schedulerPid: schedulerIdentity.pid,
      outcome,
      schedule,
      counts: counts.rows[0]!,
    };
  } finally {
    if (sourceOpen) await sourceClient.query("rollback").catch(() => undefined);
    if (writer) await writer.catch(() => undefined);
    if (scheduled) await scheduled.catch(() => undefined);
    sourceClient.release();
    observerClient.release();
    await Promise.all([
      sourcePool.end(),
      writerPool.end(),
      schedulerPool.end(),
      observerPool.end(),
    ]);
  }
}

beforeEach(async () => {
  communityOperationSequence = 0;
  reminderRaceSequence = 0;
  await truncateApplicationTables();
  await seedPeopleAndReviewedActivity();
});

afterAll(async () => {
  await reminderAppPool.end();
  await pool.end();
});

describe("user-authority resurrection races", () => {
  it("replays an exact battle create after an invitee loses mutable authority", async () => {
    const created = await createInviteBattle();
    await pool.query(
      `update "user" set status='suspended',row_version=row_version+1,updated_at=$2
        where id=$1`,
      [LEARNER_B, NOW],
    );
    await pool.query(
      "update cohort_profile set is_published=false where user_id=$1",
      [LEARNER_B],
    );

    await expect(createInviteBattle()).resolves.toEqual({
      id: created.id,
      replayed: true,
    });
    expect((await pool.query(
      "select 1 from coding_battle where creator_user_id=$1 and create_request_id=$2",
      [LEARNER_A, "cb400000-0000-4000-8000-000000000001"],
    )).rowCount).toBe(1);
  });

  it("recovers exact replay when an invitee identity disappears before candidate resolution", async () => {
    const firstPool = createRestrictedAppPool();
    const retryPool = createRestrictedAppPool();
    const firstClient = await firstPool.connect();
    const retryClient = await retryPool.connect();
    const inviteeDeleter = await reminderAppPool.connect();
    let firstCreate: ReturnType<typeof createInviteBattle> | null = null;
    let retry: ReturnType<typeof createInviteBattle> | null = null;
    const firstPause = pauseClientQuery(
      firstClient,
      (query) => query.trim().toLowerCase() === "commit",
      "before",
    );
    const retryPause = pauseClientQuery(
      retryClient,
      (query) => query.includes("select 1 from coding_battle"),
      "after",
    );
    try {
      await identifyReminderBackend(
        firstClient,
        "codestead.battle.create-missing-first",
      );
      await identifyReminderBackend(
        retryClient,
        "codestead.battle.create-missing-retry",
      );
      await identifyReminderBackend(
        inviteeDeleter,
        "codestead.battle.create-missing-invitee-deleter",
      );
      const firstDatabasePool = {
        connect: async () => firstClient,
      } as Pick<typeof pool, "connect">;
      const retryDatabasePool = {
        connect: async () => retryClient,
      } as Pick<typeof pool, "connect">;

      firstCreate = createInviteBattle(firstDatabasePool);
      await firstPause.reached;
      retry = createInviteBattle(retryDatabasePool);
      await retryPause.reached;

      firstPause.resume();
      const created = await firstCreate;
      await inviteeDeleter.query("begin");
      await inviteeDeleter.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [userAuthorityLockKey(LEARNER_B)],
      );
      await inviteeDeleter.query(
        `select id from "user" where id=$1 for update`,
        [LEARNER_B],
      );
      await inviteeDeleter.query(
        "select set_config('app.account_deletion_authorized','1',true)",
      );
      await inviteeDeleter.query(
        `update "user" set status='deleted',public_id=$2,
          row_version=row_version+1,updated_at=$3 where id=$1`,
        [LEARNER_B, "cb000000-0000-4000-8000-000000000099", NOW],
      );
      await inviteeDeleter.query("commit");

      retryPause.resume();
      await expect(retry).resolves.toEqual({
        id: created.id,
        replayed: true,
      });
    } finally {
      firstPause.resume();
      retryPause.resume();
      await inviteeDeleter.query("rollback").catch(() => undefined);
      if (firstCreate) await firstCreate.catch(() => undefined);
      else firstClient.release();
      if (retry) await retry.catch(() => undefined);
      else retryClient.release();
      inviteeDeleter.release();
      await firstPool.end();
      await retryPool.end();
    }
    expect((await pool.query(
      "select 1 from coding_battle where creator_user_id=$1 and create_request_id=$2",
      [LEARNER_A, "cb400000-0000-4000-8000-000000000001"],
    )).rowCount).toBe(1);
  });

  it("rechecks replay after an uncommitted exact create before revalidating invitees", async () => {
    const firstPool = createRestrictedAppPool();
    const retryPool = createRestrictedAppPool();
    const [sourceBlocker, observer, inviteeMutator] = await Promise.all([
      reminderAppPool.connect(),
      reminderAppPool.connect(),
      reminderAppPool.connect(),
    ]);
    let firstCreate: ReturnType<typeof createInviteBattle> | null = null;
    let retry: ReturnType<typeof createInviteBattle> | null = null;
    let inviteeAuthorityLock: Promise<unknown> | null = null;
    try {
      const blockerIdentity = await identifyReminderBackend(
        sourceBlocker,
        "codestead.battle.create-source-blocker",
      );
      await identifyReminderBackend(
        observer,
        "codestead.battle.create-replay-observer",
      );
      const mutatorIdentity = await identifyReminderBackend(
        inviteeMutator,
        "codestead.battle.create-invitee-mutator",
      );
      const firstIdentity = await identifyRestrictedPoolBackend(
        firstPool,
        "codestead.battle.create-first",
      );
      const retryIdentity = await identifyRestrictedPoolBackend(
        retryPool,
        "codestead.battle.create-retry",
      );

      await sourceBlocker.query("begin");
      await sourceBlocker.query(
        "lock table curriculum_artifact in access exclusive mode",
      );
      firstCreate = createInviteBattle(firstPool);
      await waitForExactBackendLock(
        observer,
        firstIdentity,
        blockerIdentity,
        ["join curriculum_artifact artifact"],
      );

      retry = createInviteBattle(retryPool);
      await waitForExactBackendLock(
        observer,
        retryIdentity,
        firstIdentity,
        ["pg_advisory_xact_lock", "hashtext"],
      );

      await inviteeMutator.query("begin");
      inviteeAuthorityLock = inviteeMutator.query(
        "select pg_advisory_xact_lock(hashtext($1))",
        [userAuthorityLockKey(LEARNER_B)],
      );
      await waitForExactBackendLock(
        observer,
        mutatorIdentity,
        firstIdentity,
        ["pg_advisory_xact_lock", "hashtext"],
      );

      await sourceBlocker.query("commit");
      const created = await firstCreate;
      await inviteeAuthorityLock;
      await inviteeMutator.query(
        `select id from "user" where id=$1 for update`,
        [LEARNER_B],
      );
      await inviteeMutator.query(
        `update "user" set status='suspended',row_version=row_version+1,updated_at=$2
          where id=$1`,
        [LEARNER_B, NOW],
      );
      await waitForExactBackendLock(
        observer,
        retryIdentity,
        mutatorIdentity,
        ["pg_advisory_xact_lock", "hashtext"],
      );
      await inviteeMutator.query("commit");
      await expect(retry).resolves.toEqual({
        id: created.id,
        replayed: true,
      });
    } finally {
      await sourceBlocker.query("rollback").catch(() => undefined);
      await inviteeMutator.query("rollback").catch(() => undefined);
      if (firstCreate) await firstCreate.catch(() => undefined);
      if (retry) await retry.catch(() => undefined);
      if (inviteeAuthorityLock) {
        await inviteeAuthorityLock.catch(() => undefined);
      }
      sourceBlocker.release();
      observer.release();
      inviteeMutator.release();
      await firstPool.end();
      await retryPool.end();
    }
    expect((await pool.query(
      "select 1 from coding_battle where creator_user_id=$1 and create_request_id=$2",
      [LEARNER_A, "cb400000-0000-4000-8000-000000000001"],
    )).rowCount).toBe(1);
  });

  it("lets blocked plan initialization finish before deletion, then leaves no resurrected plan rows", async () => {
    await seedPlanInitializationPublications();
    const planPool = createRestrictedAppPool();
    const erasurePool = createRestrictedAppPool();
    const [publicationBlocker, observer, userWaiter] = await Promise.all([
      reminderAppPool.connect(),
      reminderAppPool.connect(),
      reminderAppPool.connect(),
    ]);
    let initialization: ReturnType<LearningService["initializePlans"]> | null = null;
    let erasure: ReturnType<typeof eraseLearnerAuthorityScope> | null = null;
    let userWait: Promise<unknown> | null = null;
    try {
      const blockerIdentity = await identifyReminderBackend(
        publicationBlocker,
        "codestead.plan.publication-blocker",
      );
      await identifyReminderBackend(observer, "codestead.plan.race-observer");
      const userWaiterIdentity = await identifyReminderBackend(
        userWaiter,
        "codestead.plan.user-row-waiter",
      );
      const initializerIdentity = await identifyRestrictedPoolBackend(
        planPool,
        "codestead.plan.initializer",
      );
      const erasureIdentity = await identifyRestrictedPoolBackend(
        erasurePool,
        "codestead.plan.eraser",
      );
      await publicationBlocker.query("begin");
      await publicationBlocker.query(
        "lock table curriculum_publication_pointer in access exclusive mode",
      );
      const service = new LearningService({
        store: new DrizzleLearningStore(drizzle(planPool, { schema })),
      });
      initialization = service.initializePlans(LEARNER_A, "plan-race-writer-first");
      await waitForExactBackendLock(
        observer,
        initializerIdentity,
        blockerIdentity,
        ["curriculum_publication_pointer", "course_version"],
      );
      userWait = userWaiter.query(
        `select u.id from "user" u where u.id=$1 for update of u`,
        [LEARNER_A],
      );
      await waitForExactBackendLock(
        observer,
        userWaiterIdentity,
        initializerIdentity,
        ['from "user" u', "for update of u"],
      );
      erasure = eraseLearnerAuthorityScope(erasurePool, LEARNER_A);
      await waitForExactBackendLock(
        observer,
        erasureIdentity,
        initializerIdentity,
        ["pg_advisory_xact_lock", "hashtext"],
      );
      await publicationBlocker.query("commit");
      await expect(initialization).resolves.toMatchObject({ state: "ready" });
      await expect(userWait).resolves.toBeDefined();
      await expect(erasure).resolves.toBeUndefined();
    } finally {
      await publicationBlocker.query("rollback").catch(() => undefined);
      if (initialization) await initialization.catch(() => undefined);
      if (userWait) await userWait.catch(() => undefined);
      if (erasure) await erasure.catch(() => undefined);
      publicationBlocker.release();
      observer.release();
      userWaiter.release();
      await planPool.end();
      await erasurePool.end();
    }
    const remaining = await pool.query<{ enrollments: string; revisions: string }>(
      `select
         (select count(*)::text from enrollment where user_id=$1) enrollments,
         (select count(*)::text from plan_revision revision
           join enrollment owned on owned.id=revision.enrollment_id
          where owned.user_id=$1) revisions`,
      [LEARNER_A],
    );
    expect(remaining.rows[0]).toEqual({ enrollments: "0", revisions: "0" });
  });

  it("lets a blocked battle join finish before deletion, then leaves no resurrected participant", async () => {
    const battle = await createInviteBattle();
    const joinPool = createRestrictedAppPool();
    const erasurePool = createRestrictedAppPool();
    const [battleBlocker, observer, userWaiter] = await Promise.all([
      reminderAppPool.connect(),
      reminderAppPool.connect(),
      reminderAppPool.connect(),
    ]);
    let joining: ReturnType<typeof joinBattle> | null = null;
    let erasure: ReturnType<typeof eraseLearnerAuthorityScope> | null = null;
    let userWait: Promise<unknown> | null = null;
    try {
      const blockerIdentity = await identifyReminderBackend(
        battleBlocker,
        "codestead.battle.row-blocker",
      );
      await identifyReminderBackend(observer, "codestead.battle.race-observer");
      const userWaiterIdentity = await identifyReminderBackend(
        userWaiter,
        "codestead.battle.user-row-waiter",
      );
      const joinIdentity = await identifyRestrictedPoolBackend(
        joinPool,
        "codestead.battle.joiner",
      );
      const erasureIdentity = await identifyRestrictedPoolBackend(
        erasurePool,
        "codestead.battle.eraser",
      );
      await battleBlocker.query("begin");
      await battleBlocker.query(
        "select id from coding_battle where id=$1 for update",
        [battle.id],
      );
      joining = joinBattle({ actorUserId: LEARNER_B, battleId: battle.id, now: NOW }, joinPool);
      await waitForExactBackendLock(
        observer,
        joinIdentity,
        blockerIdentity,
        ["from coding_battle battle", "for update of battle"],
      );
      userWait = userWaiter.query(
        `select u.id from "user" u where u.id=$1 for update of u`,
        [LEARNER_B],
      );
      await waitForExactBackendLock(
        observer,
        userWaiterIdentity,
        joinIdentity,
        ['from "user" u', "for update of u"],
      );
      erasure = eraseLearnerAuthorityScope(erasurePool, LEARNER_B);
      await waitForExactBackendLock(
        observer,
        erasureIdentity,
        joinIdentity,
        ["pg_advisory_xact_lock", "hashtext"],
      );
      await battleBlocker.query("commit");
      await expect(joining).resolves.toEqual({ joined: true });
      await expect(userWait).resolves.toBeDefined();
      await expect(erasure).resolves.toBeUndefined();
    } finally {
      await battleBlocker.query("rollback").catch(() => undefined);
      if (joining) await joining.catch(() => undefined);
      if (userWait) await userWait.catch(() => undefined);
      if (erasure) await erasure.catch(() => undefined);
      battleBlocker.release();
      observer.release();
      userWaiter.release();
      await joinPool.end();
      await erasurePool.end();
    }
    expect((await pool.query(
      "select 1 from coding_battle_participant where battle_id=$1 and user_id=$2",
      [battle.id, LEARNER_B],
    )).rowCount).toBe(0);
  });

  it("makes plan initialization wait behind deletion and reject the deleted learner", async () => {
    await seedPlanInitializationPublications();
    const planPool = createRestrictedAppPool();
    const erasurePool = createRestrictedAppPool();
    const eraser = await erasurePool.connect();
    const observer = await reminderAppPool.connect();
    let initialization: ReturnType<LearningService["initializePlans"]> | null = null;
    try {
      const eraserIdentity = await identifyReminderBackend(
        eraser,
        "codestead.plan.deletion-first-eraser",
      );
      await identifyReminderBackend(observer, "codestead.plan.deletion-first-observer");
      const initializerIdentity = await identifyRestrictedPoolBackend(
        planPool,
        "codestead.plan.deletion-first-initializer",
      );
      await beginLearnerAuthorityErasure(eraser, LEARNER_A);
      const service = new LearningService({
        store: new DrizzleLearningStore(drizzle(planPool, { schema })),
      });
      initialization = service.initializePlans(LEARNER_A, "plan-race-deletion-first");
      await waitForExactBackendLock(
        observer,
        initializerIdentity,
        eraserIdentity,
        ["pg_advisory_xact_lock", "hashtext"],
      );
      await finishLearnerAuthorityErasure(eraser, LEARNER_A);
      await expect(initialization).resolves.toMatchObject({
        state: "empty",
        warnings: ["Learner account is unavailable."],
      });
    } finally {
      await eraser.query("rollback").catch(() => undefined);
      if (initialization) await initialization.catch(() => undefined);
      eraser.release();
      observer.release();
      await planPool.end();
      await erasurePool.end();
    }
    expect((await pool.query("select 1 from enrollment where user_id=$1", [LEARNER_A])).rowCount).toBe(0);
  });

  it("makes battle join wait behind deletion and reject without reinserting participation", async () => {
    const battle = await createInviteBattle();
    const joinPool = createRestrictedAppPool();
    const erasurePool = createRestrictedAppPool();
    const eraser = await erasurePool.connect();
    const observer = await reminderAppPool.connect();
    let joining: ReturnType<typeof joinBattle> | null = null;
    try {
      const eraserIdentity = await identifyReminderBackend(
        eraser,
        "codestead.battle.deletion-first-eraser",
      );
      await identifyReminderBackend(observer, "codestead.battle.deletion-first-observer");
      const joinIdentity = await identifyRestrictedPoolBackend(
        joinPool,
        "codestead.battle.deletion-first-joiner",
      );
      await beginLearnerAuthorityErasure(eraser, LEARNER_B);
      joining = joinBattle({ actorUserId: LEARNER_B, battleId: battle.id, now: NOW }, joinPool);
      await waitForExactBackendLock(
        observer,
        joinIdentity,
        eraserIdentity,
        ["pg_advisory_xact_lock", "hashtext"],
      );
      await finishLearnerAuthorityErasure(eraser, LEARNER_B);
      await expect(joining).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await eraser.query("rollback").catch(() => undefined);
      if (joining) await joining.catch(() => undefined);
      eraser.release();
      observer.release();
      await joinPool.end();
      await erasurePool.end();
    }
    expect((await pool.query(
      "select 1 from coding_battle_participant where battle_id=$1 and user_id=$2",
      [battle.id, LEARNER_B],
    )).rowCount).toBe(0);
  });
});

describe("closed-cohort community", () => {
  it("fails closed across membership, ownership, reports, pagination, and secret-like content", async () => {
    const groupRequestId = nextCommunityRequestId();
    const group = await createCommunityGroup({
      actorUserId: LEARNER_A,
      requestId: groupRequestId,
      name: "Python study pod",
      description: "A private place for reviewed Python questions.",
      visibility: "members",
    });
    expect(await createCommunityGroup({
      actorUserId: LEARNER_A,
      requestId: groupRequestId,
      name: "Python study pod",
      description: "A private place for reviewed Python questions.",
      visibility: "members",
    })).toEqual({ id: group.id, replayed: true });
    await expect(createCommunityGroup({
      actorUserId: LEARNER_A,
      requestId: groupRequestId,
      name: "A different group",
      description: "A changed input must not reuse a committed request identifier.",
      visibility: "members",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await addCommunityGroupMember({ actorUserId: LEARNER_A, requestId: nextCommunityRequestId(), groupId: group.id, learnerPublicId: PUBLIC_B });

    const first = await createCommunityPost({
      actorUserId: LEARNER_A,
      requestId: nextCommunityRequestId(),
      groupId: group.id,
      kind: "help",
      title: "Why does assignment point left?",
      body: "Please explain\u0001 why score = 7 stores a value.",
    });
    await createCommunityReply({ actorUserId: LEARNER_B, requestId: nextCommunityRequestId(), postId: first.id, body: "Think of the name as a labelled box." });
    await expect(createCommunityPost({
      actorUserId: LEARNER_A,
      requestId: nextCommunityRequestId(),
      groupId: group.id,
      kind: "discussion",
      title: "Do not leak this",
      body: `This accidental credential must fail: nvapi-${"A".repeat(30)}`,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(createCommunityPost({
      actorUserId: LEARNER_A,
      requestId: nextCommunityRequestId(),
      groupId: group.id,
      kind: "discussion",
      title: "Reject another provider credential",
      body: `This synthetic value must fail: ${["21st", "sk", "B".repeat(32)].join("_")}`,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(createCommunityPost({
      actorUserId: LEARNER_A,
      requestId: nextCommunityRequestId(),
      groupId: group.id,
      kind: "discussion",
      title: "Reject a labelled credential",
      body: `This labelled value must fail: ${["access password", "=", "mnbvcxzlkjhgfdsq"].join(" ")}`,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const ordinarySecurityProse = await createCommunityPost({
      actorUserId: LEARNER_A,
      requestId: nextCommunityRequestId(),
      groupId: group.id,
      kind: "discussion",
      title: "Ordinary security vocabulary",
      body: "Token: short-name is ordinary prose, not credential material.",
    });
    expect(ordinarySecurityProse.rowVersion).toBe(1);
    await expect(createCommunityPost({
      actorUserId: LEARNER_C,
      requestId: nextCommunityRequestId(),
      groupId: group.id,
      kind: "help",
      title: "Unauthorized",
      body: "This learner is not in the private study group.",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listCommunity({ actorUserId: LEARNER_C })).groups).toEqual([]);

    const visible = await listCommunity({ actorUserId: LEARNER_B, groupId: group.id });
    const visibleFirstPost = visible.posts.find((post) => post.id === first.id);
    expect(visibleFirstPost).toMatchObject({
      id: first.id,
      authorAlias: "learner-alpha",
      body: "Please explain why score = 7 stores a value.",
    });
    expect(visibleFirstPost?.replies[0]).toMatchObject({ authorAlias: "You" });
    await expect(editCommunityContent({
      actorUserId: LEARNER_B,
      target: "post",
      targetId: first.id,
      expectedVersion: 1,
      title: "Cross-owner edit",
      body: "A different learner must not edit this post.",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const report = await reportCommunityContent({
      actorUserId: LEARNER_B,
      target: "post",
      targetId: first.id,
      reason: "other",
      details: "Please review the wording in this post.",
    });
    expect(report.replayed).toBe(false);
    expect((await reportCommunityContent({
      actorUserId: LEARNER_B,
      target: "post",
      targetId: first.id,
      reason: "other",
      details: "Please review the wording in this post.",
    })).replayed).toBe(true);
    expect(await listCommunityReports(ADMIN)).toHaveLength(1);
    const moderationRequestId = nextCommunityRequestId();
    const moderation = await moderateCommunityContent({
      actorUserId: ADMIN,
      requestId: moderationRequestId,
      reportId: report.id,
      target: "post",
      targetId: first.id,
      action: "hide",
      reason: "Hidden after administrator review of the report.",
    });
    expect(moderation).toMatchObject({ priorState: "active", resultingState: "hidden", replayed: false });
    expect(await moderateCommunityContent({
      actorUserId: ADMIN,
      requestId: moderationRequestId,
      reportId: report.id,
      target: "post",
      targetId: first.id,
      action: "hide",
      reason: "Hidden after administrator review of the report.",
    })).toMatchObject({ priorState: "active", resultingState: "hidden", replayed: true });
    await expect(moderateCommunityContent({
      actorUserId: ADMIN,
      requestId: moderationRequestId,
      reportId: report.id,
      target: "post",
      targetId: first.id,
      action: "restore",
      reason: "A changed retry must conflict with the original moderation decision.",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await pool.query(
      "select 1 from community_moderation_event where post_id=$1 and action='hide'",
      [first.id],
    )).rowCount).toBe(1);
    const learnerAfterModeration = await listCommunity({ actorUserId: LEARNER_B, groupId: group.id });
    expect(learnerAfterModeration.posts.some((post) => post.id === first.id)).toBe(false);
    expect(learnerAfterModeration.posts.some((post) => post.id === ordinarySecurityProse.id)).toBe(true);
    const adminAfterModeration = await listCommunity({ actorUserId: ADMIN, groupId: group.id });
    expect(adminAfterModeration.posts.find((post) => post.id === first.id)).toMatchObject({ state: "hidden" });
    await expect(pool.query(
      `update community_moderation_event set reason='Attempted moderation history rewrite.' where post_id=$1`,
      [first.id],
    )).rejects.toMatchObject({ code: "55000" });
    await moderateCommunityContent({
      actorUserId: ADMIN,
      requestId: nextCommunityRequestId(),
      target: "post",
      targetId: first.id,
      action: "restore",
      reason: "Restored after the administrator completed review.",
    });

    const withdrawn = await createCommunityPost({
      actorUserId: LEARNER_A,
      requestId: nextCommunityRequestId(),
      groupId: group.id,
      kind: "discussion",
      title: "Content the author will withdraw",
      body: "This original body must never be recoverable through moderation.",
    });
    const withdrawalReport = await reportCommunityContent({
      actorUserId: LEARNER_B,
      target: "post",
      targetId: withdrawn.id,
      reason: "privacy",
      details: "Review this content before the author withdraws it.",
    });
    await deleteCommunityContent({
      actorUserId: LEARNER_A,
      target: "post",
      targetId: withdrawn.id,
      expectedVersion: withdrawn.rowVersion,
    });
    await expect(moderateCommunityContent({
      actorUserId: ADMIN,
      requestId: nextCommunityRequestId(),
      reportId: withdrawalReport.id,
      target: "post",
      targetId: withdrawn.id,
      action: "restore",
      reason: "A moderation decision must not override author withdrawal.",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const withdrawnRow = await pool.query<{ title: string; body: string; state: string }>(
      "select title,body,state from community_post where id=$1",
      [withdrawn.id],
    );
    expect(withdrawnRow.rows[0]).toEqual({
      title: "[deleted by author]",
      body: "[deleted by author]",
      state: "deleted",
    });

    for (let index = 0; index < 4; index += 1) {
      await createCommunityPost({
        actorUserId: LEARNER_A,
        requestId: nextCommunityRequestId(),
        groupId: group.id,
        kind: "discussion",
        title: `Pagination post ${index}`,
        body: `This is enough plain-text content for pagination item ${index}.`,
      });
    }
    const pageOne = await listCommunity({ actorUserId: LEARNER_B, groupId: group.id, limit: 2 });
    const pageTwo = await listCommunity({ actorUserId: LEARNER_B, groupId: group.id, limit: 2, cursor: pageOne.nextCursor });
    expect(pageOne.nextCursor).not.toBeNull();
    expect(new Set([...pageOne.posts, ...pageTwo.posts].map((post) => post.id)).size).toBe(4);
  });
});

describe("asynchronous coding battles", () => {
  it("uses only the immutable reviewed item, hides results until reveal, and gives equal scores equal rank", async () => {
    const sources = await listBattles({ actorUserId: LEARNER_A, now: NOW });
    expect(sources.sources).toEqual([expect.objectContaining({
      activityId: ACTIVITY,
      title: "Choose a variable assignment",
      language: "Language-neutral",
    })]);

    const battle = await createInviteBattle();
    expect((await createInviteBattle())).toEqual({ id: battle.id, replayed: true });
    await expect(createBattle({
      actorUserId: LEARNER_A,
      requestId: "cb400000-0000-4000-8000-000000000001",
      activityId: ACTIVITY,
      scope: "invite",
      invitedPublicIds: [PUBLIC_B],
      startsAt: NOW,
      durationMinutes: 30,
      now: NOW,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(getBattle({ actorUserId: LEARNER_C, battleId: battle.id, now: NOW })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const detail = await getBattle({ actorUserId: LEARNER_B, battleId: battle.id, now: NOW });
    expect(detail.battle.prompt?.instructions).toBe("Which line stores the number 7 in score?");
    expect(JSON.stringify(detail)).not.toContain("correctOptionIds");
    expect(JSON.stringify(detail)).not.toContain("Forged prompt");

    const scheduled = await createBattle({
      actorUserId: LEARNER_A,
      requestId: "cb400000-0000-4000-8000-000000000006",
      activityId: ACTIVITY,
      scope: "invite",
      invitedPublicIds: [PUBLIC_B],
      startsAt: new Date(NOW.getTime() + 60 * 60_000),
      durationMinutes: 30,
      now: NOW,
    });
    const scheduledBeforeStart = await getBattle({ actorUserId: LEARNER_B, battleId: scheduled.id, now: NOW });
    expect(scheduledBeforeStart.battle).toMatchObject({ status: "scheduled", prompt: null });
    const scheduledAtStart = await getBattle({
      actorUserId: LEARNER_B,
      battleId: scheduled.id,
      now: new Date(NOW.getTime() + 60 * 60_000),
    });
    expect(scheduledAtStart.battle.prompt?.instructions).toBe("Which line stores the number 7 in score?");
    await submitBattle({
      actorUserId: LEARNER_A,
      battleId: battle.id,
      requestId: "cb400000-0000-4000-8000-000000000002",
      answer: { value: "a" },
      now: new Date(NOW.getTime() + 60_000),
    });
    await submitBattle({
      actorUserId: LEARNER_B,
      battleId: battle.id,
      requestId: "cb400000-0000-4000-8000-000000000003",
      answer: { value: "a" },
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(await getBattle({ actorUserId: LEARNER_A, battleId: battle.id, now: new Date(NOW.getTime() + 2 * 60_000) }))
      .toMatchObject({ resultsRevealed: false, results: [] });
    const revealed = await getBattle({
      actorUserId: LEARNER_A,
      battleId: battle.id,
      now: new Date(NOW.getTime() + 61 * 60_000),
    });
    expect(revealed.resultsRevealed).toBe(true);
    expect(revealed.results).toHaveLength(2);
    expect(revealed.results.map((result) => result.rank)).toEqual([1, 1]);
    expect(revealed.results.map((result) => result.score)).toEqual([100, 100]);

    await expect(pool.query(`update coding_battle set title='Tampered battle' where id=$1`, [battle.id]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(pool.query(`update coding_battle_submission set score=0 where battle_id=$1`, [battle.id]))
      .rejects.toMatchObject({ code: "55000" });

    await expect(createBattle({
      actorUserId: LEARNER_A,
      requestId: "cb400000-0000-4000-8000-000000000004",
      activityId: ACTIVITY,
      scope: "weekly",
      competitionKey: "2026-W29",
      now: NOW,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const weekly = await createBattle({
      actorUserId: ADMIN,
      requestId: "cb400000-0000-4000-8000-000000000005",
      activityId: ACTIVITY,
      scope: "weekly",
      competitionKey: "2026-W29",
      now: NOW,
    });
    const weeklyDetail = await getBattle({ actorUserId: LEARNER_C, battleId: weekly.id, now: NOW });
    expect(weeklyDetail.battle).toMatchObject({
      participantCount: 0,
      participant: false,
      canJoin: true,
      startsAt: "2026-07-13T00:00:00.000Z",
      endsAt: "2026-07-20T00:00:00.000Z",
      revealAt: "2026-07-20T01:00:00.000Z",
    });
    expect((await getBattle({ actorUserId: ADMIN, battleId: weekly.id, now: NOW })).battle.canJoin).toBe(false);

    // Public competitions must not become a shortcut around the learner's
    // current roadmap. Removing this learner's active plan hides both the
    // reviewed source and the still-unjoined weekly challenge.
    await pool.query(
      `delete from plan_revision
        where enrollment_id=(select id from enrollment where user_id=$1 and course_version_id=$2)`,
      [LEARNER_C, VERSION],
    );
    expect((await listBattles({ actorUserId: LEARNER_C, now: NOW })).sources).toEqual([]);
    await expect(getBattle({ actorUserId: LEARNER_C, battleId: weekly.id, now: NOW }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    // Published artifact content is itself immutable; the service also
    // verifies its digest before accepting it as a future battle source.
    await expect(pool.query(
      `update curriculum_artifact set content=jsonb_set(content,'{items,0,title}','"Tampered"'::jsonb) where id=$1`,
      [ARTIFACT],
    )).rejects.toThrow(/immutable/i);
  });
});

describe("community and battle lifecycle", () => {
  it("exports only the learner's bounded records and deletes without erasing a friend's reply", async () => {
    const group = await createCommunityGroup({
      actorUserId: LEARNER_A,
      requestId: nextCommunityRequestId(),
      name: "Lifecycle pod",
      description: "A private fixture for account deletion behavior.",
      visibility: "members",
    });
    await addCommunityGroupMember({ actorUserId: LEARNER_A, requestId: nextCommunityRequestId(), groupId: group.id, learnerPublicId: PUBLIC_B });
    const post = await createCommunityPost({
      actorUserId: LEARNER_A,
      requestId: nextCommunityRequestId(),
      groupId: group.id,
      kind: "discussion",
      title: "Learner-owned lifecycle post",
      body: "This learner-owned text must be scrubbed during deletion.",
    });
    const reply = await createCommunityReply({
      actorUserId: LEARNER_B,
      requestId: nextCommunityRequestId(),
      postId: post.id,
      body: "This other learner's reply must remain durable.",
    });
    const reportForDeletion = await reportCommunityContent({
      actorUserId: LEARNER_A,
      target: "reply",
      targetId: reply.id,
      reason: "privacy",
      details: "This resolved report belongs to the learner being deleted.",
    });
    await moderateCommunityContent({
      actorUserId: ADMIN,
      requestId: nextCommunityRequestId(),
      reportId: reportForDeletion.id,
      target: "reply",
      targetId: reply.id,
      action: "hide",
      reason: "Resolve the synthetic report while preserving moderation provenance.",
    });
    await pool.query(
      `insert into smart_reminder_dispatch
        (user_id,kind,local_period_key,timezone,evidence,scheduled_for,dispatched_at)
       values ($1,'daily_study','2026-07-14','Asia/Kolkata',$2::jsonb,$3,$3)`,
      [LEARNER_A, JSON.stringify({ policyVersion: "smart-reminders-2026-07.v1" }), NOW],
    );
    const battle = await createInviteBattle();
    await submitBattle({
      actorUserId: LEARNER_A,
      battleId: battle.id,
      requestId: "cb500000-0000-4000-8000-000000000001",
      answer: { value: "a" },
      now: new Date(NOW.getTime() + 60_000),
    });
    await submitBattle({
      actorUserId: LEARNER_B,
      battleId: battle.id,
      requestId: "cb500000-0000-4000-8000-000000000002",
      answer: { value: "a" },
      now: new Date(NOW.getTime() + 60_000),
    });

    const exported = await createLearnerExport({
      learnerId: LEARNER_A,
      actorUserId: ADMIN,
      requestId: "cb500000-0000-4000-8000-000000000003",
      now: NOW,
      maxRecords: 1_000,
      maxBytes: 2 * 1_024 * 1_024,
    });
    const records = (await new Response(exported.stream).text())
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string; category?: string; data?: Record<string, unknown> });
    await exported.completion;
    const categories = new Set(records.map((record) => record.category));
    for (const category of [
      "communityGroups",
      "communityOperationHistory",
      "communityPosts",
      "communityReports",
      "communityModerationHistory",
      "smartReminderDispatches",
      "codingBattles",
      "codingBattleSubmissions",
    ]) {
      expect(categories).toContain(category);
    }
    const sealedSubmission = records.find((record) => record.category === "codingBattleSubmissions")?.data;
    expect(sealedSubmission).toMatchObject({ score: null, passed: null, resultsSealed: true });
    expect(JSON.stringify(records)).not.toContain("community-b@integration.invalid");

    const previousKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.DELETION_TOMBSTONE_KEY = "community-battle-integration-deletion-key";
    try {
      const report = await deleteLearnerAccount({
        actorUserId: ADMIN,
        learnerId: LEARNER_A,
        requestId: "cb500000-0000-4000-8000-000000000004",
        reason: "Delete the synthetic community and battle lifecycle learner.",
        now: new Date(NOW.getTime() + 2 * 60_000),
      });
      expect(report.deletedRows).toMatchObject({
        codingBattleSubmissions: 1,
        codingBattleParticipants: 1,
        unlinkedCreatedCodingBattles: 1,
        communityOperationReceipts: 3,
        communityReports: 1,
        smartReminderDispatches: 1,
        scrubbedCommunityPosts: 1,
        communityGroupMemberships: 1,
        unlinkedCreatedCommunityGroups: 1,
      });
      const remaining = await pool.query<{
        post_body: string; post_state: string; reply_body: string;
        battle_creator: string | null; submissions: string; b_participants: string;
        group_creator: string | null; group_name: string; group_description: string; g_members: string;
      }>(
        `select post.body post_body,post.state post_state,reply.body reply_body,
                battle.creator_user_id battle_creator,
                (select count(*)::text from coding_battle_submission where battle_id=battle.id) submissions,
                (select count(*)::text from coding_battle_participant where battle_id=battle.id) b_participants,
                community_group.created_by_user_id group_creator,
                community_group.name group_name,community_group.description group_description,
                (select count(*)::text from community_group_member where group_id=community_group.id) g_members
           from community_post post
           join community_reply reply on reply.post_id=post.id and reply.id=$2
           join community_group on community_group.id=post.group_id
           join coding_battle battle on battle.id=$3
          where post.id=$1`,
        [post.id, reply.id, battle.id],
      );
      expect(remaining.rows[0]).toEqual({
        post_body: "[deleted by account owner]",
        post_state: "deleted",
        reply_body: "This other learner's reply must remain durable.",
        battle_creator: null,
        submissions: "1",
        b_participants: "1",
        group_creator: null,
        group_name: `Archived study group ${group.id}`,
        group_description: "This study group remains for existing members after its creator deleted their account.",
        g_members: "1",
      });
      expect((await pool.query("select 1 from community_report where id=$1", [reportForDeletion.id])).rowCount).toBe(0);
      expect((await pool.query<{ report_id: string | null }>(
        "select report_id from community_moderation_event where reply_id=$1",
        [reply.id],
      )).rows).toEqual([{ report_id: null }]);
      expect((await pool.query("select 1 from smart_reminder_dispatch where user_id=$1", [LEARNER_A])).rowCount).toBe(0);
    } finally {
      if (previousKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousKey;
    }
  });
});

describe("smart-reminder consent and concurrency", () => {
  it("moves past already-dispatched higher-priority kinds on the next scheduler run", async () => {
    const monday = new Date("2026-07-13T14:00:00.000Z");
    await createBattle({
      actorUserId: LEARNER_A,
      requestId: "cb600000-0000-4000-8000-000000000001",
      activityId: ACTIVITY,
      scope: "invite",
      invitedPublicIds: [PUBLIC_B],
      startsAt: new Date(monday.getTime() + 60 * 60_000),
      durationMinutes: 30,
      now: monday,
    });
    await pool.query(
      `insert into notification_preference
        (user_id,daily_study_enabled,goal_enabled,challenge_enabled,learning_email_enabled,
         timezone,daily_study_minute,quiet_hours_enabled,row_version)
       values ($1,true,true,true,false,'Asia/Kolkata',1080,false,1)`,
      [LEARNER_A],
    );

    expect(await scheduleSmartReminders(monday)).toEqual({ candidates: 1, dispatched: 2, failed: 0 });
    expect(await scheduleSmartReminders(monday)).toEqual({ candidates: 1, dispatched: 1, failed: 0 });
    const reminders = await pool.query<{ kind: string }>(
      "select kind from smart_reminder_dispatch where user_id=$1 order by dispatched_at,kind",
      [LEARNER_A],
    );
    expect(reminders.rows.map((row) => row.kind).sort()).toEqual(["challenge", "daily_study", "goal"]);
  });

  it("locks the user first despite an indistinguishable competing waiter and revalidates opt-out", async () => {
    const runAt = new Date("2026-07-14T14:00:00.000Z");
    await pool.query(
      `insert into notification_preference
        (user_id,daily_study_enabled,learning_email_enabled,timezone,daily_study_minute,
         quiet_hours_enabled,row_version)
       values ($1,true,true,'Asia/Kolkata',1080,false,1)`,
      [LEARNER_A],
    );

    const [writerClient, schedulerClient, observerClient, competingClient] = await Promise.all([
      reminderAppPool.connect(),
      reminderAppPool.connect(),
      reminderAppPool.connect(),
      reminderAppPool.connect(),
    ]);
    const sequence = ++reminderRaceSequence;
    const schedulerApplication = `codestead.reminder.user-scheduler.${sequence}`;
    let scheduled: ReturnType<typeof scheduleSmartRemindersWithDatabase> | null = null;
    let competingWaiter: Promise<unknown> | null = null;
    let blockedRelations: string[] = [];
    let result: Awaited<ReturnType<typeof scheduleSmartRemindersWithDatabase>> | null = null;
    try {
      const writerIdentity = await identifyReminderBackend(
        writerClient,
        `codestead.reminder.user-writer.${sequence}`,
      );
      const schedulerIdentity = await identifyReminderBackend(
        schedulerClient,
        schedulerApplication,
      );
      await identifyReminderBackend(
        observerClient,
        `codestead.reminder.user-observer.${sequence}`,
      );
      const competingIdentity = await identifyReminderBackend(
        competingClient,
        schedulerApplication,
      );
      const schedulerDatabase = drizzle(schedulerClient, { schema });

      await writerClient.query("begin");
      await writerClient.query(
        `select 1 from "user" where id=$1 for update`,
        [LEARNER_A],
      );
      scheduled = scheduleSmartRemindersWithDatabase(schedulerDatabase, runAt);
      const schedulerBlockers = await waitForBackendBlockers(
        observerClient,
        schedulerIdentity.pid,
      );
      expect(schedulerBlockers).toContain(writerIdentity.pid);

      await competingClient.query("begin");
      competingWaiter = competingClient.query(
        `select u.id from "user" u where u.id=$1 for update of u`,
        [LEARNER_A],
      );
      const competingBlockers = await waitForBackendBlockers(
        observerClient,
        competingIdentity.pid,
      );
      expect(competingBlockers).toContain(schedulerIdentity.pid);

      const schedulerPid = await waitForReminderLockWait(
        observerClient,
        schedulerIdentity,
        writerIdentity,
        "user",
      );
      expect(schedulerPid).toBe(schedulerIdentity.pid);
      expect(schedulerPid).not.toBe(competingIdentity.pid);
      const relationLocks = await observerClient.query<{ relation_name: string }>(
        `select relation.relname as relation_name
           from pg_locks held
           join pg_class relation on relation.oid = held.relation
          where held.pid = $1 and held.locktype = 'relation' and held.granted
          order by relation.relname`,
        [schedulerPid],
      );
      blockedRelations = relationLocks.rows.map((row) => row.relation_name);
      await writerClient.query(
        `update notification_preference
            set daily_study_enabled=false,learning_email_enabled=false,
                row_version=row_version+1
          where user_id=$1`,
        [LEARNER_A],
      );
      await writerClient.query("commit");
      result = await scheduled;
      await competingWaiter;
      await competingClient.query("rollback");
    } finally {
      await writerClient.query("rollback").catch(() => undefined);
      if (scheduled) await scheduled.catch(() => undefined);
      if (competingWaiter) await competingWaiter.catch(() => undefined);
      await competingClient.query("rollback").catch(() => undefined);
      writerClient.release();
      schedulerClient.release();
      observerClient.release();
      competingClient.release();
    }

    expect(blockedRelations).toContain("user");
    expect(blockedRelations).not.toContain("notification_preference");
    expect(result).toEqual({ candidates: 1, dispatched: 0, failed: 0 });
    expect((await pool.query("select 1 from smart_reminder_dispatch")).rowCount).toBe(0);
    expect((await pool.query(
      "select 1 from notification where type like 'smart_reminder.%'",
    )).rowCount).toBe(0);
    expect((await pool.query("select 1 from email_outbox where user_id=$1", [LEARNER_A])).rowCount).toBe(0);
  });

  it("serializes an authoritative lesson event on the user before its session write", async () => {
    const runAt = new Date("2026-07-14T14:00:00.000Z");
    const meaningfulAt = new Date("2026-07-14T13:59:00.000Z");
    await pool.query(
      `insert into lesson_concept (lesson_id,concept_id,coverage,weight)
       values ($1,$2,'primary',1)`,
      [LESSON, CONCEPT],
    );
    await pool.query(
      `insert into attempt
        (id,user_id,activity_id,enrollment_id,kind,status,policy_version,content_version,
         score,passed,mastery_awarded,infrastructure_failure,assistance_level,
         solution_revealed,started_at,submitted_at,graded_at)
       values ($1,$2,$3,$4,'quiz','graded','adaptive-learning-v1','1.0.0',
         1,true,true,false,'A0',false,$5,$5,$5)`,
      [MEANINGFUL_ATTEMPT, LEARNER_A, ACTIVITY, LEARNER_A_ENROLLMENT, meaningfulAt],
    );
    await pool.query(
      `insert into mastery_evidence
        (id,user_id,enrollment_id,concept_id,language_context,evidence_type,source_type,
         source_id,score,weight,validity,policy_version,recorded_by,recorded_at)
       values ($1,$2,$3,$4,'conceptual','assessment','deterministic_attempt',
         $5,1,1,'valid','adaptive-learning-v1','integration',$6)`,
      [
        MEANINGFUL_EVIDENCE,
        LEARNER_A,
        LEARNER_A_ENROLLMENT,
        CONCEPT,
        MEANINGFUL_ATTEMPT,
        meaningfulAt,
      ],
    );
    await pool.query(
      `insert into learning_session
        (id,user_id,enrollment_id,goal,planned_minutes,status,started_at,last_activity_at,row_version)
       values ($1,$2,$3,'Complete the reviewed variables lesson.',25,'active',$4,$4,1)`,
      [MEANINGFUL_SESSION, LEARNER_A, LEARNER_A_ENROLLMENT, NOW],
    );
    await pool.query(
      `insert into notification_preference
        (user_id,daily_study_enabled,learning_email_enabled,timezone,daily_study_minute,
         quiet_hours_enabled,row_version)
       values ($1,true,true,'Asia/Kolkata',1080,false,1)`,
      [LEARNER_A],
    );

    const race = await runRestrictedMeaningfulWriterRace({
      label: "session-event",
      runAt,
      sourceLockSql: "select id from learning_session where id=$1 for update",
      sourceLockValues: [MEANINGFUL_SESSION],
      writerQueryFragments: [
        "%update \"learning_session\"%",
        "%row_version%",
        "%returning%",
      ],
      runWriter: async (writerPool) => {
        const learning = new LearningService({
          store: new DrizzleLearningStore(drizzle(writerPool, { schema })),
          now: () => meaningfulAt,
        });
        await learning.recordSessionEvent({
          userId: LEARNER_A,
          sessionId: MEANINGFUL_SESSION,
          clientEventId: "meaningful-session-event-0001",
          expectedRowVersion: 1,
          type: "lesson_completed",
          subjectType: "lesson",
          subjectId: LESSON,
        });
      },
    });

    expect(race.outcome).toEqual({
      kind: "blocked",
      pid: race.schedulerPid,
      blockerPid: race.writerPid,
    });
    expect(race.schedule).toEqual({ candidates: 1, dispatched: 0, failed: 0 });
    expect(race.counts).toEqual({ dispatches: "0", notifications: "0", outbox: "0" });
    const committed = await pool.query<{
      last_meaningful_activity_at: Date;
      event_count: string;
      session_version: string;
    }>(
      `select u.last_meaningful_activity_at,
              (select count(*)::text from learning_session_event
                where user_id=$1 and client_event_id='meaningful-session-event-0001') event_count,
              (select row_version::text from learning_session where id=$2) session_version
         from "user" u where u.id=$1`,
      [LEARNER_A, MEANINGFUL_SESSION],
    );
    expect(committed.rows[0]?.last_meaningful_activity_at.toISOString()).toBe(meaningfulAt.toISOString());
    expect(committed.rows[0]).toMatchObject({ event_count: "1", session_version: "2" });
  });

  it("serializes a project milestone on the user before its project lock", async () => {
    const runAt = new Date("2026-07-14T14:00:00.000Z");
    const meaningfulAt = new Date("2026-07-14T13:59:30.000Z");
    await pool.query(
      `insert into project (id,user_id,title,summary,status,visibility)
       values ($1,$2,'Race-safe project','A deterministic meaningful project checkpoint.','active','private')`,
      [MEANINGFUL_PROJECT, LEARNER_A],
    );
    await pool.query(
      `insert into notification_preference
        (user_id,daily_study_enabled,learning_email_enabled,timezone,daily_study_minute,
         quiet_hours_enabled,row_version)
       values ($1,true,true,'Asia/Kolkata',1080,false,1)`,
      [LEARNER_A],
    );

    const race = await runRestrictedMeaningfulWriterRace({
      label: "project-revision",
      runAt,
      sourceLockSql: "select id from project where id=$1 for update",
      sourceLockValues: [MEANINGFUL_PROJECT],
      writerQueryFragments: [
        "%select id from project%",
        "%where id = $1 and user_id = $2%",
        "%for update%",
      ],
      runWriter: (writerPool) => createProjectRevision({
        userId: LEARNER_A,
        projectId: MEANINGFUL_PROJECT,
        clientRequestId: PROJECT_REVISION_REQUEST,
        expectedLatestRevision: 0,
        changeSummary: "Recorded a deterministic race-safe project checkpoint.",
        now: meaningfulAt,
      }, writerPool),
    });

    expect(race.outcome).toEqual({
      kind: "blocked",
      pid: race.schedulerPid,
      blockerPid: race.writerPid,
    });
    expect(race.schedule).toEqual({ candidates: 1, dispatched: 0, failed: 0 });
    expect(race.counts).toEqual({ dispatches: "0", notifications: "0", outbox: "0" });
    const committed = await pool.query<{
      last_meaningful_activity_at: Date;
      revision_count: string;
    }>(
      `select u.last_meaningful_activity_at,
              (select count(*)::text from project_revision where project_id=$2) revision_count
         from "user" u where u.id=$1`,
      [LEARNER_A, MEANINGFUL_PROJECT],
    );
    expect(committed.rows[0]?.last_meaningful_activity_at.toISOString()).toBe(meaningfulAt.toISOString());
    expect(committed.rows[0]?.revision_count).toBe("1");
  });

  it("sends nothing without opt-in and lets a racing opt-out or email-off change win", async () => {
    const firstRunAt = new Date("2026-07-14T14:00:00.000Z");
    expect(await scheduleSmartReminders(firstRunAt)).toEqual({ candidates: 0, dispatched: 0, failed: 0 });
    expect((await pool.query("select 1 from smart_reminder_dispatch")).rowCount).toBe(0);
    expect((await pool.query("select 1 from notification where type like 'smart_reminder.%'")).rowCount).toBe(0);
    expect((await pool.query("select 1 from email_outbox where template like '%reminder%' or template='weekly-summary'")).rowCount).toBe(0);

    await pool.query(
      `insert into notification_preference
        (user_id,daily_study_enabled,learning_email_enabled,timezone,daily_study_minute,
         quiet_hours_enabled,row_version)
       values ($1,true,true,'Asia/Kolkata',1080,false,1)`,
      [LEARNER_A],
    );

    expect(await runRestrictedPreferenceRace(
      firstRunAt,
      `update notification_preference
          set daily_study_enabled=false,learning_email_enabled=false,
              row_version=row_version+1
        where user_id=$1`,
    )).toEqual({ candidates: 1, dispatched: 0, failed: 0 });
    expect((await pool.query("select 1 from smart_reminder_dispatch")).rowCount).toBe(0);
    expect((await pool.query("select 1 from notification where type like 'smart_reminder.%'")).rowCount).toBe(0);
    expect((await pool.query("select 1 from email_outbox where template like '%reminder%' or template='weekly-summary'")).rowCount).toBe(0);

    await pool.query(
      `update notification_preference
          set daily_study_enabled=true,learning_email_enabled=true,row_version=row_version+1
        where user_id=$1`,
      [LEARNER_A],
    );
    expect(await runRestrictedPreferenceRace(
      new Date("2026-07-15T14:00:00.000Z"),
      `update notification_preference
          set learning_email_enabled=false,row_version=row_version+1
        where user_id=$1`,
    )).toEqual({ candidates: 1, dispatched: 1, failed: 0 });
    expect((await pool.query("select 1 from smart_reminder_dispatch where user_id=$1", [LEARNER_A])).rowCount).toBe(1);
    expect((await pool.query("select 1 from notification where user_id=$1 and type='smart_reminder.daily_study'", [LEARNER_A])).rowCount).toBe(1);
    expect((await pool.query("select 1 from email_outbox where user_id=$1", [LEARNER_A])).rowCount).toBe(0);
  });
});
