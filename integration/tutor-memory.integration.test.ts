import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadTutorStructuredMemory, TUTOR_MEMORY_LIMITS } from "@/lib/ai/tutor-memory";
import { pool } from "@/lib/db/client";
import { resetDisposableIntegrationDatabase } from "./support/reset-disposable-database";

const LEARNER = "tutor-memory-learner";
const OTHER = "tutor-memory-other";
const COURSE = "61000000-0000-4000-8000-000000000001";
const VERSION = "62000000-0000-4000-8000-000000000001";
const ENROLLMENT = "63000000-0000-4000-8000-000000000001";
const OTHER_ENROLLMENT = "63000000-0000-4000-8000-000000000002";
const CONCEPT = "64000000-0000-4000-8000-000000000001";
const ACTIVE_THREAD = "65000000-0000-4000-8000-000000000001";
const ARCHIVED_THREAD = "65000000-0000-4000-8000-000000000002";
const OTHER_THREAD = "65000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-07-12T10:00:00.000Z");
const FAKE_OPENAI_KEY = ["sk", "-", "abcdefghijklmnopqrstuvwxyz123456"].join("");

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Tutor memory integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  await resetDisposableIntegrationDatabase(pool);
}

function envelope(itemVariantId: string, tags: string[]) {
  return JSON.stringify({
    version: 1,
    origin: "deterministic_spec",
    skillId: "python.values.scalars",
    itemVariantId,
    evidenceLevel: "E3",
    assistanceLevel: "A0",
    correct: false,
    learningOpportunity: true,
    solutionRevealed: false,
    misconceptionTags: tags,
    languageContext: "python",
  });
}

async function seed() {
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status,email_verified,two_factor_enabled,created_at,updated_at)
     values
       ($1,'60000000-0000-4000-8000-000000000001','Asha','asha-memory@integration.invalid','learner','active',true,true,$3,$3),
       ($2,'60000000-0000-4000-8000-000000000002','Other','other-memory@integration.invalid','learner','active',true,true,$3,$3)`,
    [LEARNER, OTHER, NOW],
  );
  await pool.query(
    `insert into course (id,slug,title,summary,domain,created_at,updated_at)
     values ($1,'python','Python','Python course','programming',$2,$2)`,
    [COURSE, NOW],
  );
  await pool.query(
    `insert into course_version
      (id,course_id,version,stage,scope_statement,content_hash,publication_revision,created_at,updated_at)
     values ($1,$2,'0.1.0','beta','Integration scope',$3,1,$4,$4)`,
    [VERSION, COURSE, "a".repeat(64), NOW],
  );
  await pool.query(
    `insert into enrollment (id,user_id,course_version_id,implementation_language,status,source,started_at,created_at,updated_at)
     values ($1,$3,$5,'python','active','self',$6,$6,$6),($2,$4,$5,'python','active','self',$6,$6,$6)`,
    [ENROLLMENT, OTHER_ENROLLMENT, LEARNER, OTHER, VERSION, NOW],
  );
  await pool.query(
    `insert into concept (id,slug,title,domain,description,critical,created_at,updated_at)
     values ($1,'python.values.scalars','Scalar values','python','Names and scalar values',true,$2,$2)`,
    [CONCEPT, NOW],
  );
  await pool.query(
    `insert into concept_mastery
      (user_id,enrollment_id,concept_id,language_context,score,confidence,status,critical_requirements_met,
       last_evidence_at,last_practiced_at,policy_version,row_version,created_at,updated_at)
     values
      ($1,$2,$3,'python',0.64,0.72,'practicing',false,$5,$5,'learning-v1',3,$5,$5),
      ($4,$6,$3,'python',0.99,0.99,'mastered',true,$5,$5,'learning-v1',2,$5,$5)`,
    [LEARNER, ENROLLMENT, CONCEPT, OTHER, NOW, OTHER_ENROLLMENT],
  );
  const evidenceRows = [
    ["66000000-0000-4000-8000-000000000001", LEARNER, ENROLLMENT, envelope("variant-a", ["assignment.equality"]), "valid", "target-a"],
    ["66000000-0000-4000-8000-000000000002", LEARNER, ENROLLMENT, envelope("variant-b", ["assignment.equality"]), "valid", "target-b"],
    ["66000000-0000-4000-8000-000000000003", LEARNER, ENROLLMENT, envelope("variant-invalid", ["invalid.must-not-appear"]), "invalidated", "invalid"],
    ["66000000-0000-4000-8000-000000000004", OTHER, OTHER_ENROLLMENT, envelope("variant-other-a", ["other.private"]), "valid", "other-a"],
    ["66000000-0000-4000-8000-000000000005", OTHER, OTHER_ENROLLMENT, envelope("variant-other-b", ["other.private"]), "valid", "other-b"],
  ] as const;
  for (const [id, userId, enrollmentId, evidenceType, validity, sourceId] of evidenceRows) {
    await pool.query(
      `insert into mastery_evidence
       (id,user_id,enrollment_id,concept_id,language_context,evidence_type,source_type,source_id,score,weight,
        critical_criterion,validity,policy_version,recorded_by,recorded_at)
       values ($1,$2,$3,$4,'python',$5,'deterministic_attempt',$6,0,1,'core',$7,'learning-v1','adaptive-deterministic-engine',$8)`,
      [id, userId, enrollmentId, CONCEPT, evidenceType, sourceId, validity, NOW],
    );
  }
  const outboxClient = await pool.connect();
  const outboxRows = [
    {
      id: "67000000-0000-4000-8000-000000000001",
      operationId: "67100000-0000-4000-8000-000000000001",
      userId: LEARNER,
      recipient: "asha-memory@integration.invalid",
      variables: JSON.stringify({ summary: "Older summary" }),
      authoritySha256: "b04c397be415650a1bf513e37c4dfa64bd98b80dbaa2c538851b55ccab80ba66",
    },
    {
      id: "67000000-0000-4000-8000-000000000002",
      operationId: "67100000-0000-4000-8000-000000000002",
      userId: LEARNER,
      recipient: "asha-memory@integration.invalid",
      variables: JSON.stringify({ summary: `Latest owner summary. token: ${FAKE_OPENAI_KEY}` }),
      authoritySha256: "c52cdc5a21700cf40ffd1934f8da7a564b216a2c6e1563b144df5803410e048c",
    },
    {
      id: "67000000-0000-4000-8000-000000000003",
      operationId: "67100000-0000-4000-8000-000000000003",
      userId: OTHER,
      recipient: "other-memory@integration.invalid",
      variables: JSON.stringify({ summary: "OTHER-SUMMARY-SENTINEL" }),
      authoritySha256: "53a3d96d2de01a41a5e87bd1ecba4ece9c78c29bd6595d343707516dd10329d1",
    },
  ] as const;
  try {
    await outboxClient.query("begin");
    for (const row of outboxRows) {
      await outboxClient.query(
        `insert into email_outbox
          (id,operation_id,user_id,delivery_scope_key,to_email,template,template_version,variables,
           idempotency_key,idempotency_authority_version,status)
         values ($1::uuid,$2::uuid,$3,'a:' || $3,$4,'weekly-summary','1',$5::jsonb,$6,'event-v1-native','pending')`,
        [row.id, row.operationId, row.userId, row.recipient, row.variables, row.authoritySha256],
      );
      await outboxClient.query(
        `select released.release_receipt_sha256
           from public.release_email_outbox_delivery(
             $1::uuid,
             $2::uuid,
             $3,
             (
               select outbox.idempotency_original_payload_sha256
                 from public.email_outbox as outbox
                where outbox.id = $1::uuid
             ),
             'task7-v1'
           ) as released`,
        [row.id, row.operationId, row.authoritySha256],
      );
    }
    await outboxClient.query("commit");
  } catch (error) {
    await outboxClient.query("rollback");
    throw error;
  } finally {
    outboxClient.release();
  }
  await pool.query(
    `insert into chat_thread (id,user_id,title,status,created_at,updated_at)
     values ($1,$4,'Active memory','active',$6,$6),($2,$4,'Archived memory','archived',$6,$6),
            ($3,$5,'Other memory','active',$6,$6)`,
    [ACTIVE_THREAD, ARCHIVED_THREAD, OTHER_THREAD, LEARNER, OTHER, NOW],
  );
  for (let index = 0; index < 9; index += 1) {
    const id = `68000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const content = index === 8
      ? `newest owner message password: hunter2 ${"x".repeat(2_000)}`
      : `owner-tail-${index} ${"y".repeat(900)}`;
    await pool.query(
      `insert into chat_message (id,thread_id,role,content,curriculum_refs,safety_labels,created_at)
       values ($1,$2,$3,$4,'[]'::jsonb,'[]'::jsonb,$5)`,
      [id, ACTIVE_THREAD, index % 2 ? "assistant" : "user", content, new Date(NOW.getTime() + index * 1_000)],
    );
  }
  await pool.query(
    `insert into chat_message (id,thread_id,role,content,curriculum_refs,safety_labels,created_at)
     values
      ('69000000-0000-4000-8000-000000000001',$1,'user','ARCHIVED-TAIL-SENTINEL','[]'::jsonb,'[]'::jsonb,$3),
      ('69000000-0000-4000-8000-000000000002',$2,'user','OTHER-TAIL-SENTINEL','[]'::jsonb,'[]'::jsonb,$3)`,
    [ARCHIVED_THREAD, OTHER_THREAD, NOW],
  );
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL tutor structured memory", () => {
  it("uses owner/current-skill persisted mastery, valid deterministic misconceptions, and latest owner summary for a new thread", async () => {
    const memory = await loadTutorStructuredMemory({
      userId: LEARNER,
      skillId: "python.values.scalars",
      preferredLanguage: "python",
    });
    expect(memory.currentConcept).toMatchObject({ mastery: 0.64, confidence: 0.72, status: "practicing", persisted: true });
    expect(memory.activeMisconceptionTags).toEqual(["assignment.equality"]);
    expect(memory.recentRelevantSummary?.text).toContain("Latest owner summary");
    expect(memory.selectedThreadTail).toBeNull();
    const serialized = JSON.stringify(memory);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("OTHER-");
    expect(serialized).not.toContain("invalid.must-not-appear");
  });

  it("resumes with only the bounded owner-active selected tail and excludes archived/other/raw history", async () => {
    const resumed = await loadTutorStructuredMemory({
      userId: LEARNER,
      skillId: "python.values.scalars",
      preferredLanguage: "python",
      selectedThreadId: ACTIVE_THREAD,
    });
    expect(resumed.selectedThreadTail?.messages.length).toBeLessThanOrEqual(TUTOR_MEMORY_LIMITS.threadMessages);
    expect(resumed.selectedThreadTail?.messages.reduce((sum, item) => sum + item.content.length, 0))
      .toBeLessThanOrEqual(TUTOR_MEMORY_LIMITS.threadTotalChars);
    expect(resumed.selectedThreadTail?.truncated).toBe(true);
    expect(resumed.selectedThreadTail?.messages.at(-1)?.content).toContain("newest owner message");
    expect(JSON.stringify(resumed)).not.toContain("hunter2");
    expect(JSON.stringify(resumed)).not.toContain("owner-tail-0");

    const archived = await loadTutorStructuredMemory({
      userId: LEARNER,
      skillId: "python.values.scalars",
      preferredLanguage: "python",
      selectedThreadId: ARCHIVED_THREAD,
    });
    const crossOwner = await loadTutorStructuredMemory({
      userId: LEARNER,
      skillId: "python.values.scalars",
      preferredLanguage: "python",
      selectedThreadId: OTHER_THREAD,
    });
    expect(archived.selectedThreadTail).toBeNull();
    expect(crossOwner.selectedThreadTail).toBeNull();
    expect(JSON.stringify([archived, crossOwner])).not.toContain("SENTINEL");
  });
});
