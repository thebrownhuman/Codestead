import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  MentorEvidenceError,
  readMentorEvidence,
  resolveMentorLearner,
} from "@/lib/admin-mentor/evidence-reader";
import { pool } from "@/lib/db/client";

const ADMIN = "mentor-evidence-admin";
const LEARNER = "mentor-evidence-learner";
const OTHER = "mentor-evidence-other";
const LEARNER_PUBLIC = "31000000-0000-4000-8000-000000000001";
const OTHER_PUBLIC = "31000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-12T10:00:00.000Z");

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Mentor evidence integration tests require the disposable learncoding_integration database.");
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

const examResult = {
  schemaVersion: 1,
  gradingStatus: "graded",
  outcome: "PASSED",
  officialScorePercent: 88,
  earnedPoints: 88,
  possiblePoints: 100,
  pendingReviewItemIds: [],
  failedCriticalClusters: [],
  masteryBlockingCodingItems: ["loops.code"],
  compilationGatePassed: true,
  infrastructureFailure: false,
  finalizedAt: NOW.toISOString(),
  finalizedBy: "learner-submit",
  policyVersion: "formal-exam-v1",
  remediation: { required: false, targets: [] },
};

async function seedEvidence() {
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status,email_verified,two_factor_enabled)
     values ($1,'31000000-0000-4000-8000-000000000003','Mentor Admin','mentor-admin@integration.invalid','admin','active',true,true),
            ($2,$3,'Asha Learner','asha-mentor@integration.invalid','learner','active',true,true),
            ($4,$5,'Other Learner','other-mentor@integration.invalid','learner','active',true,true)`,
    [ADMIN, LEARNER, LEARNER_PUBLIC, OTHER, OTHER_PUBLIC],
  );

  const targetThread = "32000000-0000-4000-8000-000000000001";
  const otherThread = "32000000-0000-4000-8000-000000000002";
  await pool.query(
    `insert into chat_thread (id,user_id,title,status,created_at,updated_at)
     values ($1,$2,'Loop help','active',$5,$5),($3,$4,'Other private chat','active',$5,$5)`,
    [targetThread, LEARNER, otherThread, OTHER, NOW],
  );
  await pool.query(
    `insert into chat_message (id,thread_id,role,content,curriculum_refs,safety_labels,created_at)
     values
       ('32100000-0000-4000-8000-000000000001',$1,'user','Please explain loop bounds. password: learner-secret','["python.loops"]'::jsonb,'[]'::jsonb,$3),
       ('32100000-0000-4000-8000-000000000002',$1,'assistant','Start with a three-step trace.','["python.loops"]'::jsonb,'[]'::jsonb,$3 + interval '1 minute'),
       ('32100000-0000-4000-8000-000000000003',$1,'user','How does range stop work?','["python.loops"]'::jsonb,'[]'::jsonb,$3 + interval '2 minute'),
       ('32100000-0000-4000-8000-000000000004',$2,'user','OTHER-LEARNER-CHAT-SENTINEL','[]'::jsonb,'[]'::jsonb,$3)`,
    [targetThread, otherThread, NOW],
  );

  const targetAttempt = "33000000-0000-4000-8000-000000000001";
  const otherAttempt = "33000000-0000-4000-8000-000000000002";
  await pool.query(
    `insert into attempt
      (id,user_id,kind,status,policy_version,content_version,score,passed,mastery_awarded,infrastructure_failure,created_at,updated_at)
     values ($1,$2,'exam','graded','formal-exam-v1','catalog:1.0.0',88,true,false,false,$5,$5),
            ($3,$4,'exam','graded','formal-exam-v1','catalog:1.0.0',100,true,true,false,$5,$5)`,
    [targetAttempt, LEARNER, otherAttempt, OTHER, NOW],
  );
  const targetSubmission = "34000000-0000-4000-8000-000000000001";
  await pool.query(
    `insert into code_submission
      (id,user_id,attempt_id,language,source_code,source_hash,submission_type,runtime_image_digest,status,created_at)
     values ($1,$2,$3,'python','print("ok")\n# nvapi-abcdefghijklmnopqrstuvwxyz',$4,'exam_submit','sha256:runner','succeeded',$5),
            ('34000000-0000-4000-8000-000000000002',$6,$7,'python','print("OTHER-CODE-SENTINEL")',$4,'exam_submit','sha256:runner','succeeded',$5)`,
    [targetSubmission, LEARNER, targetAttempt, "d".repeat(64), NOW, OTHER, otherAttempt],
  );
  await pool.query(
    `insert into runner_job (id,submission_id,status,limits,result,queued_at,completed_at)
     values ('34100000-0000-4000-8000-000000000001',$1,'succeeded','{}'::jsonb,$2::jsonb,$3,$3)`,
    [targetSubmission, JSON.stringify({
      status: "ACCEPTED",
      imageDigest: "sha256:hidden-runtime",
      requestHash: "hidden-request-hash",
      compile: { status: "OK", exitCode: 0, stdout: "", stderr: "" },
      run: { exitCode: 0, stdout: "ok", stderr: "" },
      totals: { passed: 2, failed: 0, total: 2 },
      tests: [{ visibility: "HIDDEN", expectedStdout: "hidden oracle" }],
    }), NOW],
  );

  const targetSession = "35000000-0000-4000-8000-000000000001";
  const otherSession = "35000000-0000-4000-8000-000000000002";
  await pool.query(
    `insert into exam_session
      (id,attempt_id,user_id,status,server_started_at,server_deadline_at,last_heartbeat_at,integrity_review_state,created_at,updated_at)
     values ($1,$2,$3,'graded',$6::timestamptz,$6::timestamptz + interval '30 minutes',$6::timestamptz,'not_required',$6::timestamptz,$6::timestamptz),
            ($4,$5,$7,'graded',$6::timestamptz,$6::timestamptz + interval '30 minutes',$6::timestamptz,'not_required',$6::timestamptz,$6::timestamptz)`,
    [targetSession, targetAttempt, LEARNER, otherSession, otherAttempt, NOW, OTHER],
  );
  await pool.query(
    `insert into response (attempt_id,item_key,revision,answer,source,saved_at,submitted_at)
     values
       ($1,'__exam_blueprint_v1__',1,$2::jsonb,'server',$5,$5),
       ($1,'loops.code',1,$3::jsonb,'browser',$5,$5),
       ($1,'__exam_result_v1__',1,$4::jsonb,'server',$5,$5),
       ($6,'other.code',1,'{"sourceCode":"OTHER-ANSWER-SENTINEL"}'::jsonb,'browser',$5,$5)`,
    [
      targetAttempt,
      JSON.stringify({ snapshot: { seed: "HIDDEN-BLUEPRINT-SENTINEL", tests: [{ expected: "hidden" }] } }),
      JSON.stringify({ sourceCode: "for i in range(3): print(i)", language: "python", referenceAnswer: "hidden" }),
      JSON.stringify({ result: examResult, hiddenTests: ["private"] }),
      NOW,
      otherAttempt,
    ],
  );
  await pool.query(
    `insert into exam_event (id,exam_session_id,client_event_id,type,metadata,occurred_at)
     values ('35100000-0000-4000-8000-000000000001',$1,'blur-1','window_blur','{"ipAddress":"10.0.0.1","deviceHash":"private"}'::jsonb,$2),
            ('35100000-0000-4000-8000-000000000002',$3,'other-1','window_blur','{"sentinel":"OTHER-EVENT-SENTINEL"}'::jsonb,$2)`,
    [targetSession, NOW, otherSession],
  );

  const targetProject = "36000000-0000-4000-8000-000000000001";
  const otherProject = "36000000-0000-4000-8000-000000000002";
  await pool.query(
    `insert into project (id,user_id,title,summary,status,visibility,prd,created_at,updated_at)
     values ($1,$2,'Loop visualizer','A bounded learning project.','reviewed','private',$3::jsonb,$6,$6),
            ($4,$5,'Other project','OTHER-PROJECT-SENTINEL','idea','private','{}'::jsonb,$6,$6)`,
    [targetProject, LEARNER, JSON.stringify({ objective: "Visualize loops.", apiKey: "nvapi-abcdefghijklmnopqrstuvwxyz" }), otherProject, OTHER, NOW],
  );
  await pool.query(
    `insert into project_review (id,project_id,commit_sha,analyzer_version,findings,status,created_at)
     values ('36100000-0000-4000-8000-000000000001',$1,'commit-one','reviewer-v1',$2::jsonb,'complete',$3)`,
    [targetProject, JSON.stringify([{ severity: "medium", detail: "Add a loop boundary test.", sessionToken: "private" }]), NOW],
  );

  await pool.query(
    `insert into email_outbox
      (id,user_id,to_email,template,template_version,variables,idempotency_key,status,created_at,updated_at)
     values ('37000000-0000-4000-8000-000000000001',$1,'asha-mentor@integration.invalid','weekly-summary','1',$2::jsonb,'mentor-summary-target','sent',$4,$4),
            ('37000000-0000-4000-8000-000000000002',$3,'other-mentor@integration.invalid','weekly-summary','1','{"summary":"OTHER-SUMMARY-SENTINEL"}'::jsonb,'mentor-summary-other','sent',$4,$4)`,
    [LEARNER, JSON.stringify({ summary: "You completed loops. access token=abcdefghijklmnop" }), OTHER, NOW],
  );
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seedEvidence();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL bounded mentor evidence reader", () => {
  it("resolves only active learner public identities", async () => {
    await expect(resolveMentorLearner(LEARNER_PUBLIC)).resolves.toMatchObject({ id: LEARNER, public_id: LEARNER_PUBLIC });
    await expect(resolveMentorLearner("31000000-0000-4000-8000-000000000099")).resolves.toBeNull();
  });

  it("projects every approved category while excluding secrets, other learners, hidden tests, blueprints, and device/IP metadata", async () => {
    const reports = await Promise.all([
      readMentorEvidence({ learnerUserId: LEARNER, category: "chats", limit: 10 }),
      readMentorEvidence({ learnerUserId: LEARNER, category: "code_submissions", limit: 10 }),
      readMentorEvidence({ learnerUserId: LEARNER, category: "exams", limit: 10 }),
      readMentorEvidence({ learnerUserId: LEARNER, category: "projects", limit: 10 }),
      readMentorEvidence({ learnerUserId: LEARNER, category: "ai_summaries", limit: 10 }),
    ]);
    expect(reports.map((report) => report.category)).toEqual([
      "chats", "code_submissions", "exams", "projects", "ai_summaries",
    ]);
    expect(reports[0]?.items).toHaveLength(3);
    expect(reports[1]?.items).toHaveLength(1);
    expect(reports[2]?.items).toHaveLength(1);
    expect(reports[3]?.items).toHaveLength(1);
    expect(reports[4]?.items).toHaveLength(1);
    expect(reports[2]?.items[0]).toMatchObject({
      attemptId: "33000000-0000-4000-8000-000000000001",
      result: { outcome: "PASSED", officialScorePercent: 88 },
      answers: [expect.objectContaining({ itemId: "loops.code" })],
      integrityEvents: [expect.objectContaining({ type: "window_blur" })],
    });
    for (const report of reports) {
      expect(report.safeguards).toMatchObject({
        hiddenAssessmentEvidenceIncluded: false,
        credentialOrSessionEvidenceIncluded: false,
        deviceOrIpEvidenceIncluded: false,
      });
      expect(report.safeguards.responseBytes).toBeLessThanOrEqual(report.safeguards.responseByteLimit);
    }
    const serialized = JSON.stringify(reports);
    for (const forbidden of [
      "learner-secret",
      "nvapi-",
      "abcdefghijklmnop",
      "OTHER-",
      "HIDDEN-BLUEPRINT-SENTINEL",
      "hidden oracle",
      "expectedStdout",
      "referenceAnswer",
      "imageDigest",
      "requestHash",
      "ipAddress",
      "10.0.0.1",
      "deviceHash",
      "sessionToken",
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("paginates in a stable POST-body cursor without duplicates and rejects forged cursors", async () => {
    const first = await readMentorEvidence({ learnerUserId: LEARNER, category: "chats", limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.page).toMatchObject({ hasMore: true });
    expect(first.page.nextCursor).toBeTruthy();
    const second = await readMentorEvidence({
      learnerUserId: LEARNER,
      category: "chats",
      cursor: first.page.nextCursor!,
      limit: 2,
    });
    expect(second.items).toHaveLength(1);
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
    await expect(readMentorEvidence({ learnerUserId: LEARNER, category: "chats", cursor: "forged", limit: 2 }))
      .rejects.toBeInstanceOf(MentorEvidenceError);
  });

  it("bounds an oversized newest exam before pagination so the following small exam remains reachable", async () => {
    const largeAttempt = "33000000-0000-4000-8000-000000000003";
    const largeSession = "35000000-0000-4000-8000-000000000003";
    const largeAt = new Date("2026-07-12T11:00:00.000Z");
    await pool.query(
      `insert into attempt
        (id,user_id,kind,status,policy_version,content_version,score,passed,mastery_awarded,infrastructure_failure,created_at,updated_at)
       values ($1,$2,'exam','graded','formal-exam-v1','catalog:1.0.0',70,true,false,false,$3,$3)`,
      [largeAttempt, LEARNER, largeAt],
    );
    await pool.query(
      `insert into exam_session
        (id,attempt_id,user_id,status,server_started_at,server_deadline_at,last_heartbeat_at,integrity_review_state,created_at,updated_at)
       values ($1,$2,$3,'graded',$4::timestamptz,$4::timestamptz + interval '30 minutes',$4::timestamptz,'not_required',$4::timestamptz,$4::timestamptz)`,
      [largeSession, largeAttempt, LEARNER, largeAt],
    );
    const oversizedSource = `# nvapi-abcdefghijklmnopqrstuvwxyz\n${"x".repeat(15_950)}`;
    for (let index = 0; index < 25; index += 1) {
      await pool.query(
        `insert into response (attempt_id,item_key,revision,answer,source,saved_at,submitted_at)
         values ($1,$2,1,$3::jsonb,'browser',$4,$4)`,
        [
          largeAttempt,
          `large.code.${String(index).padStart(2, "0")}`,
          JSON.stringify({ sourceCode: oversizedSource, language: "python" }),
          largeAt,
        ],
      );
    }

    const first = await readMentorEvidence({ learnerUserId: LEARNER, category: "exams", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      id: largeSession,
      mentorPayloadTruncated: true,
      mentorPayloadByteLimit: 49_152,
    });
    expect(Buffer.byteLength(JSON.stringify(first.items[0]), "utf8")).toBeLessThanOrEqual(49_152);
    expect(first.safeguards).toMatchObject({
      perItemByteLimit: 49_152,
      truncatedItemCount: 1,
    });
    expect(first.page).toMatchObject({ hasMore: true });
    expect(first.page.nextCursor).toBeTruthy();
    expect(JSON.stringify(first.items)).not.toContain("nvapi-");

    const second = await readMentorEvidence({
      learnerUserId: LEARNER,
      category: "exams",
      cursor: first.page.nextCursor!,
      limit: 1,
    });
    expect(second.items).toEqual([expect.objectContaining({
      id: "35000000-0000-4000-8000-000000000001",
      attemptId: "33000000-0000-4000-8000-000000000001",
    })]);
    expect(second.page).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("rejects direct reads for another role or unavailable learner", async () => {
    await expect(readMentorEvidence({ learnerUserId: ADMIN, category: "chats", limit: 5 }))
      .rejects.toMatchObject({ code: "LEARNER_NOT_FOUND" });
    await expect(readMentorEvidence({ learnerUserId: "missing-user", category: "chats", limit: 5 }))
      .rejects.toMatchObject({ code: "LEARNER_NOT_FOUND" });
  });
});
