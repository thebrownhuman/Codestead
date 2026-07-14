import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { listOwnTrophyCabinet } from "@/lib/achievements/trophy-cabinet";
import { FileSystemContentLoader } from "@/lib/content/loader";
import { pool } from "@/lib/db/client";
import { buildModuleProjectCatalog, type ModuleProjectBrief } from "@/lib/projects/module-project-catalog";
import {
  listLearnerModuleProjects,
  startModuleProject,
  transitionModuleProjectTemplate,
} from "@/lib/projects/module-project-service";

const ADMIN = "module-project-admin";
const LEARNER = "module-project-learner";
const OTHER = "module-project-other";
const COURSE = "71000000-0000-4000-8000-000000000001";
const VERSION = "71000000-0000-4000-8000-000000000002";
const ENROLLMENT = "71000000-0000-4000-8000-000000000003";
const OTHER_ENROLLMENT = "71000000-0000-4000-8000-000000000004";
const TEMPLATE = "71000000-0000-4000-8000-000000000005";
const ATTEMPT = "71000000-0000-4000-8000-000000000006";
const ACHIEVEMENT = "71000000-0000-4000-8000-000000000007";
const USER_ACHIEVEMENT = "71000000-0000-4000-8000-000000000008";
const ARTIFACT = "71000000-0000-4000-8000-000000000009";
const RELEASE = "71000000-0000-4000-8000-000000000010";
const HASH = "a".repeat(64);
const NOW = new Date("2026-07-14T12:00:00.000Z");
const loader = new FileSystemContentLoader({ contentRoot: path.join(process.cwd(), "content") });
let brief: ModuleProjectBrief;

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Module-project integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const tables = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema='public' and table_type='BASE TABLE'`);
  const names = tables.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(",");
  if (names) await pool.query(`truncate table ${names} restart identity cascade`);
}

function planFor(projectBrief: ModuleProjectBrief) {
  return projectBrief.prerequisiteSkillIds.map((skillId, position) => ({
    id: `plan-${position + 1}`,
    position: position + 1,
    trackId: projectBrief.courseId,
    courseVersion: projectBrief.courseVersion,
    moduleId: projectBrief.moduleId,
    skillId,
  }));
}

async function seed() {
  brief = buildModuleProjectCatalog(await loader.loadSnapshot())
    .find((item) => item.courseId === "python")!;
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status)
     values ($1,$2,'Project Learner','project-learner@integration.invalid','learner','active'),
            ($3,$4,'Other Learner','project-other@integration.invalid','learner','active'),
            ($5,$6,'Project Admin','project-admin@integration.invalid','admin','active')`,
    [
      LEARNER, "72000000-0000-4000-8000-000000000001",
      OTHER, "72000000-0000-4000-8000-000000000002",
      ADMIN, "72000000-0000-4000-8000-000000000003",
    ],
  );
  await pool.query(
    `insert into course (id,slug,title,summary,domain)
     values ($1,$2,$3,'Disposable exact-version project course.','programming')`,
    [COURSE, brief.courseId, brief.courseTitle],
  );
  await pool.query(
    `insert into course_version
      (id,course_id,version,stage,scope_statement,content_hash,approved_by,published_at,publication_revision)
     values ($1,$2,$3,'beta','Disposable reviewed project scope.',$4,$5,$6,1)`,
    [VERSION, COURSE, brief.courseVersion, HASH, ADMIN, NOW],
  );
  await pool.query(
    `insert into curriculum_artifact
      (id,course_version_id,artifact_key,artifact_type,source_path,content,content_hash,publication_stage,ai_assisted,provenance,review_status,row_version)
     values ($1,$2,'module-project.fixture','authored_lesson','integration/module-project.json','{}'::jsonb,$3,'published',false,'{}'::jsonb,'approved',1)`,
    [ARTIFACT, VERSION, HASH],
  );
  await pool.query(
    `insert into curriculum_release_evidence
      (id,course_version_id,submitted_by,request_id,evidence_version,content_hash,evidence,evidence_hash,created_at)
     values ($1,$2,$3,$4,1,$5,'{}'::jsonb,$6,$7)`,
    [RELEASE, VERSION, ADMIN, "71000000-0000-4000-8000-000000000011", HASH, "b".repeat(64), NOW],
  );
  await pool.query(
    `insert into curriculum_publication_pointer
      (course_id,current_course_version_id,row_version,updated_by,reason,updated_at)
     values ($1,$2,1,$3,'Disposable reviewed publication pointer.',$4)`,
    [COURSE, VERSION, ADMIN, NOW],
  );
  await pool.query(
    `insert into enrollment (id,user_id,course_version_id,status,source,started_at)
     values ($1,$2,$3,'active','self',$4),($5,$6,$3,'active','self',$4)`,
    [ENROLLMENT, LEARNER, VERSION, NOW, OTHER_ENROLLMENT, OTHER],
  );
  await pool.query(
    `insert into plan_revision (enrollment_id,revision,source,reason,policy_version,plan,created_at)
     values ($1,1,'system','Initial exact module plan.','plan-v1',$2::jsonb,$4),
            ($3,1,'system','Other learner exact module plan.','plan-v1',$2::jsonb,$4)`,
    [ENROLLMENT, JSON.stringify(planFor(brief)), OTHER_ENROLLMENT, NOW],
  );
  await pool.query(
    `insert into module_project_template
      (id,course_version_id,module_key,template_key,template_version,source_course_content_hash,
       content_hash,title,brief,stage,row_version,created_at,updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'draft',1,$10,$10)`,
    [TEMPLATE, VERSION, brief.moduleId, brief.templateKey, brief.templateVersion, HASH,
      brief.contentHash, brief.title, JSON.stringify(brief), NOW],
  );
}

async function addIndependentMastery(userId = LEARNER, enrollmentId = ENROLLMENT) {
  await pool.query(
    `insert into attempt
      (id,user_id,enrollment_id,kind,status,policy_version,content_version,score,passed,mastery_awarded,
       assistance_level,solution_revealed,started_at,submitted_at,graded_at)
     values ($1,$2,$3,'exam','graded','exam-v1',$4,0.95,true,true,'A0',false,$5,$5,$5)`,
    [ATTEMPT, userId, enrollmentId, `${brief.courseId}@${brief.courseVersion}`, NOW],
  );
  await pool.query(
    `insert into achievement (id,slug,title,description,icon,rule_version,rule)
     values ($1,'module-project-integration-mastery',$2,'Independent 95 percent mastery evidence.','medal','exam-mastery-v1',$3::jsonb)`,
    [ACHIEVEMENT, `Mastery: ${brief.moduleTitle}`, JSON.stringify({
      event: "exam_mastery",
      courseId: brief.courseId,
      moduleId: brief.moduleId,
      minimumScorePercent: 95,
      criticalRequirementsRequired: true,
    })],
  );
  await pool.query(
    `insert into user_achievement (id,user_id,achievement_id,evidence_id,visibility,awarded_at)
     values ($1,$2,$3,$4,'private',$5)`,
    [USER_ACHIEVEMENT, userId, ACHIEVEMENT, `exam-attempt:${ATTEMPT}`, NOW],
  );
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seed();
});

afterAll(async () => { await pool.end(); });

describe("module projects and trophy evidence in real PostgreSQL", () => {
  it("requires human publication, an exact plan, and independent mastery before idempotent start", async () => {
    expect((await listLearnerModuleProjects(LEARNER))[0]).toMatchObject({ state: "draft" });
    await expect(startModuleProject({
      userId: LEARNER, templateId: TEMPLATE,
      requestId: "73000000-0000-4000-8000-000000000001", now: NOW,
    })).rejects.toMatchObject({ code: "PUBLICATION_GATE_FAILED" });
    await expect(pool.query(
      `update module_project_template
          set stage='beta',reviewed_by_user_id=$2,reviewed_at=$3,published_at=$3,
              row_version=row_version+1,updated_at=$3 where id=$1`,
      [TEMPLATE, ADMIN, NOW],
    )).rejects.toMatchObject({ code: "P0001" });
    expect((await pool.query<{ stage: string }>("select stage from module_project_template where id=$1", [TEMPLATE])).rows[0]?.stage).toBe("draft");

    const decision = {
      actorUserId: ADMIN,
      templateId: TEMPLATE,
      requestId: "73000000-0000-4000-8000-000000000002",
      targetStage: "beta" as const,
      expectedVersion: 1,
      reason: "Human reviewer checked scenario, milestones, and all acceptance boundaries.",
      now: NOW,
    };
    expect(await transitionModuleProjectTemplate(decision)).toMatchObject({ stage: "beta", rowVersion: 2, replayed: false });
    expect(await transitionModuleProjectTemplate(decision)).toMatchObject({ stage: "beta", rowVersion: 2, replayed: true });
    expect((await listLearnerModuleProjects(LEARNER))[0]).toMatchObject({ state: "mastery_locked" });
    await expect(startModuleProject({
      userId: LEARNER, templateId: TEMPLATE,
      requestId: "73000000-0000-4000-8000-000000000003", now: NOW,
    })).rejects.toMatchObject({ code: "MASTERY_GATE_FAILED" });

    await addIndependentMastery();
    expect((await listLearnerModuleProjects(LEARNER))[0]).toMatchObject({ state: "ready" });
    const input = {
      userId: LEARNER, templateId: TEMPLATE,
      requestId: "73000000-0000-4000-8000-000000000004", now: NOW,
    };
    const started = await startModuleProject(input);
    expect(started).toMatchObject({ replayed: false, reusedExisting: false });
    expect(await startModuleProject(input)).toMatchObject({ project: { id: started.project.id }, replayed: true });
    expect(await startModuleProject({ ...input, requestId: "73000000-0000-4000-8000-000000000005" }))
      .toMatchObject({ project: { id: started.project.id }, replayed: false, reusedExisting: true });
    expect((await pool.query<{ count: string }>("select count(*)::text count from project where assignment_template_id=$1", [TEMPLATE])).rows[0]?.count).toBe("1");
    expect((await pool.query<{ count: string }>("select count(*)::text count from module_project_start_receipt where user_id=$1", [LEARNER])).rows[0]?.count).toBe("2");
    expect((await pool.query<{ count: string }>("select count(*)::text count from reward_ledger where user_id=$1", [LEARNER])).rows[0]?.count).toBe("0");
  });

  it("fails closed on cross-owner starts, direct DB bypass, duplicates, and provenance mutation", async () => {
    await transitionModuleProjectTemplate({
      actorUserId: ADMIN, templateId: TEMPLATE,
      requestId: "74000000-0000-4000-8000-000000000001", targetStage: "beta",
      expectedVersion: 1, reason: "Human reviewer inspected all solution-free project evidence and boundaries.", now: NOW,
    });
    await addIndependentMastery();
    await expect(startModuleProject({
      userId: OTHER, templateId: TEMPLATE,
      requestId: "74000000-0000-4000-8000-000000000002", now: NOW,
    })).rejects.toMatchObject({ code: "MASTERY_GATE_FAILED" });
    const provenance = {
      schemaVersion: 1, policyVersion: "module-project-start-2026-07-14.v1",
      templateId: TEMPLATE, templateKey: brief.templateKey, templateVersion: brief.templateVersion,
      templateContentHash: brief.contentHash, templateStage: "beta", courseVersionId: VERSION,
      courseVersion: brief.courseVersion, courseContentHash: HASH,
      courseId: brief.courseId, moduleId: brief.moduleId, directAwardPolicy: "none",
    };
    await expect(pool.query(
      `insert into project
        (user_id,title,summary,status,visibility,prd,assignment_template_id,
         assignment_content_hash,assignment_stage_at_start,assignment_provenance)
       values ($1,'Bypass','Must fail.','idea','private',$2::jsonb,$3,$4,'beta',$5::jsonb)`,
      [OTHER, JSON.stringify({ version: "module-project-1.0" }), TEMPLATE, brief.contentHash, JSON.stringify(provenance)],
    )).rejects.toMatchObject({ code: "P0001" });

    const started = await startModuleProject({
      userId: LEARNER, templateId: TEMPLATE,
      requestId: "74000000-0000-4000-8000-000000000003", now: NOW,
    });
    await expect(pool.query(
      "update project set assignment_content_hash=$2 where id=$1",
      [started.project.id, "f".repeat(64)],
    )).rejects.toMatchObject({ code: "P0001" });
    await expect(pool.query(
      `insert into project
        (user_id,title,summary,status,visibility,prd,assignment_template_id,
         assignment_content_hash,assignment_stage_at_start,assignment_provenance)
       select user_id,'Duplicate','Must fail.','idea','private',prd,assignment_template_id,
              assignment_content_hash,assignment_stage_at_start,assignment_provenance
         from project where id=$1`,
      [started.project.id],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("shows only exact evidence trophies and preserves revocation truth", async () => {
    await addIndependentMastery();
    const earned = await listOwnTrophyCabinet(LEARNER);
    expect(earned.trophies).toHaveLength(1);
    expect(earned.trophies[0]).toMatchObject({ kind: "module_mastery", status: "earned", visibility: "private" });
    await pool.query("update user_achievement set revoked_at=$2 where id=$1", [USER_ACHIEVEMENT, NOW]);
    const revoked = await listOwnTrophyCabinet(LEARNER);
    expect(revoked.trophies[0]).toMatchObject({ status: "revoked" });
    expect(revoked.summary).toEqual({ earned: 0, revoked: 1, shared: 0 });
  });
});
