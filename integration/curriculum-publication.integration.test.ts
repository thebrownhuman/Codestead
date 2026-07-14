import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  CurriculumAdminError,
  publishCurriculumVersion,
  retireCurriculumVersion,
  reviewCurriculumArtifact,
  rollbackCurriculumPointer,
  submitCurriculumReleaseEvidence,
} from "@/lib/curriculum-publication/admin-service";
import type { CurriculumReleaseEvidence, CurriculumReviewChecklist } from "@/lib/curriculum-publication/contracts";
import { evaluateCurriculumPublicationGate } from "@/lib/curriculum-publication/gate";
import { aggregateArtifactHash, hashCurriculumValue } from "@/lib/curriculum-publication/hash";
import { stageFilesystemCurriculum } from "@/lib/curriculum-publication/staging";
import { pool } from "@/lib/db/client";

const ADMIN_ID = "curriculum-integration-admin";
const LEARNER_ID = "curriculum-integration-learner";
const COURSE_ID = "91000000-0000-4000-8000-000000000001";
const PRIOR_VERSION_ID = "91000000-0000-4000-8000-000000000002";
const CANDIDATE_VERSION_ID = "91000000-0000-4000-8000-000000000003";
const MODULE_ID = "91000000-0000-4000-8000-000000000004";
const LESSON_ID = "91000000-0000-4000-8000-000000000005";
const BLOCK_ID = "91000000-0000-4000-8000-000000000006";
const ENROLLMENT_ID = "91000000-0000-4000-8000-000000000007";
const NOW = new Date("2026-07-12T12:00:00.000Z");
const HASH = "a".repeat(64);
const SKILL_ID = "curriculum.core.variables";

const checklist: CurriculumReviewChecklist = {
  technical: { passed: true, evidenceRef: "evidence://technical/1", note: "Technical behavior was independently checked." },
  source: { passed: true, evidenceRef: "evidence://source/1", note: "Every source claim was independently checked." },
  pedagogy: { passed: true, evidenceRef: "evidence://pedagogy/1", note: "Learning progression was independently checked." },
  accessibility: { passed: true, evidenceRef: "evidence://accessibility/1", note: "Keyboard and screen-reader behavior was checked." },
  security: { passed: true, evidenceRef: "evidence://security/1", note: "Security boundaries were independently checked." },
  answerOracle: { passed: true, evidenceRef: "evidence://oracle/1", note: "Answer-oracle behavior was independently checked." },
  exampleExecution: { passed: true, evidenceRef: "evidence://execution/1", note: "All relevant examples were independently executed." },
};

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Curriculum integration tests require the disposable learncoding_integration database.");
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

async function seedActors() {
  await pool.query(
    `insert into "user" (id, public_id, name, email, role, status)
     values ($1,$2,'Curriculum Admin','curriculum-admin@integration.invalid','admin','active'),
            ($3,$4,'Curriculum Learner','curriculum-learner@integration.invalid','learner','active')`,
    [ADMIN_ID, "90000000-0000-4000-8000-000000000001", LEARNER_ID, "90000000-0000-4000-8000-000000000002"],
  );
}

beforeEach(async () => {
  await truncateApplicationTables();
  await seedActors();
});

afterAll(async () => {
  await pool.end();
});

function validManifest() {
  return {
    $schema: "../schema/course.schema.json",
    id: "curriculum-integration",
    title: "Curriculum Integration",
    version: "2.0.0",
    status: "beta",
    release: "launch-1",
    summary: "A complete synthetic publication candidate used only by the disposable integration database.",
    audience: {
      level: "beginner learner",
      assumed_knowledge: ["Basic computer use"],
      target_capability: "Explain and use one variable safely in a small program.",
    },
    scope: {
      includes: ["Variables and assignment"],
      non_goals: ["Production framework development"],
    },
    authoritative_sources: [{
      id: "official-source",
      title: "Official Language Guide",
      url: "https://example.com/official-guide",
      type: "official-docs",
      version_or_date: "2026-07",
    }],
    runtime: {
      kind: "programming-language",
      language: "Python",
      standard: "Python 3",
      toolchain: ["CPython"],
      execution_environment: "Isolated disposable runner",
      file_extensions: [".py"],
      notes: ["Runtime is pinned for release evidence."],
    },
    modules: [{
      id: "curriculum.core",
      title: "Core variables",
      description: "Introduce variables with deterministic evidence.",
      required: true,
      prerequisites: [],
      skills: [{
        id: SKILL_ID,
        title: "Variable assignment",
        description: "Create and update a simple variable safely.",
        outcomes: ["Create and explain a valid variable assignment."],
        prerequisites: [],
        evidence_types: ["concept-check"],
        status: "required",
        coverage_status: "covered",
        source_refs: ["official-source"],
      }],
    }],
    exit_outcomes: ["Create a valid variable assignment.", "Explain the resulting stored value."],
    coverage_summary: { required_skills: 1, elective_skills: 0, total_skills: 1, covered: 1, partial: 0, planned: 0 },
  };
}

async function seedPublishableCandidate() {
  const manifest = validManifest();
  const lesson = {
    id: "lesson.curriculum.core.variables",
    skillId: SKILL_ID,
    publication: { stage: "approved", aiAssisted: false, reviewer: { kind: "human", name: "Independent Reviewer" } },
  };
  const bank = {
    id: "bank.curriculum.core.variables",
    skillId: SKILL_ID,
    publication: { stage: "approved", aiAssisted: false, reviewer: { kind: "human", name: "Independent Reviewer" } },
    items: [{ id: "question.variables.1", kind: "concept-check", examEligibility: { eligible: true } }],
  };
  const artifacts = [
    { key: "manifest.curriculum-integration.2.0.0", type: "course_manifest", skill: null, path: "courses/curriculum-integration.json", content: manifest },
    { key: lesson.id, type: "authored_lesson", skill: SKILL_ID, path: `authored/lessons/${SKILL_ID}.json`, content: lesson },
    { key: bank.id, type: "assessment_bank", skill: SKILL_ID, path: `authored/assessment-banks/${SKILL_ID}.json`, content: bank },
  ].map((artifact) => ({ ...artifact, hash: hashCurriculumValue(artifact.content) }));
  const contentHash = aggregateArtifactHash(artifacts.map((artifact) => ({ artifactKey: artifact.key, artifactType: artifact.type, contentHash: artifact.hash })));

  await pool.query(
    `insert into course (id,slug,title,summary,domain) values ($1,'curriculum-integration','Curriculum Integration','Disposable publication workflow candidate.','programming')`,
    [COURSE_ID],
  );
  await pool.query(
    `insert into course_version (id,course_id,version,stage,scope_statement,content_hash,publication_revision)
     values ($1,$3,'1.0.0','beta','Prior immutable release',$4,1),
            ($2,$3,'2.0.0','draft','Candidate immutable release',$5,1)`,
    [PRIOR_VERSION_ID, CANDIDATE_VERSION_ID, COURSE_ID, "b".repeat(64), contentHash],
  );
  await pool.query(
    `insert into curriculum_publication_pointer (course_id,current_course_version_id,row_version,updated_by,reason,updated_at)
     values ($1,$2,1,$3,'Establish the prior tested publication pointer.',$4)`,
    [COURSE_ID, PRIOR_VERSION_ID, ADMIN_ID, NOW],
  );
  await pool.query(
    `insert into enrollment (id,user_id,course_version_id,implementation_language,status,source,started_at)
     values ($1,$2,$3,'Python','active','admin',$4)`,
    [ENROLLMENT_ID, LEARNER_ID, CANDIDATE_VERSION_ID, NOW],
  );
  const artifactIds: string[] = [];
  for (const artifact of artifacts) {
    const inserted = await pool.query<{ id: string }>(
      `insert into curriculum_artifact
        (course_version_id,artifact_key,artifact_type,skill_key,source_path,content,content_hash,publication_stage,ai_assisted,provenance)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,'approved',false,'{"reviewOrigin":"human"}'::jsonb) returning id`,
      [CANDIDATE_VERSION_ID, artifact.key, artifact.type, artifact.skill, artifact.path, JSON.stringify(artifact.content), artifact.hash],
    );
    artifactIds.push(inserted.rows[0]!.id);
  }
  await pool.query(
    `insert into course_module (id,course_version_id,slug,title,objective,position,estimated_minutes)
     values ($1,$2,'curriculum.core','Core variables','Teach one deterministic skill.',0,20)`,
    [MODULE_ID, CANDIDATE_VERSION_ID],
  );
  await pool.query(
    `insert into lesson (id,module_id,slug,title,objective,estimated_minutes,difficulty,position,content_status)
     values ($1,$2,$3,'Variable assignment','Create and explain a variable.',20,'beginner',0,'beta')`,
    [LESSON_ID, MODULE_ID, SKILL_ID],
  );
  await pool.query(
    `insert into lesson_block (id,lesson_id,position,type,payload,interest_tags)
     values ($1,$2,0,'explanation','{"text":"A reviewed variable lesson."}'::jsonb,'[]'::jsonb)`,
    [BLOCK_ID, LESSON_ID],
  );
  return { artifacts, artifactIds, contentHash };
}

function releaseEvidence(artifacts: Awaited<ReturnType<typeof seedPublishableCandidate>>["artifacts"]): CurriculumReleaseEvidence {
  return {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    generator: "curriculum-integration-suite",
    sourceCoverage: { passed: true, reportHash: HASH, sourceRefs: ["official-source"] },
    skillCoverage: {
      passed: true,
      reportHash: HASH,
      skillIds: [SKILL_ID],
      lessonArtifactKeys: [artifacts.find((item) => item.type === "authored_lesson")!.key],
      assessmentBankArtifactKeys: [artifacts.find((item) => item.type === "assessment_bank")!.key],
    },
    dagMastery: { passed: true, reportHash: HASH },
    codeExecution: { passed: true, reportHash: HASH, executedItemIds: [], runtimeImageDigests: [] },
    languageParity: { status: "passed", reportHash: HASH, rationale: "The only declared implementation language was independently reviewed.", languages: ["Python"] },
    webAccessibility: { status: "not_applicable", reportHash: HASH, rationale: "This synthetic lesson has no web interaction beyond semantic text." },
    security: { passed: true, reportHash: HASH },
    exclusions: { reportHash: HASH, items: ["No external network behavior is included."] },
  };
}

describe("real PostgreSQL curriculum governance", () => {
  it("stages every filesystem artifact as an unapproved draft and protects review history under replay and concurrency", async () => {
    const input = {
      actorUserId: ADMIN_ID,
      requestId: "92000000-0000-4000-8000-000000000001",
      reason: "Stage the validated filesystem catalog for independent review.",
      sourceCommit: "integration-commit",
      now: NOW,
    };
    const staged = await stageFilesystemCurriculum(input);
    expect(staged).toMatchObject({ courses: 12, artifacts: 964, aiAssistedArtifacts: 952 });
    expect((await stageFilesystemCurriculum(input)).courseVersionIds).toEqual(staged.courseVersionIds);
    await expect(stageFilesystemCurriculum({ ...input, reason: "Reuse the same request with conflicting staging evidence." })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    const counts = await pool.query<{
      versions: string; artifacts: string; ai_assisted: string; approved: string; non_draft: string; events: string;
    }>(`select
      (select count(*) from course_version) versions,
      (select count(*) from curriculum_artifact) artifacts,
      (select count(*) from curriculum_artifact where ai_assisted) ai_assisted,
      (select count(*) from curriculum_artifact where review_status = 'approved') approved,
      (select count(*) from course_version where stage <> 'draft') non_draft,
      (select count(*) from curriculum_publication_event where event = 'candidate_staged') events`);
    expect(counts.rows[0]).toEqual({ versions: "12", artifacts: "964", ai_assisted: "952", approved: "0", non_draft: "0", events: "12" });
    const assessmentRows = await pool.query<{ content: { items: Array<{ examEligibility: { eligible: boolean } }> } }>(
      `select content from curriculum_artifact where artifact_type = 'assessment_bank'`,
    );
    expect(assessmentRows.rows).toHaveLength(476);
    expect(assessmentRows.rows.every((row) => row.content.items.every((item) => item.examEligibility.eligible === false))).toBe(true);

    const gate = await evaluateCurriculumPublicationGate({ courseVersionId: staged.courseVersionIds[0]!, targetStage: "beta" });
    expect(gate.allowed).toBe(false);
    expect(new Set(gate.issues.map((issue) => issue.code))).toEqual(expect.objectContaining(new Set(["HUMAN_REVIEW_MISSING", "RELEASE_EVIDENCE_MISSING"])));

    const draft = await pool.query<{ id: string; artifact_key: string }>(
      `select id, artifact_key from curriculum_artifact where ai_assisted and artifact_type = 'authored_lesson' order by artifact_key limit 1`,
    );
    const artifact = draft.rows[0]!;
    await expect(reviewCurriculumArtifact({
      actorUserId: ADMIN_ID,
      artifactId: artifact.id,
      requestId: "92000000-0000-4000-8000-000000000002",
      expectedVersion: 1,
      decision: "approved",
      checklist,
      reviewedItemIds: [artifact.artifact_key],
      reason: "Attempt approval without embedded independent human evidence.",
      now: NOW,
    })).rejects.toMatchObject({ code: "HUMAN_APPROVAL_BLOCKED" });

    const firstReviewInput = {
      actorUserId: ADMIN_ID,
      artifactId: artifact.id,
      requestId: "92000000-0000-4000-8000-000000000003",
      expectedVersion: 1,
      decision: "changes_requested" as const,
      checklist,
      reviewedItemIds: [artifact.artifact_key],
      reason: "Request embedded human review and deterministic exam evidence.",
      now: NOW,
    };
    expect(await reviewCurriculumArtifact(firstReviewInput)).toMatchObject({ rowVersion: 2, replayed: false });
    expect(await reviewCurriculumArtifact(firstReviewInput)).toMatchObject({ rowVersion: 2, replayed: true });
    const concurrent = await Promise.allSettled([
      reviewCurriculumArtifact({ ...firstReviewInput, requestId: "92000000-0000-4000-8000-000000000004", expectedVersion: 2, reason: "Record the first concurrent independent review correction." }),
      reviewCurriculumArtifact({ ...firstReviewInput, requestId: "92000000-0000-4000-8000-000000000005", expectedVersion: 2, reason: "Record the second concurrent independent review correction." }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "VERSION_CONFLICT" });
    expect((await pool.query(`select id from curriculum_review_event where artifact_id = $1`, [artifact.id])).rows).toHaveLength(2);

    await expect(pool.query(`update curriculum_artifact set content = '{"tampered":true}'::jsonb where id = $1`, [artifact.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`update curriculum_review_event set reason = 'This attempted history rewrite must be rejected.' where artifact_id = $1`, [artifact.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`update course_version set content_hash = $2 where id = $1`, [staged.courseVersionIds[0], "f".repeat(64)])).rejects.toMatchObject({ code: "23514" });
  });

  it("publishes only after the complete gate, then rolls back by pointer while preserving immutable evidence", async () => {
    const candidate = await seedPublishableCandidate();
    for (let index = 0; index < candidate.artifactIds.length; index += 1) {
      const artifact = candidate.artifacts[index]!;
      const reviewedItemIds = artifact.type === "assessment_bank" ? ["question.variables.1"] : [artifact.key];
      await reviewCurriculumArtifact({
        actorUserId: ADMIN_ID,
        artifactId: candidate.artifactIds[index]!,
        requestId: `93000000-0000-4000-8000-00000000000${index + 1}`,
        expectedVersion: 1,
        decision: "approved",
        checklist,
        reviewedItemIds,
        reason: `Record complete independent human approval for artifact ${index + 1}.`,
        now: NOW,
      });
    }

    const evidenceInput = {
      actorUserId: ADMIN_ID,
      courseVersionId: CANDIDATE_VERSION_ID,
      requestId: "93000000-0000-4000-8000-000000000010",
      expectedVersion: 1,
      evidence: releaseEvidence(candidate.artifacts),
      reason: "Append the complete signed release evidence for this candidate.",
      now: NOW,
    };
    expect(await submitCurriculumReleaseEvidence(evidenceInput)).toMatchObject({ evidenceVersion: 1, publicationRevision: 2, replayed: false });
    expect(await submitCurriculumReleaseEvidence(evidenceInput)).toMatchObject({ evidenceVersion: 1, publicationRevision: 2, replayed: true });
    await expect(submitCurriculumReleaseEvidence({ ...evidenceInput, reason: "Reuse the same evidence request with a conflicting audit reason." })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    const gate = await evaluateCurriculumPublicationGate({ courseVersionId: CANDIDATE_VERSION_ID, targetStage: "beta" });
    expect(gate).toMatchObject({ allowed: true, summary: { promisedSkills: 1, artifacts: 3, approvedArtifacts: 3, codeItems: 0, runtimeLessons: 1, releaseEvidenceVersion: 1 } });

    const publishInputs = [
      { actorUserId: ADMIN_ID, courseVersionId: CANDIDATE_VERSION_ID, requestId: "93000000-0000-4000-8000-000000000011", expectedVersion: 2, targetStage: "beta" as const, reason: "Publish after the first complete independent gate evaluation.", now: NOW },
      { actorUserId: ADMIN_ID, courseVersionId: CANDIDATE_VERSION_ID, requestId: "93000000-0000-4000-8000-000000000012", expectedVersion: 2, targetStage: "beta" as const, reason: "Publish after the competing complete independent gate evaluation.", now: NOW },
    ];
    const publishResults = await Promise.allSettled(publishInputs.map((input) => publishCurriculumVersion(input)));
    expect(publishResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((publishResults.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(CurriculumAdminError);
    expect((publishResults.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "VERSION_CONFLICT" });
    const winningPublishIndex = publishResults.findIndex((result) => result.status === "fulfilled");
    expect(await publishCurriculumVersion(publishInputs[winningPublishIndex]!)).toMatchObject({ stage: "beta", publicationRevision: 3, replayed: true });

    const pointerAfterPublish = await pool.query<{ current_course_version_id: string; row_version: string }>(`select current_course_version_id, row_version from curriculum_publication_pointer where course_id = $1`, [COURSE_ID]);
    expect(pointerAfterPublish.rows[0]).toEqual({ current_course_version_id: CANDIDATE_VERSION_ID, row_version: "2" });
    const rollbackInputs = [
      { actorUserId: ADMIN_ID, courseId: COURSE_ID, targetCourseVersionId: PRIOR_VERSION_ID, requestId: "93000000-0000-4000-8000-000000000013", expectedPointerVersion: 2, reason: "Roll back the catalog pointer after independent operational review.", now: NOW },
      { actorUserId: ADMIN_ID, courseId: COURSE_ID, targetCourseVersionId: PRIOR_VERSION_ID, requestId: "93000000-0000-4000-8000-000000000014", expectedPointerVersion: 2, reason: "Competing rollback must serialize against the catalog pointer.", now: NOW },
    ];
    const rollbackResults = await Promise.allSettled(rollbackInputs.map((input) => rollbackCurriculumPointer(input)));
    expect(rollbackResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((rollbackResults.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "VERSION_CONFLICT" });
    const winningRollbackIndex = rollbackResults.findIndex((result) => result.status === "fulfilled");
    expect(await rollbackCurriculumPointer(rollbackInputs[winningRollbackIndex]!)).toMatchObject({ currentCourseVersionId: PRIOR_VERSION_ID, pointerVersion: 3, replayed: true });

    const preserved = await pool.query<{
      current_version: string; pointer_version: string; candidate_stage: string; prior_stage: string;
      enrollment_version: string; artifacts: string; reviews: string; evidence: string; events: string;
    }>(`select
      (select current_course_version_id from curriculum_publication_pointer where course_id = $1) current_version,
      (select row_version from curriculum_publication_pointer where course_id = $1) pointer_version,
      (select stage from course_version where id = $2) candidate_stage,
      (select stage from course_version where id = $3) prior_stage,
      (select course_version_id from enrollment where id = $4) enrollment_version,
      (select count(*) from curriculum_artifact where course_version_id = $2) artifacts,
      (select count(*) from curriculum_review_event) reviews,
      (select count(*) from curriculum_release_evidence where course_version_id = $2) evidence,
      (select count(*) from curriculum_publication_event where course_id = $1) events`,
    [COURSE_ID, CANDIDATE_VERSION_ID, PRIOR_VERSION_ID, ENROLLMENT_ID]);
    expect(preserved.rows[0]).toEqual({
      current_version: PRIOR_VERSION_ID,
      pointer_version: "3",
      candidate_stage: "beta",
      prior_stage: "beta",
      enrollment_version: CANDIDATE_VERSION_ID,
      artifacts: "3",
      reviews: "3",
      evidence: "1",
      events: "3",
    });

    const retireInput = {
      actorUserId: ADMIN_ID,
      courseVersionId: CANDIDATE_VERSION_ID,
      requestId: "93000000-0000-4000-8000-000000000015",
      expectedVersion: 3,
      reason: "Retire the non-current candidate after pointer rollback verification.",
      now: NOW,
    };
    expect(await retireCurriculumVersion(retireInput)).toMatchObject({ stage: "retired", publicationRevision: 4, replayed: false });
    expect(await retireCurriculumVersion(retireInput)).toMatchObject({ stage: "retired", publicationRevision: 4, replayed: true });
    await expect(pool.query(`update curriculum_release_evidence set evidence_hash = $2 where course_version_id = $1`, [CANDIDATE_VERSION_ID, "f".repeat(64)])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`update curriculum_publication_event set evidence = '{}'::jsonb where course_id = $1`, [COURSE_ID])).rejects.toMatchObject({ code: "23514" });
  });
});
