import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createBattle,
  getBattle,
  listBattles,
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
import { pool } from "@/lib/db/client";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import { scheduleSmartReminders } from "@/lib/notifications/smart-reminders";
import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";

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
const ITEM = "python.variables.choice.1";
let communityOperationSequence = 0;

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
  const tables = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const names = tables.rows.map((row) => `"${row.table_name.replaceAll('"', '""')}"`).join(",");
  if (names) await pool.query(`truncate table ${names} restart identity cascade`);
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

async function createInviteBattle() {
  return createBattle({
    actorUserId: LEARNER_A,
    requestId: "cb400000-0000-4000-8000-000000000001",
    activityId: ACTIVITY,
    scope: "invite",
    invitedPublicIds: [PUBLIC_B],
    startsAt: NOW,
    durationMinutes: 60,
    now: NOW,
  });
}

async function waitForReminderLockWait() {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const blocked = await pool.query<{ blocked: boolean }>(`
      select exists (
        select 1 from pg_stat_activity activity
         where activity.pid <> pg_backend_pid()
           and activity.wait_event_type = 'Lock'
           and cardinality(pg_blocking_pids(activity.pid)) > 0
           -- pg_stat_activity truncates long statements before the JOIN name
           -- on installations using the default track_activity_query_size.
           and activity.query ilike '%last_meaningful_activity_at%'
      ) as blocked
    `);
    if (blocked.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const diagnostics = await pool.query<{
    pid: number;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    blockers: number[];
    query: string;
  }>(`
    select pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,left(query,300) query
      from pg_stat_activity
     where pid <> pg_backend_pid() and datname=current_database()
     order by pid
  `);
  throw new Error(`The smart-reminder dispatch did not reach its preference lock: ${JSON.stringify(diagnostics.rows)}`);
}

beforeEach(async () => {
  communityOperationSequence = 0;
  await truncateApplicationTables();
  await seedPeopleAndReviewedActivity();
});

afterAll(async () => {
  await pool.end();
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

    const optingOut = await pool.connect();
    try {
      await optingOut.query("begin");
      await optingOut.query("select 1 from notification_preference where user_id=$1 for update", [LEARNER_A]);
      const scheduled = scheduleSmartReminders(firstRunAt);
      await waitForReminderLockWait();
      await optingOut.query(
        `update notification_preference
            set daily_study_enabled=false,learning_email_enabled=false,row_version=row_version+1
          where user_id=$1`,
        [LEARNER_A],
      );
      await optingOut.query("commit");
      expect(await scheduled).toEqual({ candidates: 1, dispatched: 0, failed: 0 });
    } finally {
      await optingOut.query("rollback").catch(() => undefined);
      optingOut.release();
    }
    expect((await pool.query("select 1 from smart_reminder_dispatch")).rowCount).toBe(0);
    expect((await pool.query("select 1 from notification where type like 'smart_reminder.%'")).rowCount).toBe(0);
    expect((await pool.query("select 1 from email_outbox where template like '%reminder%' or template='weekly-summary'")).rowCount).toBe(0);

    await pool.query(
      `update notification_preference
          set daily_study_enabled=true,learning_email_enabled=true,row_version=row_version+1
        where user_id=$1`,
      [LEARNER_A],
    );
    const emailOptOut = await pool.connect();
    try {
      await emailOptOut.query("begin");
      await emailOptOut.query("select 1 from notification_preference where user_id=$1 for update", [LEARNER_A]);
      const scheduled = scheduleSmartReminders(new Date("2026-07-15T14:00:00.000Z"));
      await waitForReminderLockWait();
      await emailOptOut.query(
        `update notification_preference
            set learning_email_enabled=false,row_version=row_version+1
          where user_id=$1`,
        [LEARNER_A],
      );
      await emailOptOut.query("commit");
      expect(await scheduled).toEqual({ candidates: 1, dispatched: 1, failed: 0 });
    } finally {
      await emailOptOut.query("rollback").catch(() => undefined);
      emailOptOut.release();
    }
    expect((await pool.query("select 1 from smart_reminder_dispatch where user_id=$1", [LEARNER_A])).rowCount).toBe(1);
    expect((await pool.query("select 1 from notification where user_id=$1 and type='smart_reminder.daily_study'", [LEARNER_A])).rowCount).toBe(1);
    expect((await pool.query("select 1 from email_outbox where user_id=$1", [LEARNER_A])).rowCount).toBe(0);
  });
});
