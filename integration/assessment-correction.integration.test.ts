import { createHash, createHmac } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExamFormSnapshot, ExamResult, ExamRunnerResult } from "@/lib/exams/contracts";
import { BLUEPRINT_RESPONSE_KEY, RESULT_RESPONSE_KEY } from "@/lib/exams/contracts";
import { hashAppealEvidence } from "@/lib/appeals/evidence";
import { examModuleMasterySlug } from "@/lib/achievements/exam-mastery";
import { getAdminDashboardData, getLearnerDetailData } from "@/app/api/admin/dashboard/data";
import {
  createAssessmentCorrection,
  getAssessmentCorrectionDetail,
  queueAssessmentCorrection,
} from "@/lib/assessment-corrections/admin-service";
import type { ReplacementEvidence } from "@/lib/assessment-corrections/contracts";
import { AssessmentCorrectionError } from "@/lib/assessment-corrections/domain";
import {
  configuredRegradeExecutor,
  regradeRunnerAdmissionRequestId,
} from "@/lib/assessment-corrections/runner-executor";
import {
  processAssessmentRegradeBatch,
  processOneAssessmentRegrade,
  type RegradeExecutionInput,
  type RegradeExecutor,
} from "@/lib/assessment-corrections/worker";
import { pool } from "@/lib/db/client";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { createLearnerExport, EXPORT_SCHEMA_VERSION } from "@/lib/data-lifecycle/export";
import { admitRunnerJob, hashRunnerAdmissionRequest } from "@/lib/runner/admission";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";
import { computeAndPersistLeaderboardScore } from "@/lib/social/leaderboard-service";

const ADMIN_ID = "correction-integration-admin";
const LEARNER_ID = "correction-integration-learner";
const SECOND_LEARNER_ID = "correction-integration-learner-2";
const APPEAL_ID = "a1000000-0000-4000-8000-000000000001";
const ATTEMPT_ID = "a2000000-0000-4000-8000-000000000001";
const SECOND_ATTEMPT_ID = "a2000000-0000-4000-8000-000000000002";
const NEAR_MISS_ATTEMPT_ID = "a2000000-0000-4000-8000-000000000003";
const SESSION_ID = "a3000000-0000-4000-8000-000000000001";
const SECOND_SESSION_ID = "a3000000-0000-4000-8000-000000000002";
const NEAR_MISS_SESSION_ID = "a3000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-07-12T02:00:00.000Z");
const RUNTIME_DIGEST = `sha256:${"a".repeat(64)}`;
const ORIGINAL_PYTHON_DIGEST = `sha256:${"b".repeat(64)}`;
const ORIGINAL_JAVA_DIGEST = `sha256:${"c".repeat(64)}`;
const RUNNER_SHARED_SECRET = "assessment-correction-runner-secret-at-least-32-bytes";
const RUNNER_LIMITS = Object.freeze({
  wallTimeMs: 5_000,
  memoryMb: 128,
  cpuCount: 0.5,
  pids: 32,
  outputBytes: 65_536,
  fileBytes: 16_777_216,
});

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Assessment correction integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

async function waitForUserAuthorityWaiters(blockerPid: number, expectedCount: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: number }>(`
      select count(*)::int waiting
        from pg_locks held join pg_locks waiter
          on waiter.locktype = held.locktype
         and waiter.database is not distinct from held.database
         and waiter.classid is not distinct from held.classid
         and waiter.objid is not distinct from held.objid
         and waiter.objsubid is not distinct from held.objsubid
       where held.pid = $1 and held.locktype = 'advisory' and held.granted
         and waiter.pid <> held.pid and not waiter.granted
    `, [blockerPid]);
    if ((waiting.rows[0]?.waiting ?? 0) >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${expectedCount} operations to wait on the learner authority lock.`);
}

const originalResult: ExamResult = {
  schemaVersion: 1,
  gradingStatus: "graded",
  outcome: "NOT_PASSED",
  officialScorePercent: 0,
  earnedPoints: 0,
  possiblePoints: 100,
  pendingReviewItemIds: [],
  failedCriticalClusters: ["loops"],
  masteryBlockingCodingItems: ["python.loops.code-1"],
  compilationGatePassed: true,
  infrastructureFailure: false,
  finalizedAt: "2026-07-12T01:00:00.000Z",
  finalizedBy: "learner-submit",
  policyVersion: "formal-exam-v1",
  remediation: { required: true, targets: ["loops"] },
};

function form(formId: string, altered = false): ExamFormSnapshot {
  return {
    schemaVersion: 1,
    formId,
    seed: `private-${formId}`,
    courseId: "python",
    courseTitle: "Python",
    moduleId: "python.loops",
    moduleTitle: "Loops",
    contentVersion: "2026.07",
    policyVersion: "formal-exam-v1",
    durationMinutes: 20,
    generatedAt: "2026-07-12T00:00:00.000Z",
    instructions: ["Closed book"],
    integrityDisclosure: { version: "1", summary: "Events recorded", capturedEvents: [], notCaptured: [] },
    items: [{
      id: "python.loops.code-1",
      skillId: "python.loops.for",
      clusterId: "loops",
      title: "Loop",
      prompt: "Print 1 through 3.",
      kind: "code",
      points: 100,
      critical: true,
      language: "python",
      runtime: { version: "Python 3.14", imageDigest: ORIGINAL_PYTHON_DIGEST },
      gradingEvidence: {
        kind: "runner-tests",
        bundleVersion: "faulty-v1",
        tests: [{
          id: "visible-1",
          visibility: "VISIBLE",
          category: "functional",
          stdin: "",
          expectedStdout: altered ? "different\n" : "wrong\n",
          comparison: "EXACT",
          critical: true,
        }, {
          id: "hidden-1",
          visibility: "HIDDEN",
          category: "edge",
          stdin: "",
          expectedStdout: altered ? "different-hidden\n" : "wrong-hidden\n",
          comparison: "TRIMMED",
          critical: true,
        }],
      },
    }],
  };
}

function mixedRuntimeForm(formId: string): ExamFormSnapshot {
  const base = form(formId);
  return {
    ...base,
    items: [base.items[0]!, {
      id: "java.loops.code-2",
      skillId: "java.loops.for",
      clusterId: "loops",
      title: "Java loop",
      prompt: "Print 1 through 3 in Java.",
      kind: "code",
      points: 100,
      critical: true,
      language: "java",
      runtime: { version: "Java 21", imageDigest: ORIGINAL_JAVA_DIGEST },
      gradingEvidence: {
        kind: "runner-tests",
        bundleVersion: "stable-java-v1",
        tests: [{
          id: "java-hidden-1",
          visibility: "HIDDEN",
          category: "functional",
          stdin: "",
          expectedStdout: "1\n2\n3\n",
          comparison: "EXACT",
          critical: true,
        }],
      },
    }],
  };
}

function dsaForm(formId: string): ExamFormSnapshot {
  const base = form(formId);
  return {
    ...base,
    courseId: "dsa",
    courseTitle: "Data Structures and Algorithms",
    moduleId: "dsa.arrays",
    moduleTitle: "Arrays",
    items: [{
      ...base.items[0]!,
      id: "dsa.arrays.code-1",
      skillId: "dsa.arrays.core",
      clusterId: "arrays",
      title: "Array traversal",
      language: "cpp",
      runtime: { version: "C++20 / G++ 14.2.0", imageDigest: ORIGINAL_PYTHON_DIGEST },
    }],
  };
}

const replacement: ReplacementEvidence = {
  kind: "runner-tests",
  bundleVersion: "reviewed-v2",
  runtimeImageDigest: RUNTIME_DIGEST,
  tests: [{
    id: "visible-2",
    visibility: "VISIBLE",
    category: "functional",
    stdin: "",
    expectedStdout: "1\n2\n3\n",
    comparison: "EXACT",
    critical: true,
  }, {
    id: "hidden-2",
    visibility: "HIDDEN",
    category: "edge",
    stdin: "",
    expectedStdout: "1\n2\n3\n",
    comparison: "EXACT",
    critical: true,
  }],
};

async function seedAttempt(input: {
  attemptId: string;
  sessionId: string;
  userId: string;
  form: ExamFormSnapshot;
}) {
  const item = input.form.items[0]!;
  await pool.query(
    `insert into attempt
      (id,user_id,kind,attempt_number,status,policy_version,content_version,score,passed,mastery_awarded,
       infrastructure_failure,started_at,submitted_at,graded_at,created_at,updated_at)
     values ($1,$2,'exam',1,'graded','formal-exam-v1','2026.07',0,false,false,false,$3,$3,$3,$3,$3)`,
    [input.attemptId, input.userId, NOW],
  );
  await pool.query(
    `insert into exam_session
      (id,attempt_id,user_id,status,server_started_at,server_deadline_at,last_heartbeat_at,
       disconnected_seconds,integrity_review_state,created_at,updated_at)
     values ($1,$2,$3,'under_review',$4,$5,$4,0,'appeal_overturned_correction_pending',$4,$4)`,
    [input.sessionId, input.attemptId, input.userId, NOW, new Date(NOW.getTime() + 20 * 60_000)],
  );
  await pool.query(
    `insert into response (attempt_id,item_key,revision,answer,source,saved_at,submitted_at)
     values ($1,$2,1,$3::jsonb,'server',$6,$6),
             ($1,$4,1,$5::jsonb,'browser',$6,$6),
             ($1,$7,1,$8::jsonb,'server',$6,$6)`,
    [input.attemptId, BLUEPRINT_RESPONSE_KEY, JSON.stringify({ snapshot: input.form }),
      item.id,
      JSON.stringify({
        language: item.language ?? "python",
        sourceCode: item.language === "cpp"
          ? "#include <iostream>\nint main(){ std::cout << \"1\\n2\\n3\\n\"; }"
          : "for i in range(1, 4): print(i)",
      }),
      NOW, RESULT_RESPONSE_KEY, JSON.stringify({ result: originalResult })],
  );
}

async function seedScenario(twoExact = false, withNearMiss = false) {
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status,email_verified,two_factor_enabled)
     values ($1,'b1000000-0000-4000-8000-000000000001','Correction Admin','correction-admin@integration.invalid','admin','active',true,true),
            ($2,'b1000000-0000-4000-8000-000000000002','Asha Learner','asha-correction@integration.invalid','learner','active',true,true),
            ($3,'b1000000-0000-4000-8000-000000000003','Ravi Learner','ravi-correction@integration.invalid','learner','active',true,true)`,
    [ADMIN_ID, LEARNER_ID, SECOND_LEARNER_ID],
  );
  await seedAttempt({ attemptId: ATTEMPT_ID, sessionId: SESSION_ID, userId: LEARNER_ID, form: form("form-one") });
  if (twoExact) {
    await seedAttempt({ attemptId: SECOND_ATTEMPT_ID, sessionId: SECOND_SESSION_ID, userId: SECOND_LEARNER_ID, form: form("form-two") });
  }
  if (withNearMiss) {
    await seedAttempt({ attemptId: NEAR_MISS_ATTEMPT_ID, sessionId: NEAR_MISS_SESSION_ID, userId: SECOND_LEARNER_ID, form: form("form-near-miss", true) });
  }
  const appealEvidence = { schemaVersion: 1, attemptId: ATTEMPT_ID, formId: "form-one" };
  await pool.query(
    `insert into appeal
      (id,user_id,attempt_id,category,submission_request_id,reason,evidence,evidence_hash,status,
       decision,decision_reason,decided_by,decided_at,row_version,created_at,updated_at)
     values ($1,$2,$3,'scoring','b2000000-0000-4000-8000-000000000001',
       'The deterministic hidden oracle rejects the specified valid output.',$4::jsonb,$5,
       'overturned','overturned','The human review confirmed that the exact deterministic oracle is faulty.',
       $6,$7,2,$7,$7)`,
    [APPEAL_ID, LEARNER_ID, ATTEMPT_ID, JSON.stringify(appealEvidence), hashAppealEvidence(appealEvidence), ADMIN_ID, NOW],
  );
}

async function seedExactMasteryProjectionMapping() {
  const courseId = "c1000000-0000-4000-8000-000000000001";
  const versionId = "c1000000-0000-4000-8000-000000000002";
  const moduleId = "c1000000-0000-4000-8000-000000000003";
  const lessonId = "c1000000-0000-4000-8000-000000000004";
  const conceptId = "c1000000-0000-4000-8000-000000000005";
  const enrollmentId = "c1000000-0000-4000-8000-000000000006";
  await pool.query(
    `insert into course (id,slug,title,summary,domain)
     values ($1,'python','Python','Disposable correction mapping.','programming')`,
    [courseId],
  );
  await pool.query(
    `insert into course_version (id,course_id,version,stage,scope_statement,content_hash)
     values ($1,$2,'2026.07','beta','Correction projection scope.',$3)`,
    [versionId, courseId, "c".repeat(64)],
  );
  await pool.query(
    `insert into course_module
      (id,course_version_id,slug,title,objective,position,estimated_minutes)
     values ($1,$2,'python.loops','Loops','Use loops safely.',0,20)`,
    [moduleId, versionId],
  );
  await pool.query(
    `insert into lesson
      (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status)
     values ($1,$2,'python.loops.for.lesson','For loops','Use bounded for loops.',20,'beginner',0,'beta')`,
    [lessonId, moduleId],
  );
  await pool.query(
    `insert into concept (id,slug,title,domain,description)
     values ($1,'python.loops.for','For loops','programming','Exact correction projection concept.')`,
    [conceptId],
  );
  await pool.query(
    `insert into lesson_concept (lesson_id,concept_id,coverage,weight)
     values ($1,$2,'complete',1)`,
    [lessonId, conceptId],
  );
  await pool.query(
    `insert into enrollment
      (id,user_id,course_version_id,implementation_language,status,source,started_at)
     values ($1,$2,$3,null,'active','self',$4)`,
    [enrollmentId, LEARNER_ID, versionId, NOW],
  );
  return { conceptId, enrollmentId };
}

async function seedDsaMasteryProjectionMapping() {
  const courseId = "c2000000-0000-4000-8000-000000000001";
  const versionId = "c2000000-0000-4000-8000-000000000002";
  const moduleId = "c2000000-0000-4000-8000-000000000003";
  const lessonId = "c2000000-0000-4000-8000-000000000004";
  const conceptId = "c2000000-0000-4000-8000-000000000005";
  const enrollmentId = "c2000000-0000-4000-8000-000000000006";
  await pool.query(
    `insert into course (id,slug,title,summary,domain)
     values ($1,'dsa','DSA','Disposable DSA correction mapping.','computer-science')`,
    [courseId],
  );
  await pool.query(
    `insert into course_version (id,course_id,version,stage,scope_statement,content_hash)
     values ($1,$2,'2026.07','beta','DSA correction projection scope.',$3)`,
    [versionId, courseId, "d".repeat(64)],
  );
  await pool.query(
    `insert into course_module
      (id,course_version_id,slug,title,objective,position,estimated_minutes)
     values ($1,$2,'dsa.arrays','Arrays','Traverse arrays safely.',0,20)`,
    [moduleId, versionId],
  );
  await pool.query(
    `insert into lesson
      (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status)
     values ($1,$2,'dsa.arrays.lesson','Array traversal','Traverse arrays.',20,'beginner',0,'beta')`,
    [lessonId, moduleId],
  );
  await pool.query(
    `insert into concept (id,slug,title,domain,description)
     values ($1,'dsa.arrays.core','Array traversal','computer-science','Exact DSA correction concept.')`,
    [conceptId],
  );
  await pool.query(
    `insert into lesson_concept (lesson_id,concept_id,coverage,weight)
     values ($1,$2,'complete',1)`,
    [lessonId, conceptId],
  );
  await pool.query(
    `insert into enrollment
      (id,user_id,course_version_id,implementation_language,status,source,started_at)
     values ($1,$2,$3,'C++','active','self',$4)`,
    [enrollmentId, LEARNER_ID, versionId, NOW],
  );
  return { conceptId, enrollmentId };
}

const review = {
  reviewerKind: "human" as const,
  specificationClarified: true as const,
  expectedOutputsReviewed: true as const,
  hiddenTestCoverageReviewed: true as const,
  pinnedRuntimeReviewed: true as const,
  evidenceRef: "evidence://integration/faulty-loop-oracle-v2",
  note: "The exact specification, outputs, hidden edge coverage, and pinned image digest were manually reviewed.",
};

function createInput(requestId = "b3000000-0000-4000-8000-000000000001") {
  return {
    actorUserId: ADMIN_ID,
    requestId,
    appealId: APPEAL_ID,
    itemId: "python.loops.code-1",
    defectKind: "faulty_test" as const,
    reason: "Replace the faulty deterministic oracle after exact human specification review.",
    replacementEvidence: replacement,
    review,
    now: NOW,
  };
}

function passingResult(input: RegradeExecutionInput): ExamRunnerResult {
  return {
    status: "ACCEPTED",
    requestHash: createHash("sha256").update(`${input.jobId}:${input.itemId}`).digest("hex"),
    sourceHash: createHash("sha256").update(input.sourceCode).digest("hex"),
    runtimeVersion: input.expectedRuntimeVersion,
    imageDigest: input.expectedRuntimeImageDigest,
    testBundleVersion: input.evidence.bundleVersion,
    compile: { status: "OK", exitCode: 0, stdout: "", stderr: "", wallTimeMs: 2 },
    tests: input.evidence.tests.map((test) => ({
      id: test.id,
      visibility: test.visibility,
      category: test.category,
      status: "PASSED",
      feedbackCode: "OK",
      exitCode: 0,
      wallTimeMs: 3,
    })),
    totals: { passed: input.evidence.tests.length, failed: 0, total: input.evidence.tests.length },
    startedAt: "2026-07-12T02:01:00.000Z",
    finishedAt: "2026-07-12T02:01:01.000Z",
  };
}

function failingResult(input: RegradeExecutionInput): ExamRunnerResult {
  const accepted = passingResult(input);
  return {
    ...accepted,
    status: "WRONG_ANSWER",
    tests: accepted.tests.map((test) => ({ ...test, status: "FAILED", feedbackCode: "OUTPUT_MISMATCH" })),
    totals: { passed: 0, failed: accepted.tests.length, total: accepted.tests.length },
  };
}

function signedCompletedRunnerResponse(init: RequestInit | undefined, rawRequest: string) {
  const request = JSON.parse(rawRequest) as {
    submissionId: string;
    correlationId: string;
    runtimeVersion: string;
    tests: Array<{ id: string; visibility: "VISIBLE" | "HIDDEN"; category: string }>;
  };
  const responseBody = {
    jobId: "remote-correction-crash-reconciled",
    submissionId: request.submissionId,
    correlationId: request.correlationId,
    requestHash: createHash("sha256").update(rawRequest).digest("hex"),
    state: "COMPLETED",
    queuePosition: null,
    result: {
      status: "ACCEPTED",
      imageDigest: RUNTIME_DIGEST,
      runtimeVersion: request.runtimeVersion,
      compile: { status: "OK", stdout: "", stderr: "", exitCode: 0 },
      tests: request.tests.map((test) => ({
        id: test.id,
        visibility: test.visibility,
        category: test.category,
        status: "PASSED",
        feedbackCode: "OK",
      })),
      totals: { passed: request.tests.length, failed: 0, total: request.tests.length },
    },
  };
  const rawResponse = JSON.stringify(responseBody);
  const requestId = new Headers(init?.headers).get("x-request-id") ?? "";
  const responseHash = createHash("sha256").update(rawResponse).digest("hex");
  const signature = `sha256=${createHmac("sha256", RUNNER_SHARED_SECRET)
    .update(`${requestId}\n200\n${responseHash}`)
    .digest("hex")}`;
  return new Response(rawResponse, {
    status: 200,
    headers: { "x-runner-response-signature": signature },
  });
}

const executor: RegradeExecutor = { execute: async (input) => passingResult(input) };

beforeEach(async () => {
  await truncateApplicationTables();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL assessment correction and regrading", () => {
  it("snapshots only exact faulty evidence, replays safely, and database-protects correction evidence", async () => {
    await seedScenario(true, true);
    const created = await createAssessmentCorrection(createInput());
    expect(created).toMatchObject({ affectedCount: 2, status: "reviewed", rowVersion: 1, replayed: false });
    expect(await createAssessmentCorrection(createInput())).toMatchObject({ id: created.id, replayed: true });
    await expect(createAssessmentCorrection({ ...createInput(), reason: "A conflicting reason reuses the same administrative request identifier." }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(createAssessmentCorrection(createInput("b3000000-0000-4000-8000-000000000099")))
      .rejects.toMatchObject({ code: "INVALID_STATE" });

    const detail = await getAssessmentCorrectionDetail(created.id);
    expect(detail.impacts.map((impact) => impact.attemptId).sort()).toEqual([ATTEMPT_ID, SECOND_ATTEMPT_ID].sort());
    expect(detail.impacts.some((impact) => impact.attemptId === NEAR_MISS_ATTEMPT_ID)).toBe(false);
    expect(JSON.stringify(detail)).not.toContain("expectedStdout");
    expect(JSON.stringify(detail)).not.toContain("sourceCode");

    await expect(pool.query(
      `update assessment_correction set replacement_bundle_version = 'tampered' where id = $1`,
      [created.id],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `update assessment_correction_impact set snapshot = '{}'::jsonb where correction_id = $1`,
      [created.id],
    )).rejects.toMatchObject({ code: "23514" });

    const queueInput = {
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000002",
      expectedVersion: 1,
      reason: "Queue every exact immutable impact for automatic deterministic regrading.",
      now: NOW,
    };
    expect(await queueAssessmentCorrection(queueInput)).toMatchObject({ status: "queued", rowVersion: 2, replayed: false });
    expect(await queueAssessmentCorrection(queueInput)).toMatchObject({ status: "queued", rowVersion: 2, replayed: true });
    const jobs = await pool.query<{ count: string }>(`select count(*)::text as count from assessment_regrade_job where correction_id = $1`, [created.id]);
    expect(jobs.rows[0]?.count).toBe("2");
  });

  it("fails closed without persisting a partial correction when more than 500 attempts are affected", async () => {
    await seedScenario();
    const overflowForm = form("overflow-form");
    await pool.query(
      `insert into attempt
        (id,user_id,kind,attempt_number,status,policy_version,content_version,score,passed,
         mastery_awarded,infrastructure_failure,started_at,submitted_at,graded_at,created_at,updated_at)
       select ('d4000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,
              $1,'exam',g + 1,'graded','formal-exam-v1','2026.07',0,false,false,false,
              $2,$2,$2,$2,$2
         from generate_series(1,500) g`,
      [LEARNER_ID, NOW],
    );
    await pool.query(
      `insert into response (attempt_id,item_key,revision,answer,source,saved_at,submitted_at)
       select ('d4000000-0000-4000-8000-' || lpad(g::text,12,'0'))::uuid,
              payload.item_key,1,payload.answer,'server',$4,$4
         from generate_series(1,500) g
         cross join (values
           ($1::text,$2::jsonb),
           ('python.loops.code-1'::text,$3::jsonb),
           ($5::text,$6::jsonb)
         ) payload(item_key,answer)`,
      [
        BLUEPRINT_RESPONSE_KEY,
        JSON.stringify({ snapshot: overflowForm }),
        JSON.stringify({ language: "python", sourceCode: "print('overflow')" }),
        NOW,
        RESULT_RESPONSE_KEY,
        JSON.stringify({ result: originalResult }),
      ],
    );

    await expect(createAssessmentCorrection(createInput()))
      .rejects.toMatchObject({ code: "AFFECTED_ATTEMPT_LIMIT_EXCEEDED" });
    const residue = await pool.query<{ corrections: string; impacts: string }>(
      `select (select count(*)::text from assessment_correction) corrections,
              (select count(*)::text from assessment_correction_impact) impacts`,
    );
    expect(residue.rows[0]).toEqual({ corrections: "0", impacts: "0" });
  });

  it("reruns the complete deterministic form and appends effective result/mastery evidence without rewriting originals", async () => {
    await seedScenario(true);
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000003",
      expectedVersion: 1,
      reason: "Run both affected attempts through the reviewed deterministic replacement.",
      now: NOW,
    });
    const report = await processAssessmentRegradeBatch({ workerId: "integration-worker", correctionId: created.id, limit: 2, executor });
    expect(report).toMatchObject({ processed: 2, succeeded: 2, failed: 0 });

    const evidence = await pool.query<{
      original_score: number;
      original_passed: boolean;
      original_mastery: boolean;
      original_result: { result: ExamResult };
      effective_result: ExamResult;
      outcome_count: string;
      adjustment_count: string;
      award_count: string;
      badge_count: string;
      notification_count: string;
      outbox_count: string;
      correction_status: string;
      appeal_status: string;
      exam_state: string;
      exam_status: string;
    }>(
      `select
        a.score as original_score, a.passed as original_passed, a.mastery_awarded as original_mastery,
        r.answer as original_result, e.result as effective_result,
        (select count(*)::text from assessment_regrade_outcome where correction_id = $2) outcome_count,
        (select count(*)::text from assessment_mastery_adjustment ma join assessment_regrade_outcome o on o.id = ma.outcome_id where o.correction_id = $2) adjustment_count,
        (select count(*)::text from assessment_mastery_adjustment ma join assessment_regrade_outcome o on o.id = ma.outcome_id where o.correction_id = $2 and ma.effect = 'award') award_count,
        (select count(*)::text from user_achievement where evidence_id in ($5, $6) and revoked_at is null) badge_count,
        (select count(*)::text from notification where type = 'assessment-corrected') notification_count,
        (select count(*)::text from email_outbox where template = 'assessment-corrected') outbox_count,
        (select status from assessment_correction where id = $2) correction_status,
        (select status from appeal where id = $3) appeal_status,
        es.integrity_review_state as exam_state, es.status as exam_status
       from attempt a
       join response r on r.attempt_id = a.id and r.item_key = $4 and r.revision = 1
       join assessment_attempt_effective_result e on e.attempt_id = a.id
       join exam_session es on es.attempt_id = a.id
       where a.id = $1`,
      [ATTEMPT_ID, created.id, APPEAL_ID, RESULT_RESPONSE_KEY,
        `exam-attempt:${ATTEMPT_ID}`, `exam-attempt:${SECOND_ATTEMPT_ID}`],
    );
    expect(evidence.rows[0]).toMatchObject({
      original_score: 0,
      original_passed: false,
      original_mastery: false,
      original_result: { result: originalResult },
      effective_result: { outcome: "MASTERED", officialScorePercent: 100 },
      outcome_count: "2",
      adjustment_count: "2",
      award_count: "2",
      badge_count: "2",
      notification_count: "2",
      outbox_count: "2",
      correction_status: "partially_failed",
      appeal_status: "overturned",
      exam_state: "assessment_correction_applied",
      exam_status: "graded",
    });
    const runnerEvidence = await pool.query<{ runner_evidence: Record<string, unknown> }>(
      `select runner_evidence from assessment_regrade_outcome where correction_id = $1 order by created_at`,
      [created.id],
    );
    expect(JSON.stringify(runnerEvidence.rows)).not.toContain("expectedStdout");
    expect(JSON.stringify(runnerEvidence.rows)).not.toContain("sourceCode");
    const unresolvedRepairs = await pool.query<{ status: string; last_error_code: string; count: string }>(
      `select status, last_error_code, count(*)::text as count
         from assessment_mastery_projection_repair
        where outcome_id in (select id from assessment_regrade_outcome where correction_id = $1)
        group by status, last_error_code`,
      [created.id],
    );
    expect(unresolvedRepairs.rows).toEqual([{
      status: "unresolved",
      last_error_code: "EXACT_MAPPING_NOT_FOUND",
      count: "2",
    }]);

    const outcomeId = (await pool.query<{ id: string }>(`select id from assessment_regrade_outcome where attempt_id = $1`, [ATTEMPT_ID])).rows[0]!.id;
    await expect(pool.query(`update assessment_regrade_outcome set revision = 99 where id = $1`, [outcomeId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`update assessment_mastery_adjustment set effect = 'revoke' where outcome_id = $1`, [outcomeId]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("exports safe correction status without hidden-test-derived correction digests", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000040",
      expectedVersion: 1,
      reason: "Create one completed correction so the learner export boundary is exercised against real rows.",
      now: NOW,
    });
    expect(await processAssessmentRegradeBatch({
      workerId: "export-redaction-worker",
      correctionId: created.id,
      limit: 1,
      executor,
    })).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });

    const privateDigests = await pool.query<Record<string, string>>(
      `select c.faulty_evidence_hash, c.replacement_evidence_hash,
              i.form_hash, i.snapshot_hash,
              o.runner_evidence_hash, o.decision_evidence_hash
         from assessment_correction c
         join assessment_correction_impact i on i.correction_id = c.id
         join assessment_regrade_outcome o on o.impact_id = i.id
        where c.id = $1`,
      [created.id],
    );
    expect(privateDigests.rows).toHaveLength(1);

    const exported = await createLearnerExport({
      learnerId: LEARNER_ID,
      actorUserId: ADMIN_ID,
      requestId: "b3000000-0000-4000-8000-000000000041",
      maxRecords: 1_000,
      maxBytes: 2 * 1_024 * 1_024,
      now: new Date(NOW.getTime() + 60_000),
    });
    const exportText = await new Response(exported.stream).text();
    await expect(exported.completion).resolves.toMatchObject({ completed: true, truncated: false });
    const lines = exportText.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "manifest", schemaVersion: EXPORT_SCHEMA_VERSION });
    const correctionRecord = lines.find((line) =>
      line.category === "assessmentCorrections" && line.data?.correctionId === created.id);
    expect(correctionRecord?.data).toMatchObject({
      correctionId: created.id,
      correctedResult: expect.objectContaining({ outcome: "MASTERED" }),
      hiddenTestsIncluded: false,
    });
    for (const property of [
      "faultyEvidenceHash",
      "replacementEvidenceHash",
      "formHash",
      "snapshotHash",
      "runnerEvidenceHash",
      "decisionEvidenceHash",
    ]) expect(correctionRecord?.data).not.toHaveProperty(property);
    for (const digest of Object.values(privateDigests.rows[0]!)) {
      expect(exportText).not.toContain(digest);
    }
  });

  it("projects a corrected mastery through one exact enrollment mapping and every effective-result consumer", async () => {
    await seedScenario();
    const mapping = await seedExactMasteryProjectionMapping();
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000020",
      expectedVersion: 1,
      reason: "Queue the correction and verify every effective-result and mastery projection consumer.",
      now: NOW,
    });
    const appliedAt = new Date("2026-07-12T02:05:00.000Z");
    expect(await processOneAssessmentRegrade({
      workerId: "integration-projection-worker",
      correctionId: created.id,
      executor,
      now: appliedAt,
      clock: () => new Date(appliedAt),
    })).toMatchObject({ processed: true, succeeded: true });

    const projection = await pool.query<{
      raw_score: number;
      raw_passed: boolean;
      effective_score: string;
      effective_outcome: string;
      repair_status: string;
      resolution_code: string;
      concept_status: string;
      concept_score: number;
      concept_id: string;
      enrollment_id: string;
      evidence_validity: string;
      language_context: string;
      correction_status: string;
      appeal_status: string;
    }>(
      `select a.score as raw_score, a.passed as raw_passed,
              er.result ->> 'officialScorePercent' as effective_score,
              er.result ->> 'outcome' as effective_outcome,
              mp.status as repair_status, mp.resolution_code,
              cm.status as concept_status, cm.score as concept_score,
              mp.concept_id, mp.enrollment_id, mp.language_context,
              me.validity as evidence_validity,
              (select status from assessment_correction where id = $2) as correction_status,
              (select status from appeal where id = $3) as appeal_status
         from attempt a
         join assessment_attempt_effective_result er on er.attempt_id = a.id
         join assessment_regrade_outcome o on o.id = er.outcome_id
         join assessment_mastery_adjustment ma on ma.outcome_id = o.id
         join assessment_mastery_projection_repair mp on mp.adjustment_id = ma.id
         join concept_mastery cm on cm.user_id = mp.user_id and cm.enrollment_id = mp.enrollment_id
          and cm.concept_id = mp.concept_id and cm.language_context = mp.language_context
         join mastery_evidence me on me.id = mp.projection_evidence_id
        where a.id = $1`,
      [ATTEMPT_ID, created.id, APPEAL_ID],
    );
    expect(projection.rows[0]).toMatchObject({
      raw_score: 0,
      raw_passed: false,
      effective_score: "100",
      effective_outcome: "MASTERED",
      repair_status: "applied",
      resolution_code: "PROJECTED_CORRECTED_MASTERY",
      concept_status: "mastered",
      concept_score: 0.95,
      concept_id: mapping.conceptId,
      enrollment_id: mapping.enrollmentId,
      evidence_validity: "valid",
      language_context: "conceptual",
      correction_status: "completed",
      appeal_status: "closed",
    });

    const admin = await getLearnerDetailData("b1000000-0000-4000-8000-000000000002", appliedAt);
    expect(admin?.attempts).toMatchObject({ total: 1, passed: 1, passRate: 100, averageScore: 100 });
    expect(admin?.attempts.recent[0]).toMatchObject({
      id: ATTEMPT_ID,
      score: 100,
      passed: true,
      masteryAwarded: true,
      corrected: true,
    });
    const dashboard = await getAdminDashboardData(appliedAt);
    expect(dashboard.learners.find((learner) => learner.publicId === "b1000000-0000-4000-8000-000000000002"))
      .toMatchObject({ attempts: 1, passRate: 100 });
    expect(dashboard.learning).toMatchObject({ attempts: 1, passedAttempts: 1, passRate: 100 });

    const leaderboard = await computeAndPersistLeaderboardScore({
      userId: LEARNER_ID,
      periodKind: "weekly",
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    expect(leaderboard.components).toMatchObject({ newMastery: 100, xp: 6 });
    expect(leaderboard.totalPoints).toBe(106);

    const detail = await getAssessmentCorrectionDetail(created.id);
    expect(detail.masteryRepairs).toEqual([
      expect.objectContaining({
        skillId: "python.loops.for",
        status: "applied",
        resolutionCode: "PROJECTED_CORRECTED_MASTERY",
      }),
    ]);
  });

  it("normalizes a cpp runner form into the canonical dsa:c++ facet and C++ enrollment", async () => {
    await seedScenario();
    const snapshot = dsaForm("form-one");
    const mapping = await seedDsaMasteryProjectionMapping();
    await pool.query(
      `update response set answer = $2::jsonb
        where attempt_id = $1 and item_key = $3 and revision = 1`,
      [ATTEMPT_ID, JSON.stringify({ snapshot }), BLUEPRINT_RESPONSE_KEY],
    );
    await pool.query(
      `delete from response where attempt_id = $1 and item_key = 'python.loops.code-1'`,
      [ATTEMPT_ID],
    );
    await pool.query(
      `insert into response (attempt_id,item_key,revision,answer,source,saved_at,submitted_at)
       values ($1,'dsa.arrays.code-1',1,$2::jsonb,'browser',$3,$3)`,
      [ATTEMPT_ID, JSON.stringify({ language: "cpp", sourceCode: "int main(){return 0;}" }), NOW],
    );
    const created = await createAssessmentCorrection({
      ...createInput("b3000000-0000-4000-8000-000000000021"),
      itemId: "dsa.arrays.code-1",
    });
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000022",
      expectedVersion: 1,
      reason: "Queue the reviewed DSA replacement and verify its canonical implementation facet.",
      now: NOW,
    });
    expect(await processOneAssessmentRegrade({
      workerId: "integration-dsa-projection-worker",
      correctionId: created.id,
      executor,
      now: new Date(NOW.getTime() + 60_000),
      clock: () => new Date(NOW.getTime() + 60_000),
    })).toMatchObject({ processed: true, succeeded: true });

    const result = await pool.query<{
      language_context: string;
      concept_id: string;
      enrollment_id: string;
      repair_status: string;
      correction_status: string;
      appeal_status: string;
    }>(
      `select mp.language_context, mp.concept_id, mp.enrollment_id,
              mp.status as repair_status, c.status as correction_status,
              a.status as appeal_status
         from assessment_mastery_projection_repair mp
         join assessment_regrade_outcome o on o.id = mp.outcome_id
         join assessment_correction c on c.id = o.correction_id
         join appeal a on a.id = c.source_appeal_id
        where o.attempt_id = $1`,
      [ATTEMPT_ID],
    );
    expect(result.rows[0]).toEqual({
      language_context: "dsa:c++",
      concept_id: mapping.conceptId,
      enrollment_id: mapping.enrollmentId,
      repair_status: "applied",
      correction_status: "completed",
      appeal_status: "closed",
    });
  });

  it("leases one job once under concurrent workers and fails closed on a stale effective-result chain", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000004",
      expectedVersion: 1,
      reason: "Queue the single impact to verify concurrent worker lease serialization.",
      now: NOW,
    });
    const execute = vi.fn(async (input: RegradeExecutionInput) => passingResult(input));
    const reports = await Promise.all([
      processOneAssessmentRegrade({ workerId: "integration-worker-a", correctionId: created.id, executor: { execute } }),
      processOneAssessmentRegrade({ workerId: "integration-worker-b", correctionId: created.id, executor: { execute } }),
    ]);
    expect(reports.filter((entry) => entry.processed)).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect((await pool.query(`select id from assessment_regrade_outcome where correction_id = $1`, [created.id])).rows).toHaveLength(1);
    expect((await pool.query(`select id from notification where user_id = $1 and type = 'assessment-corrected'`, [LEARNER_ID])).rows).toHaveLength(1);
  });

  it("records one determinate failure event when concurrent workers race for the same lease", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput("b3000000-0000-4000-8000-000000000027"));
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000028",
      expectedVersion: 1,
      reason: "Queue one correction and prove concurrent failure handling consumes one determinate retry only.",
      now: NOW,
    });
    const execute = vi.fn(async (input: RegradeExecutionInput) => ({
      ...passingResult(input),
      imageDigest: `sha256:${"f".repeat(64)}`,
    }));
    const failedAt = new Date(NOW.getTime() + 1_000);
    const reports = await Promise.all([
      processOneAssessmentRegrade({
        workerId: "integration-failure-race-a",
        correctionId: created.id,
        executor: { execute },
        now: failedAt,
        clock: () => new Date(failedAt),
      }),
      processOneAssessmentRegrade({
        workerId: "integration-failure-race-b",
        correctionId: created.id,
        executor: { execute },
        now: failedAt,
        clock: () => new Date(failedAt),
      }),
    ]);
    expect(reports.filter((report) => report.processed)).toHaveLength(1);
    expect(reports.find((report) => report.processed)).toMatchObject({
      succeeded: false,
      errorCode: "RUNNER_INFRASTRUCTURE_FAILURE",
    });
    expect(execute).toHaveBeenCalledOnce();
    const failures = await pool.query<{ evidence: Record<string, unknown> }>(
      `select evidence from assessment_correction_event
        where correction_id = $1 and event = 'regrade_failed'`,
      [created.id],
    );
    expect(failures.rows).toHaveLength(1);
    expect(failures.rows[0]?.evidence).toMatchObject({
      determinateAttemptNumber: 1,
      leaseAttemptNumber: 1,
      retryAllowed: true,
    });
  });

  it("uses each code item's pinned runtime while applying the reviewed digest only to the corrected target", async () => {
    await seedScenario();
    const snapshot = mixedRuntimeForm("form-one");
    await pool.query(
      `update response set answer = $2::jsonb
        where attempt_id = $1 and item_key = $3 and revision = 1`,
      [ATTEMPT_ID, JSON.stringify({ snapshot }), BLUEPRINT_RESPONSE_KEY],
    );
    await pool.query(
      `insert into response (attempt_id,item_key,revision,answer,source,saved_at,submitted_at)
       values ($1,'java.loops.code-2',1,$2::jsonb,'browser',$3,$3)`,
      [ATTEMPT_ID, JSON.stringify({
        language: "java",
        sourceCode: "public class Main { public static void main(String[] args) { System.out.print(\"1\\n2\\n3\\n\"); } }",
      }), NOW],
    );
    const created = await createAssessmentCorrection(createInput("b3000000-0000-4000-8000-000000000023"));
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000024",
      expectedVersion: 1,
      reason: "Queue the mixed-runtime form and preserve each independently pinned runtime identity.",
      now: NOW,
    });
    const executions: RegradeExecutionInput[] = [];
    const appliedAt = new Date(NOW.getTime() + 60_000);
    await expect(processOneAssessmentRegrade({
      workerId: "integration-mixed-runtime-worker",
      correctionId: created.id,
      executor: { execute: async (execution) => {
        executions.push(execution);
        return passingResult(execution);
      } },
      now: appliedAt,
      clock: () => new Date(appliedAt),
    })).resolves.toMatchObject({ processed: true, succeeded: true });

    expect(executions.map((execution) => ({
      itemId: execution.itemId,
      version: execution.expectedRuntimeVersion,
      digest: execution.expectedRuntimeImageDigest,
    }))).toEqual([{
      itemId: "python.loops.code-1",
      version: "Python 3.14",
      digest: RUNTIME_DIGEST,
    }, {
      itemId: "java.loops.code-2",
      version: "Java 21",
      digest: ORIGINAL_JAVA_DIGEST,
    }]);
  });

  it("serializes official correction persistence behind account deletion and leaves no post-deletion projections", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput("b3000000-0000-4000-8000-000000000025"));
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000026",
      expectedVersion: 1,
      reason: "Queue the correction and prove learner deletion owns the final authority boundary.",
      now: NOW,
    });
    const previousKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.DELETION_TOMBSTONE_KEY = "assessment-correction-deletion-integration-key";
    const blocker = await pool.connect();
    let deletion: ReturnType<typeof deleteLearnerAccount> | undefined;
    let worker: ReturnType<typeof processOneAssessmentRegrade> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(LEARNER_ID)]);
      const blockerPid = (await blocker.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!.pid;
      deletion = deleteLearnerAccount({
        actorUserId: ADMIN_ID,
        learnerId: LEARNER_ID,
        requestId: "de200000-0000-4000-8000-000000000001",
        reason: "Delete the learner while a correction worker is ready to persist official projections.",
        now: new Date(NOW.getTime() + 2_000),
        objectStorageRoot: "C:/tmp/assessment-correction-deletion-empty",
      });
      await waitForUserAuthorityWaiters(blockerPid, 1);
      let signalExecution!: () => void;
      const executionStarted = new Promise<void>((resolve) => { signalExecution = resolve; });
      const workerNow = new Date(NOW.getTime() + 1_000);
      worker = processOneAssessmentRegrade({
        workerId: "integration-deletion-fence-worker",
        correctionId: created.id,
        executor: { execute: async (execution) => {
          signalExecution();
          return passingResult(execution);
        } },
        now: workerNow,
        clock: () => new Date(workerNow),
      });
      await executionStarted;
      await waitForUserAuthorityWaiters(blockerPid, 2);
      await blocker.query("commit");

      await expect(deletion).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
      await expect(worker).resolves.toMatchObject({
        processed: true,
        succeeded: false,
        errorCode: "LEARNER_NOT_ACTIVE",
      });
      const residue = await pool.query<{
        outcomes: string;
        effective_results: string;
        adjustments: string;
        notifications: string;
        email: string;
      }>(
        `select
          (select count(*)::text from assessment_regrade_outcome where user_id = $1) outcomes,
          (select count(*)::text from assessment_attempt_effective_result where user_id = $1) effective_results,
          (select count(*)::text from assessment_mastery_adjustment where user_id = $1) adjustments,
          (select count(*)::text from notification where user_id = $1) notifications,
          (select count(*)::text from email_outbox where user_id = $1) email`,
        [LEARNER_ID],
      );
      expect(residue.rows[0]).toEqual({
        outcomes: "0",
        effective_results: "0",
        adjustments: "0",
        notifications: "0",
        email: "0",
      });
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
      await deletion?.catch(() => undefined);
      await worker?.catch(() => undefined);
      if (previousKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousKey;
    }
  });

  it("revokes badge/effective mastery but leaves unlinked historic concept mastery explicitly unresolved", async () => {
    await seedScenario();
    const masteredResult: ExamResult = {
      ...originalResult,
      outcome: "MASTERED",
      officialScorePercent: 100,
      earnedPoints: 100,
      failedCriticalClusters: [],
      masteryBlockingCodingItems: [],
      remediation: { required: false, targets: [] },
    };
    await pool.query(
      `update attempt set score = 100, passed = true, mastery_awarded = true where id = $1`,
      [ATTEMPT_ID],
    );
    await pool.query(
      `update response set answer = $2::jsonb where attempt_id = $1 and item_key = $3 and revision = 1`,
      [ATTEMPT_ID, JSON.stringify({ result: masteredResult }), RESULT_RESPONSE_KEY],
    );
    const badgeSlug = examModuleMasterySlug("python", "python.loops");
    await pool.query(
      `insert into achievement (slug,title,description,icon,rule_version,rule)
       values ($1,'Mastery: Loops','Synthetic prior mastery.','medal','exam-mastery-v1','{}'::jsonb)
       on conflict (slug) do nothing`,
      [badgeSlug],
    );
    await pool.query(
      `insert into user_achievement (user_id,achievement_id,evidence_id,visibility)
       select $1,id,$2,'private' from achievement where slug = $3`,
      [LEARNER_ID, `exam-attempt:${ATTEMPT_ID}`, badgeSlug],
    );
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000005",
      expectedVersion: 1,
      reason: "Queue the reviewed replacement that corrects an incorrectly permissive mastery oracle.",
      now: NOW,
    });
    const result = await processOneAssessmentRegrade({
      workerId: "integration-revocation-worker",
      correctionId: created.id,
      executor: { execute: async (input) => failingResult(input) },
    });
    expect(result).toMatchObject({ processed: true, succeeded: true });
    const state = await pool.query<{
      score: number;
      passed: boolean;
      mastery_awarded: boolean;
      outcome: string;
      effect: string;
      revoked_at: Date | null;
      repair_status: string;
      repair_error: string | null;
      correction_status: string;
      appeal_status: string;
    }>(
      `select a.score, a.passed, a.mastery_awarded,
              e.result ->> 'outcome' as outcome, m.effect, ua.revoked_at,
              mp.status as repair_status, mp.last_error_code as repair_error,
              c.status as correction_status, ap.status as appeal_status
         from attempt a
         join assessment_attempt_effective_result e on e.attempt_id = a.id
          join assessment_regrade_outcome o on o.id = e.outcome_id
          join assessment_mastery_adjustment m on m.outcome_id = o.id and m.skill_id = 'python.loops.for'
          join assessment_mastery_projection_repair mp on mp.adjustment_id = m.id
          join assessment_correction c on c.id = o.correction_id
          join appeal ap on ap.id = c.source_appeal_id
         join user_achievement ua on ua.user_id = a.user_id and ua.evidence_id = $2
        where a.id = $1`,
      [ATTEMPT_ID, `exam-attempt:${ATTEMPT_ID}`],
    );
    expect(state.rows[0]).toMatchObject({
      score: 100,
      passed: true,
      mastery_awarded: true,
      outcome: "NOT_PASSED",
      effect: "revoke",
      repair_status: "unresolved",
      repair_error: "ORIGINAL_MASTERY_PROJECTION_REQUIRES_REBUILD",
      correction_status: "partially_failed",
      appeal_status: "overturned",
    });
    expect(state.rows[0]?.revoked_at).toBeInstanceOf(Date);
  });

  it("fails closed on a runtime digest mismatch and permits a reviewed bounded retry without an interim outcome", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000006",
      expectedVersion: 1,
      reason: "Queue the correction to verify strict runtime image digest enforcement.",
      now: NOW,
    });
    const failed = await processOneAssessmentRegrade({
      workerId: "integration-wrong-digest-worker",
      correctionId: created.id,
      executor: {
        execute: async (input) => ({ ...passingResult(input), imageDigest: `sha256:${"f".repeat(64)}` }),
      },
    });
    expect(failed).toMatchObject({ processed: true, succeeded: false, errorCode: "RUNNER_INFRASTRUCTURE_FAILURE" });
    const interim = await pool.query<{ outcomes: string; projections: string; status: string; attempt_count: number }>(
      `select
        (select count(*)::text from assessment_regrade_outcome where correction_id = $1) outcomes,
        (select count(*)::text from assessment_attempt_effective_result where attempt_id = $2) projections,
        j.status, j.attempt_count
       from assessment_regrade_job j where j.correction_id = $1`,
      [created.id, ATTEMPT_ID],
    );
    expect(interim.rows[0]).toEqual({ outcomes: "0", projections: "0", status: "failed", attempt_count: 1 });

    const requeued = await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000007",
      expectedVersion: 2,
      reason: "Retry after restoring the exact independently reviewed runner image digest.",
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(requeued).toMatchObject({ status: "queued", rowVersion: 3 });
    const succeeded = await processOneAssessmentRegrade({
      workerId: "integration-retry-worker",
      correctionId: created.id,
      executor,
      now: new Date(NOW.getTime() + 120_000),
      clock: () => new Date(NOW.getTime() + 120_000),
    });
    expect(succeeded).toMatchObject({ processed: true, succeeded: true });
    expect((await pool.query(`select id from assessment_regrade_outcome where correction_id = $1`, [created.id])).rows).toHaveLength(1);
  });

  it("requeues runner-capacity deferrals without producing learner failure or official evidence", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000040",
      expectedVersion: 1,
      reason: "Queue the reviewed correction and verify runner capacity remains a retryable operational state.",
      now: NOW,
    });

    const deferred = await processOneAssessmentRegrade({
      workerId: "integration-capacity-worker",
      correctionId: created.id,
      executor: { execute: async () => { throw new AssessmentCorrectionError("RUNNER_CAPACITY_BUSY"); } },
      now: new Date(NOW.getTime() + 1_000),
      clock: () => new Date(NOW.getTime() + 1_000),
    });
    expect(deferred).toMatchObject({
      processed: true,
      succeeded: false,
      requeued: true,
      retryable: true,
      errorCode: "RUNNER_CAPACITY_BUSY",
    });
    const deferredState = await pool.query<{
      correction_status: string;
      job_status: string;
      attempts: number;
      runner_generation: number;
      outcomes: string;
      effective_results: string;
      mastery_adjustments: string;
    }>(
      `select c.status correction_status,j.status job_status,j.attempt_count attempts,
              j.runner_request_generation runner_generation,
              (select count(*)::text from assessment_regrade_outcome where correction_id = c.id) outcomes,
              (select count(*)::text from assessment_attempt_effective_result where attempt_id = $2) effective_results,
              (select count(*)::text from assessment_mastery_adjustment m
                join assessment_regrade_outcome o on o.id = m.outcome_id
               where o.correction_id = c.id) mastery_adjustments
         from assessment_correction c join assessment_regrade_job j on j.correction_id = c.id
        where c.id = $1`,
      [created.id, ATTEMPT_ID],
    );
    expect(deferredState.rows[0]).toEqual({
      correction_status: "queued",
      job_status: "queued",
      attempts: 1,
      runner_generation: 2,
      outcomes: "0",
      effective_results: "0",
      mastery_adjustments: "0",
    });

    const retried = await processOneAssessmentRegrade({
      workerId: "integration-capacity-retry-worker",
      correctionId: created.id,
      executor,
      now: new Date(NOW.getTime() + 2_000),
      clock: () => new Date(NOW.getTime() + 2_000),
    });
    expect(retried).toMatchObject({ processed: true, succeeded: true });
    const attempts = await pool.query<{ attempt_count: number; runner_request_generation: number }>(
      `select attempt_count,runner_request_generation from assessment_regrade_job where correction_id = $1`,
      [created.id],
    );
    expect(attempts.rows[0]?.attempt_count).toBe(2);
    expect(attempts.rows[0]?.runner_request_generation).toBe(2);
  });

  it("requeues an indeterminate runner outcome with the same runner generation and a new lease generation", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000041",
      expectedVersion: 1,
      reason: "Queue the reviewed correction and preserve remote idempotency across an indeterminate wait.",
      now: NOW,
    });
    const generations: Array<{ lease: number; runner: number }> = [];
    const firstNow = new Date(NOW.getTime() + 10_000);
    const deferred = await processOneAssessmentRegrade({
      workerId: "integration-indeterminate-worker",
      correctionId: created.id,
      executor: { execute: async (input) => {
        generations.push({ lease: input.jobAttemptCount, runner: input.runnerRequestGeneration });
        throw new AssessmentCorrectionError("RUNNER_INDETERMINATE");
      } },
      now: firstNow,
      clock: () => new Date(firstNow),
    });
    expect(deferred).toMatchObject({
      processed: true,
      succeeded: false,
      requeued: true,
      retryable: true,
      errorCode: "RUNNER_INDETERMINATE",
    });
    expect((await pool.query<{
      status: string; attempt_count: number; runner_request_generation: number;
    }>(
      `select status,attempt_count,runner_request_generation
         from assessment_regrade_job where correction_id = $1`,
      [created.id],
    )).rows[0]).toEqual({ status: "queued", attempt_count: 1, runner_request_generation: 1 });

    const secondNow = new Date(firstNow.getTime() + 1_000);
    const retried = await processOneAssessmentRegrade({
      workerId: "integration-indeterminate-retry",
      correctionId: created.id,
      executor: { execute: async (input) => {
        generations.push({ lease: input.jobAttemptCount, runner: input.runnerRequestGeneration });
        return passingResult(input);
      } },
      now: secondNow,
      clock: () => new Date(secondNow),
    });
    expect(retried).toMatchObject({ processed: true, succeeded: true });
    expect(generations).toEqual([{ lease: 1, runner: 1 }, { lease: 2, runner: 1 }]);
  });

  it("reclaims an expired third lease through the exact leased runner admission without wedging the slot or deletion", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput("b3000000-0000-4000-8000-000000000043"));
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000044",
      expectedVersion: 1,
      reason: "Queue the correction and simulate a worker crash after the durable runner dispatch boundary.",
      now: NOW,
    });
    const job = (await pool.query<{ id: string; runner_request_generation: number }>(
      `select id, runner_request_generation from assessment_regrade_job where correction_id = $1`,
      [created.id],
    )).rows[0]!;
    const crashInput: RegradeExecutionInput = {
      jobId: job.id,
      jobAttemptCount: 3,
      runnerRequestGeneration: job.runner_request_generation,
      correctionId: created.id,
      attemptId: ATTEMPT_ID,
      userId: LEARNER_ID,
      itemId: "python.loops.code-1",
      language: "python",
      expectedRuntimeVersion: "Python 3.14",
      sourceCode: "for i in range(1, 4): print(i)",
      evidence: replacement,
      expectedRuntimeImageDigest: RUNTIME_DIGEST,
    };
    const expectedRequestId = regradeRunnerAdmissionRequestId(crashInput);
    const previousRunnerUrl = process.env.RUNNER_BASE_URL;
    const previousRunnerSecret = process.env.RUNNER_SHARED_SECRET;
    const previousDeletionKey = process.env.DELETION_TOMBSTONE_KEY;
    process.env.RUNNER_BASE_URL = "http://correction-runner.integration";
    process.env.RUNNER_SHARED_SECRET = RUNNER_SHARED_SECRET;
    process.env.DELETION_TOMBSTONE_KEY = "assessment-correction-crash-recovery-deletion-key";
    const remoteCalls: Array<{ body: string; idempotencyKey: string | null; method: string }> = [];
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      const rawRequest = typeof init?.body === "string" ? init.body : "";
      const headers = new Headers(init?.headers);
      remoteCalls.push({
        body: rawRequest,
        idempotencyKey: headers.get("x-idempotency-key"),
        method: init?.method ?? "GET",
      });
      if (remoteCalls.length === 1) {
        throw new TypeError("connection lost after the remote may have accepted the idempotent request");
      }
      return signedCompletedRunnerResponse(init, rawRequest);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(configuredRegradeExecutor.execute(crashInput)).rejects.toMatchObject({
        code: "RUNNER_INDETERMINATE",
      });
      const leased = await pool.query<{
        submission_status: string;
        runner_status: string;
        remote_job_id: string | null;
        request_id: string;
      }>(
        `select s.status submission_status, r.status runner_status,
                r.lease_owner remote_job_id, s.request_id
           from code_submission s join runner_job r on r.submission_id = s.id
          where s.user_id = $1 and s.submission_type = 'assessment_correction_regrade'`,
        [LEARNER_ID],
      );
      expect(leased.rows).toEqual([{
        submission_status: "leased",
        runner_status: "leased",
        remote_job_id: null,
        request_id: expectedRequestId,
      }]);

      const recoveryNow = new Date(NOW.getTime() + 40 * 60_000);
      await pool.query(
        `update assessment_regrade_job
            set status = 'running', attempt_count = 3, lease_owner = 'crashed-third-worker',
                lease_expires_at = $2, started_at = $3, updated_at = $3
          where id = $1`,
        [job.id, recoveryNow, new Date(recoveryNow.getTime() - 11 * 60_000)],
      );
      await pool.query(
        `update assessment_correction set status = 'processing', updated_at = $2 where id = $1`,
        [created.id, new Date(recoveryNow.getTime() - 11 * 60_000)],
      );

      await expect(processOneAssessmentRegrade({
        workerId: "integration-third-lease-reconciler",
        correctionId: created.id,
        now: recoveryNow,
        clock: () => new Date(recoveryNow),
      })).resolves.toMatchObject({ processed: true, succeeded: true });

      expect(remoteCalls).toHaveLength(2);
      expect(remoteCalls.map((call) => call.method)).toEqual(["POST", "POST"]);
      expect(remoteCalls[1]!.idempotencyKey).toBe(remoteCalls[0]!.idempotencyKey);
      expect(remoteCalls[1]!.body).toBe(remoteCalls[0]!.body);
      const settled = await pool.query<{
        job_status: string;
        attempt_count: number;
        runner_request_generation: number;
        submission_status: string;
        runner_status: string;
        remote_job_id: string | null;
        admissions: string;
      }>(
        `select j.status job_status, j.attempt_count, j.runner_request_generation,
                s.status submission_status, r.status runner_status, r.lease_owner remote_job_id,
                (select count(*)::text from code_submission cs
                  where cs.user_id = i.user_id
                    and cs.submission_type = 'assessment_correction_regrade') admissions
           from assessment_regrade_job j
           join assessment_correction_impact i on i.id = j.impact_id
           join code_submission s on s.user_id = i.user_id and s.request_id = $2
           join runner_job r on r.submission_id = s.id
          where j.id = $1`,
        [job.id, expectedRequestId],
      );
      expect(settled.rows[0]).toEqual({
        job_status: "succeeded",
        attempt_count: 4,
        runner_request_generation: 1,
        submission_status: "succeeded",
        runner_status: "succeeded",
        remote_job_id: "remote-correction-crash-reconciled",
        admissions: "1",
      });
      const recoveryEvent = await pool.query<{ evidence: Record<string, unknown> }>(
        `select evidence from assessment_correction_event
          where correction_id = $1
            and reason = 'Expired worker lease retained for exact same-generation runner admission reconciliation.'`,
        [created.id],
      );
      expect(recoveryEvent.rows).toHaveLength(1);
      expect(recoveryEvent.rows[0]?.evidence).toMatchObject({
        expiredLeaseAttempt: 3,
        runnerRequestGeneration: 1,
        reconciliation: "same_runner_request_generation",
      });

      const slotSource = "print('official slot released')\n";
      const slotSourceHash = createHash("sha256").update(slotSource).digest("hex");
      const slotRequestHash = hashRunnerAdmissionRequest({
        schemaVersion: 1,
        userId: LEARNER_ID,
        sourceHash: slotSourceHash,
        submissionType: "assessment_correction_regrade",
        limits: RUNNER_LIMITS,
      });
      await expect(admitRunnerJob({
        userId: LEARNER_ID,
        language: "python",
        sourceCode: slotSource,
        sourceHash: slotSourceHash,
        submissionType: "assessment_correction_regrade",
        requestId: "post-recovery-official-slot-proof",
        requestHash: slotRequestHash,
        limits: RUNNER_LIMITS,
        now: new Date(recoveryNow.getTime() + 1_000),
      })).resolves.toMatchObject({ duplicate: false, status: "queued" });

      await expect(deleteLearnerAccount({
        actorUserId: ADMIN_ID,
        learnerId: LEARNER_ID,
        requestId: "de200000-0000-4000-8000-000000000002",
        reason: "Delete the learner after same-generation crash reconciliation released the official runner slot.",
        now: new Date(recoveryNow.getTime() + 2_000),
        objectStorageRoot: "C:/tmp/assessment-correction-crash-recovery-empty",
      })).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
    } finally {
      vi.unstubAllGlobals();
      if (previousRunnerUrl === undefined) delete process.env.RUNNER_BASE_URL;
      else process.env.RUNNER_BASE_URL = previousRunnerUrl;
      if (previousRunnerSecret === undefined) delete process.env.RUNNER_SHARED_SECRET;
      else process.env.RUNNER_SHARED_SECRET = previousRunnerSecret;
      if (previousDeletionKey === undefined) delete process.env.DELETION_TOMBSTONE_KEY;
      else process.env.DELETION_TOMBSTONE_KEY = previousDeletionKey;
    }
  });

  it("reclaims lease attempt three before an admission commits and fences the stale worker's later dispatch", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput("b3000000-0000-4000-8000-000000000045"));
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000046",
      expectedVersion: 1,
      reason: "Queue the correction and reclaim a third lease before its runner admission becomes visible.",
      now: NOW,
    });
    const job = (await pool.query<{ id: string }>(
      `update assessment_regrade_job set attempt_count = 2
        where correction_id = $1 returning id`,
      [created.id],
    )).rows[0]!;
    const previousRunnerUrl = process.env.RUNNER_BASE_URL;
    const previousRunnerSecret = process.env.RUNNER_SHARED_SECRET;
    process.env.RUNNER_BASE_URL = "http://correction-runner.integration";
    process.env.RUNNER_SHARED_SECRET = RUNNER_SHARED_SECRET;
    const remoteBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
      const rawRequest = typeof init?.body === "string" ? init.body : "";
      remoteBodies.push(rawRequest);
      return signedCompletedRunnerResponse(init, rawRequest);
    }));
    let releaseStale!: () => void;
    let signalStale!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const staleStarted = new Promise<void>((resolve) => { signalStale = resolve; });
    let current = new Date(NOW.getTime() + 10_000);
    const clock = () => new Date(current);
    let stale: ReturnType<typeof processOneAssessmentRegrade> | undefined;
    try {
      stale = processOneAssessmentRegrade({
        workerId: "integration-third-lease-stale-worker",
        correctionId: created.id,
        executor: { execute: async (execution) => {
          signalStale();
          await staleGate;
          return configuredRegradeExecutor.execute(execution);
        } },
        now: current,
        clock,
      });
      await staleStarted;
      expect((await pool.query<{ count: string }>(
        `select count(*)::text count from code_submission
          where user_id = $1 and submission_type = 'assessment_correction_regrade'`,
        [LEARNER_ID],
      )).rows[0]?.count).toBe("0");

      current = new Date(current.getTime() + 11 * 60_000);
      await expect(processOneAssessmentRegrade({
        workerId: "integration-fourth-lease-winner",
        correctionId: created.id,
        now: current,
        clock,
      })).resolves.toMatchObject({ processed: true, succeeded: true });
      releaseStale();
      await expect(stale).rejects.toMatchObject({ code: "WRITE_CONFLICT" });

      expect(remoteBodies).toHaveLength(1);
      const state = await pool.query<{
        status: string;
        attempt_count: number;
        runner_request_generation: number;
        admissions: string;
        outcomes: string;
        failed_events: string;
      }>(
        `select j.status, j.attempt_count, j.runner_request_generation,
                (select count(*)::text from code_submission s
                  where s.user_id = i.user_id
                    and s.submission_type = 'assessment_correction_regrade') admissions,
                (select count(*)::text from assessment_regrade_outcome o
                  where o.correction_id = j.correction_id) outcomes,
                (select count(*)::text from assessment_correction_event e
                  where e.correction_id = j.correction_id and e.event = 'regrade_failed') failed_events
           from assessment_regrade_job j
           join assessment_correction_impact i on i.id = j.impact_id
          where j.id = $1`,
        [job.id],
      );
      expect(state.rows[0]).toEqual({
        status: "succeeded",
        attempt_count: 4,
        runner_request_generation: 1,
        admissions: "1",
        outcomes: "1",
        failed_events: "0",
      });
      const recoveryEvent = await pool.query<{ evidence: Record<string, unknown> }>(
        `select evidence from assessment_correction_event
          where correction_id = $1
            and reason = 'Expired worker lease retained for exact same-generation runner admission reconciliation.'`,
        [created.id],
      );
      expect(recoveryEvent.rows).toHaveLength(1);
      expect(recoveryEvent.rows[0]?.evidence).toMatchObject({
        expiredLeaseAttempt: 3,
        runnerRequestGeneration: 1,
        reconciliation: "same_runner_request_generation",
      });
    } finally {
      releaseStale();
      await stale?.catch(() => undefined);
      vi.unstubAllGlobals();
      if (previousRunnerUrl === undefined) delete process.env.RUNNER_BASE_URL;
      else process.env.RUNNER_BASE_URL = previousRunnerUrl;
      if (previousRunnerSecret === undefined) delete process.env.RUNNER_SHARED_SECRET;
      else process.env.RUNNER_SHARED_SECRET = previousRunnerSecret;
    }
  });

  it("prevents a reclaimed stale correction worker from writing outcome, mastery, or failure state", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000042",
      expectedVersion: 1,
      reason: "Queue a correction and prove a reclaimed lease fences the stale worker's official writes.",
      now: NOW,
    });
    let current = new Date(NOW.getTime() + 20_000);
    const clock = () => new Date(current);
    let releaseFirst!: (value: ExamRunnerResult) => void;
    let firstInput!: RegradeExecutionInput;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const first = processOneAssessmentRegrade({
      workerId: "integration-stale-worker",
      correctionId: created.id,
      executor: { execute: async (input) => {
        firstInput = input;
        signalStarted();
        return new Promise<ExamRunnerResult>((resolve) => { releaseFirst = resolve; });
      } },
      now: current,
      clock,
    });
    await started;

    current = new Date(current.getTime() + 11 * 60_000);
    const winnerInputs: RegradeExecutionInput[] = [];
    const winner = await processOneAssessmentRegrade({
      workerId: "integration-reclaim-worker",
      correctionId: created.id,
      executor: { execute: async (input) => {
        winnerInputs.push(input);
        return passingResult(input);
      } },
      now: current,
      clock,
    });
    expect(winner).toMatchObject({ processed: true, succeeded: true });
    releaseFirst(passingResult(firstInput));
    await expect(first).rejects.toMatchObject({ code: "WRITE_CONFLICT" });

    expect(firstInput).toMatchObject({ jobAttemptCount: 1, runnerRequestGeneration: 1 });
    expect(winnerInputs[0]).toMatchObject({ jobAttemptCount: 2, runnerRequestGeneration: 1 });
    const state = await pool.query<{
      outcomes: string;
      adjustments: string;
      failures: string;
      notifications: string;
      status: string;
      attempt_count: number;
      runner_request_generation: number;
    }>(
      `select
        (select count(*)::text from assessment_regrade_outcome where correction_id = $1) outcomes,
        (select count(*)::text from assessment_mastery_adjustment m
          join assessment_regrade_outcome o on o.id = m.outcome_id where o.correction_id = $1) adjustments,
        (select count(*)::text from assessment_correction_event
          where correction_id = $1 and event = 'regrade_failed') failures,
        (select count(*)::text from notification
          where user_id = $2 and type = 'assessment-corrected') notifications,
        j.status,j.attempt_count,j.runner_request_generation
       from assessment_regrade_job j where j.correction_id = $1`,
      [created.id, LEARNER_ID],
    );
    expect(state.rows[0]).toEqual({
      outcomes: "1",
      adjustments: "1",
      failures: "0",
      notifications: "1",
      status: "succeeded",
      attempt_count: 2,
      runner_request_generation: 1,
    });
  });

  it("does not move a correction beyond three durable determinate failures even after many lease attempts", async () => {
    await seedScenario();
    const created = await createAssessmentCorrection(createInput());
    await queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000030",
      expectedVersion: 1,
      reason: "Create the bounded correction job before simulating an exhausted reviewed retry.",
      now: NOW,
    });
    await pool.query(
      `update assessment_regrade_job set attempt_count = 6 where correction_id = $1`,
      [created.id],
    );
    const failureExecutor: RegradeExecutor = {
      execute: async (input) => ({
        ...passingResult(input),
        imageDigest: `sha256:${"f".repeat(64)}`,
      }),
    };
    for (let determinateAttempt = 1; determinateAttempt <= 3; determinateAttempt += 1) {
      const failureNow = new Date(NOW.getTime() + determinateAttempt * 10_000);
      await expect(processOneAssessmentRegrade({
        workerId: `integration-determinate-failure-${determinateAttempt}`,
        correctionId: created.id,
        executor: failureExecutor,
        now: failureNow,
        clock: () => new Date(failureNow),
      })).resolves.toMatchObject({
        processed: true,
        succeeded: false,
        errorCode: "RUNNER_INFRASTRUCTURE_FAILURE",
      });
      if (determinateAttempt < 3) {
        await expect(queueAssessmentCorrection({
          actorUserId: ADMIN_ID,
          correctionId: created.id,
          requestId: `b3000000-0000-4000-8000-00000000003${determinateAttempt + 1}`,
          expectedVersion: determinateAttempt + 1,
          reason: "Retry one independently reviewed determinate failure without charging worker lease recovery.",
          now: new Date(failureNow.getTime() + 1_000),
        })).resolves.toMatchObject({ status: "queued" });
      }
    }
    await expect(queueAssessmentCorrection({
      actorUserId: ADMIN_ID,
      correctionId: created.id,
      requestId: "b3000000-0000-4000-8000-000000000031",
      expectedVersion: 4,
      reason: "Attempt an exhausted retry and prove the correction cannot enter a false queued state.",
      now: new Date(NOW.getTime() + 60_000),
    })).rejects.toMatchObject({ code: "RETRY_LIMIT_EXHAUSTED" });
    const state = await pool.query<{
      correction_status: string;
      job_status: string;
      attempts: number;
      failures: string;
    }>(
      `select c.status correction_status, j.status job_status, j.attempt_count attempts,
              (select count(*)::text from assessment_correction_event e
                where e.correction_id = c.id and e.event = 'regrade_failed') failures
         from assessment_correction c
         join assessment_regrade_job j on j.correction_id = c.id
        where c.id = $1`,
      [created.id],
    );
    expect(state.rows[0]).toEqual({
      correction_status: "failed",
      job_status: "failed",
      attempts: 9,
      failures: "3",
    });
    const failureEvidence = await pool.query<{ evidence: Record<string, unknown> }>(
      `select evidence from assessment_correction_event
        where correction_id = $1 and event = 'regrade_failed'
        order by occurred_at, id`,
      [created.id],
    );
    expect(failureEvidence.rows.map(({ evidence }) => ({
      lease: evidence.leaseAttemptNumber,
      determinate: evidence.determinateAttemptNumber,
      retryAllowed: evidence.retryAllowed,
    }))).toEqual([
      { lease: 7, determinate: 1, retryAllowed: true },
      { lease: 8, determinate: 2, retryAllowed: true },
      { lease: 9, determinate: 3, retryAllowed: false },
    ]);
  });
});
