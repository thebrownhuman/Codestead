import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { mutateCareerCard, listLearnerCareerRecommendations } from "@/lib/career/service";
import { issueCourseCertificate, loadPublicCertificate, revokeCourseCertificate } from "@/lib/certificates/service";
import { createLearnerExport } from "@/lib/data-lifecycle/export";
import { pool } from "@/lib/db/client";
import { loadPublicPortfolio, updatePublicPortfolio } from "@/lib/portfolio/service";

const LEARNER = "milestone-integration-learner";
const OTHER = "milestone-integration-other";
const ADMIN = "milestone-integration-admin";
const COURSE = "61000000-0000-4000-8000-000000000001";
const VERSION = "61000000-0000-4000-8000-000000000002";
const MODULE = "61000000-0000-4000-8000-000000000003";
const LESSON = "61000000-0000-4000-8000-000000000004";
const CONCEPT = "61000000-0000-4000-8000-000000000005";
const ENROLLMENT = "61000000-0000-4000-8000-000000000006";
const OTHER_ENROLLMENT = "61000000-0000-4000-8000-000000000007";
const PROJECT = "61000000-0000-4000-8000-000000000008";
const OTHER_PROJECT = "61000000-0000-4000-8000-000000000009";
const ACHIEVEMENT = "61000000-0000-4000-8000-000000000010";
const USER_ACHIEVEMENT = "61000000-0000-4000-8000-000000000011";
const NOW = new Date("2026-07-14T12:00:00.000Z");

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Milestone integration tests require the disposable learncoding_integration database.");
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

async function seedEligibleLearningEvidence() {
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status)
     values ($1,$2,'Milestone Learner','milestone-learner@integration.invalid','learner','active'),
            ($3,$4,'Other Learner','milestone-other@integration.invalid','learner','active'),
            ($5,$6,'Milestone Admin','milestone-admin@integration.invalid','admin','active')`,
    [
      LEARNER, "62000000-0000-4000-8000-000000000001",
      OTHER, "62000000-0000-4000-8000-000000000002",
      ADMIN, "62000000-0000-4000-8000-000000000003",
    ],
  );
  await pool.query(
    "insert into course (id,slug,title,summary,domain) values ($1,'milestone-python','Milestone Python','Verified disposable milestone course.','programming')",
    [COURSE],
  );
  await pool.query(
    `insert into course_version
      (id,course_id,version,stage,scope_statement,content_hash,approved_by,published_at,publication_revision)
     values ($1,$2,'1.0.0','verified','Verified disposable scope.',$3,$4,$5,1)`,
    [VERSION, COURSE, "a".repeat(64), ADMIN, NOW],
  );
  await pool.query(
    `insert into course_module (id,course_version_id,slug,title,objective,position,estimated_minutes)
     values ($1,$2,'foundations','Foundations','Master one critical concept.',1,30)`,
    [MODULE, VERSION],
  );
  await pool.query(
    `insert into lesson (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status)
     values ($1,$2,'variables','Variables','Use variables correctly.',20,'beginner',1,'verified')`,
    [LESSON, MODULE],
  );
  await pool.query(
    `insert into concept (id,slug,title,domain,description,critical)
     values ($1,'milestone.variables','Variables','programming','Critical variable semantics.',true)`,
    [CONCEPT],
  );
  await pool.query("insert into lesson_concept (lesson_id,concept_id,coverage,weight) values ($1,$2,'primary',1)", [LESSON, CONCEPT]);
  await pool.query(
    `insert into curriculum_artifact
      (id,course_version_id,artifact_key,artifact_type,source_path,content,content_hash,publication_stage,ai_assisted,provenance,review_status,row_version)
     values ($1,$2,'milestone.lesson','authored_lesson','integration/milestone.json','{}'::jsonb,$3,'published',false,'{}'::jsonb,'approved',1)`,
    ["63000000-0000-4000-8000-000000000001", VERSION, "a".repeat(64)],
  );
  await pool.query(
    `insert into curriculum_release_evidence
      (id,course_version_id,submitted_by,request_id,evidence_version,content_hash,evidence,evidence_hash,created_at)
     values ($1,$2,$3,$4,1,$5,'{}'::jsonb,$6,$7)`,
    [
      "63000000-0000-4000-8000-000000000002", VERSION, ADMIN,
      "63000000-0000-4000-8000-000000000003", "a".repeat(64), "b".repeat(64), NOW,
    ],
  );
  await pool.query(
    `insert into curriculum_publication_pointer
      (course_id,current_course_version_id,row_version,updated_by,reason,updated_at)
     values ($1,$2,1,$3,'Verified disposable publication pointer.',$4)`,
    [COURSE, VERSION, ADMIN, NOW],
  );
  await pool.query(
    `insert into enrollment (id,user_id,course_version_id,status,source,started_at,completed_at)
     values ($1,$2,$3,'completed','self',$4,$4),($5,$6,$3,'active','self',$4,null)`,
    [ENROLLMENT, LEARNER, VERSION, NOW, OTHER_ENROLLMENT, OTHER],
  );
  await pool.query(
    `insert into concept_mastery
      (user_id,enrollment_id,concept_id,language_context,score,confidence,status,critical_requirements_met,last_evidence_at,policy_version,row_version)
     values ($1,$2,$3,'python',1,1,'mastered',true,$4,'mastery-v1',1)`,
    [LEARNER, ENROLLMENT, CONCEPT, NOW],
  );
  await pool.query(
    `insert into mastery_evidence
      (id,user_id,enrollment_id,concept_id,language_context,evidence_type,source_type,source_id,score,weight,critical_criterion,validity,policy_version,recorded_at)
     values ($1,$2,$3,$4,'python','assessment','attempt','milestone-attempt',1,1,'variables-critical','valid','mastery-v1',$5)`,
    ["63000000-0000-4000-8000-000000000004", LEARNER, ENROLLMENT, CONCEPT, NOW],
  );
  await pool.query(
    `insert into project (id,user_id,title,summary,status,visibility,github_url)
     values ($1,$2,'Public Python project','A learner-selected public project.','reviewed','private','https://github.com/safe/project'),
            ($3,$4,'Other private project','Must never be selectable by another learner.','reviewed','private','https://github.com/other/project')`,
    [PROJECT, LEARNER, OTHER_PROJECT, OTHER],
  );
  await pool.query(
    `insert into achievement (id,slug,title,description,icon,rule_version,rule)
     values ($1,'milestone-python-complete','Python complete','Verified completion evidence.','award','1','{}'::jsonb)`,
    [ACHIEVEMENT],
  );
  await pool.query(
    `insert into user_achievement (id,user_id,achievement_id,evidence_id,visibility,awarded_at)
     values ($1,$2,$3,'milestone-evidence','private',$4)`,
    [USER_ACHIEVEMENT, LEARNER, ACHIEVEMENT, NOW],
  );
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seedEligibleLearningEvidence();
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL milestone integrity", () => {
  it("publishes only reviewed career guidance and rejects incomplete market provenance", async () => {
    await expect(pool.query(
      `insert into career_card
        (slug,path,technology,title,summary,future_scope,status,authored_by,market_claim,row_version)
       values ('bad-market','backend','Java','Bad market card','A sufficiently long summary for this invalid row.',
               'A sufficiently long future scope for this invalid row.','published',$1,'Unsourced demand claim',1)`,
      [ADMIN],
    )).rejects.toMatchObject({ code: "23514" });

    const base = {
      actorUserId: ADMIN,
      slug: "python-web-path",
      path: "Web development",
      technology: "Python",
      title: "Build Python web services",
      summary: "Use the verified Python foundation to build progressively larger web services.",
      futureScope: "Continue into HTTP APIs, persistence, testing, deployment, and observable services.",
      prerequisites: [{ courseId: COURSE, rationale: "Complete the verified Python foundation before this path." }],
      market: null,
      reason: "Administrator reviewed the path and its verified prerequisite.",
      now: NOW,
    } as const;
    const created = await mutateCareerCard({
      ...base, requestId: "64000000-0000-4000-8000-000000000001", cardId: null, expectedVersion: 0, action: "save",
    });
    const publishedInput = {
      ...base, requestId: "64000000-0000-4000-8000-000000000002",
      cardId: created.cardId, expectedVersion: 1, action: "publish" as const,
    };
    expect(await mutateCareerCard(publishedInput)).toMatchObject({ event: "published", rowVersion: 2, replayed: false });
    expect(await mutateCareerCard(publishedInput)).toMatchObject({ event: "published", rowVersion: 2, replayed: true });
    await expect(mutateCareerCard({ ...publishedInput, title: "Changed under the same request" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(mutateCareerCard({
      ...base,
      requestId: "64000000-0000-4000-8000-000000000003",
      cardId: created.cardId,
      expectedVersion: 2,
      action: "save",
    })).rejects.toMatchObject({ code: "INVALID_STAGE_TRANSITION" });
    expect((await pool.query<{ status: string; row_version: string }>(
      "select status,row_version::text from career_card where id=$1",
      [created.cardId],
    )).rows[0]).toEqual({ status: "published", row_version: "2" });
    const guidance = await listLearnerCareerRecommendations(LEARNER, NOW);
    expect(guidance.recommendations[0]).toMatchObject({ title: base.title, readiness: "ready" });
  });

  it("serializes certificate issuance, hides cross-owner existence, and appends revocation", async () => {
    await expect(pool.query(
      `insert into course_certificate
        (user_id,enrollment_id,course_version_id,verification_id,learner_display_name,course_title,course_version_label,issue_evidence,evidence_hash,policy_version,issued_at)
       values ($1,$2,$3,$4,'Other Learner','Milestone Python','1.0.0','{}'::jsonb,$5,'test-policy',$6)`,
      [OTHER, OTHER_ENROLLMENT, VERSION, "invalid-incomplete-course-verifier-123456789", "c".repeat(64), NOW],
    )).rejects.toMatchObject({ code: "23514" });

    const [first, second] = await Promise.all([
      issueCourseCertificate({ userId: LEARNER, enrollmentId: ENROLLMENT, requestId: "65000000-0000-4000-8000-000000000001", now: NOW }),
      issueCourseCertificate({ userId: LEARNER, enrollmentId: ENROLLMENT, requestId: "65000000-0000-4000-8000-000000000002", now: NOW }),
    ]);
    expect(first.certificate.id).toBe(second.certificate.id);
    expect((await pool.query<{ count: string }>("select count(*)::text count from course_certificate where enrollment_id=$1", [ENROLLMENT])).rows[0]?.count).toBe("1");
    await expect(issueCourseCertificate({ userId: OTHER, enrollmentId: ENROLLMENT, requestId: "65000000-0000-4000-8000-000000000003", now: NOW }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    const reason = "Verified integrity correction after administrator review";
    const revoked = await revokeCourseCertificate({
      actorUserId: ADMIN, certificateId: first.certificate.id,
      requestId: "65000000-0000-4000-8000-000000000004", reason, now: new Date(NOW.getTime() + 1_000),
    });
    expect(revoked.replayed).toBe(false);
    const publicRecord = await loadPublicCertificate(first.certificate.verificationId);
    expect(publicRecord.status).toBe("revoked");
    expect(JSON.stringify(publicRecord)).not.toContain(reason);
    await expect(pool.query("update course_certificate set course_title='tampered' where id=$1", [first.certificate.id]))
      .rejects.toMatchObject({ code: "55000" });
  });

  it("enforces owner-bound explicit portfolio publication, replay, privacy, and withdrawal", async () => {
    const issued = await issueCourseCertificate({
      userId: LEARNER, enrollmentId: ENROLLMENT,
      requestId: "66000000-0000-4000-8000-000000000001", now: NOW,
    });
    const publishInput = {
      userId: LEARNER,
      requestId: "66000000-0000-4000-8000-000000000002",
      expectedVersion: 0,
      slug: "milestone-learner",
      displayName: "Milestone Learner",
      headline: "Building verified Python projects in public",
      about: "A learner-selected public introduction.",
      publish: true,
      confirmPublicDisclosure: true,
      selectedProjectIds: [PROJECT],
      selectedAchievementIds: [USER_ACHIEVEMENT],
      selectedCertificateIds: [issued.certificate.id],
      now: NOW,
    } as const;
    expect(await updatePublicPortfolio(publishInput)).toMatchObject({ event: "published", rowVersion: 1, replayed: false });
    expect(await updatePublicPortfolio(publishInput)).toMatchObject({ event: "published", rowVersion: 1, replayed: true });
    await expect(updatePublicPortfolio({ ...publishInput, headline: "Different payload under reused request" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(updatePublicPortfolio({
      ...publishInput, requestId: "66000000-0000-4000-8000-000000000003",
      expectedVersion: 1, selectedProjectIds: [OTHER_PROJECT],
    })).rejects.toMatchObject({ code: "INVALID_SELECTION" });
    await expect(pool.query(
      "insert into public_portfolio_project (user_id,project_id,position,created_at) values ($1,$2,2,$3)",
      [LEARNER, OTHER_PROJECT, NOW],
    )).rejects.toMatchObject({ code: expect.stringMatching(/23503|23514/) });

    const publicProfile = await loadPublicPortfolio("milestone-learner");
    expect(publicProfile.projects).toHaveLength(1);
    expect(publicProfile.projects[0]).toMatchObject({
      title: "Public Python project",
      summary: "A learner-selected public project.",
      githubUrl: "https://github.com/safe/project",
    });
    expect(publicProfile.certificates).toHaveLength(1);
    expect(JSON.stringify(publicProfile)).not.toMatch(/@integration\.invalid|mastery-evidence|administrator/i);

    await pool.query(
      `update project set title='Changed after publication',summary='Mutable private project text.',
         github_url='https://github.com/changed/project',updated_at=$2 where id=$1`,
      [PROJECT, new Date(NOW.getTime() + 1_000)],
    );
    const afterPrivateProjectEdit = await loadPublicPortfolio("milestone-learner");
    expect(afterPrivateProjectEdit.projects[0]).toMatchObject({
      title: "Public Python project",
      summary: "A learner-selected public project.",
      githubUrl: "https://github.com/safe/project",
    });
    expect(JSON.stringify(afterPrivateProjectEdit)).not.toContain("Changed after publication");
    expect((await pool.query<{ count: string }>(
      `select count(*)::text count from public_portfolio_project_snapshot
        where user_id=$1 and project_id=$2 and portfolio_version=1`,
      [LEARNER, PROJECT],
    )).rows[0]?.count).toBe("1");
    await expect(pool.query(
      `update public_portfolio_project_snapshot set title='Silent replacement'
        where user_id=$1 and project_id=$2 and portfolio_version=1`,
      [LEARNER, PROJECT],
    )).rejects.toMatchObject({ code: "55000" });

    const exported = await createLearnerExport({
      learnerId: LEARNER,
      actorUserId: ADMIN,
      requestId: "66000000-0000-4000-8000-000000000005",
      maxRecords: 250,
      maxBytes: 512_000,
    });
    const exportLines = (await new Response(exported.stream).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await exported.completion;
    const snapshotExport = exportLines.find((line) => line.category === "publicPortfolioProjectSnapshots");
    expect(snapshotExport).toEqual(expect.objectContaining({
      type: "record",
      category: "publicPortfolioProjectSnapshots",
      data: expect.objectContaining({
        projectId: PROJECT,
        portfolioVersion: 1,
        title: "Public Python project",
        summary: "A learner-selected public project.",
        githubUrl: "https://github.com/safe/project",
      }),
    }));
    expect(JSON.stringify(snapshotExport)).not.toContain("Changed after publication");

    await updatePublicPortfolio({
      ...publishInput,
      requestId: "66000000-0000-4000-8000-000000000004",
      expectedVersion: 1,
      publish: false,
      confirmPublicDisclosure: false,
    });
    await expect(loadPublicPortfolio("milestone-learner")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
