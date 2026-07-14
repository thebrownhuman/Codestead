import path from "node:path";
import type { PoolClient } from "pg";

import { EXAM_MASTERY_RULE_VERSION } from "@/lib/achievements/exam-mastery";
import { FileSystemContentLoader } from "@/lib/content/loader";
import { pool } from "@/lib/db/client";
import { hashSocialEvidence } from "@/lib/social/hash";

import {
  buildModuleProjectCatalog,
  type ModuleProjectBrief,
  validateModuleProjectCatalog,
  verifyModuleProjectBriefHash,
} from "./module-project-catalog";

export const MODULE_PROJECT_START_POLICY = "module-project-start-2026-07-14.v1";
export const MODULE_PROJECT_REVIEW_POLICY = "module-project-review-2026-07-14.v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class ModuleProjectError extends Error {
  constructor(public readonly code:
    | "INVALID_REQUEST"
    | "NOT_FOUND"
    | "ADMIN_REQUIRED"
    | "IDEMPOTENCY_MISMATCH"
    | "CONTENT_VERSION_MUTATION"
    | "VERSION_CONFLICT"
    | "INVALID_TRANSITION"
    | "PUBLICATION_GATE_FAILED"
    | "PLAN_GATE_FAILED"
    | "MASTERY_GATE_FAILED"
    | "WRITE_CONFLICT") {
    super(code);
  }
}

type TemplateRow = {
  id: string;
  course_version_id: string;
  module_key: string;
  template_key: string;
  template_version: string;
  source_course_content_hash: string;
  content_hash: string;
  title: string;
  brief: Record<string, unknown>;
  stage: string;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  published_at: Date | null;
  retired_at: Date | null;
  row_version: string | number;
  created_at: Date;
  updated_at: Date;
};

function isModuleProjectBrief(value: unknown): value is ModuleProjectBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const brief = value as Partial<ModuleProjectBrief>;
  return brief.schemaVersion === 1
    && typeof brief.templateKey === "string"
    && typeof brief.contentHash === "string"
    && HASH_PATTERN.test(brief.contentHash)
    && typeof brief.courseId === "string"
    && typeof brief.courseVersion === "string"
    && typeof brief.moduleId === "string"
    && Array.isArray(brief.prerequisiteSkillIds)
    && brief.prerequisiteSkillIds.every((item) => typeof item === "string")
    && Array.isArray(brief.milestones)
    && Array.isArray(brief.acceptanceChecks)
    && Array.isArray(brief.reflectionPrompts)
    && Array.isArray(brief.stretchGoals)
    && brief.solution === null
    && brief.directAwardPolicy === "none";
}

function projectTemplate(row: TemplateRow) {
  if (!isModuleProjectBrief(row.brief)
    || !verifyModuleProjectBriefHash(row.brief)
    || row.brief.contentHash !== row.content_hash
    || row.brief.templateKey !== row.template_key
    || row.brief.moduleId !== row.module_key) {
    throw new ModuleProjectError("CONTENT_VERSION_MUTATION");
  }
  return row.brief;
}

function eventName(targetStage: "beta" | "verified" | "retired") {
  if (targetStage === "beta") return "reviewed_beta";
  if (targetStage === "verified") return "promoted_verified";
  return "retired";
}

function transitionHash(input: {
  actorUserId: string;
  templateId: string;
  requestId: string;
  targetStage: "beta" | "verified" | "retired";
  expectedVersion: number;
  reason: string;
}) {
  return hashSocialEvidence({
    operation: "module_project_template_transition",
    policyVersion: MODULE_PROJECT_REVIEW_POLICY,
    ...input,
  });
}

function startHash(userId: string, templateId: string) {
  return hashSocialEvidence({
    operation: "module_project_start",
    policyVersion: MODULE_PROJECT_START_POLICY,
    userId,
    templateId,
  });
}

export function moduleProjectPlanSatisfied(
  value: unknown,
  brief: ModuleProjectBrief,
): boolean {
  if (!Array.isArray(value)) return false;
  const skills = new Set(value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    return item.trackId === brief.courseId
      && item.courseVersion === brief.courseVersion
      && item.moduleId === brief.moduleId
      && typeof item.skillId === "string"
      ? [item.skillId]
      : [];
  }));
  return brief.prerequisiteSkillIds.length > 0
    && brief.prerequisiteSkillIds.every((skillId) => skills.has(skillId));
}

export function moduleProjectAccessState(input: {
  templateStage: string;
  courseStage: string;
  currentPublication: boolean;
  enrollmentStatus: string;
  planSatisfied: boolean;
  masterySatisfied: boolean;
  projectId: string | null;
}) {
  if (input.projectId) return "started" as const;
  if (input.templateStage === "retired" || input.courseStage === "retired" || !input.currentPublication) {
    return "retired" as const;
  }
  if (input.templateStage === "draft" || input.courseStage === "draft") return "draft" as const;
  if (!(["beta", "verified"].includes(input.templateStage)
    && ["beta", "verified"].includes(input.courseStage))) return "locked" as const;
  if (!(input.enrollmentStatus === "active" || input.enrollmentStatus === "completed")) {
    return "locked" as const;
  }
  if (!input.planSatisfied) return "plan_locked" as const;
  if (!input.masterySatisfied) return "mastery_locked" as const;
  return "ready" as const;
}

export async function syncModuleProjectTemplates(input: { contentRoot?: string } = {}) {
  const snapshot = await new FileSystemContentLoader({
    contentRoot: input.contentRoot ?? path.join(process.cwd(), "content"),
  }).loadSnapshot();
  const catalog = buildModuleProjectCatalog(snapshot);
  validateModuleProjectCatalog(snapshot, catalog);
  const client = await pool.connect();
  try {
    await client.query("begin");
    let created = 0;
    let unchanged = 0;
    for (const brief of catalog) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`module-project-sync:${brief.templateKey}`]);
      const version = await client.query<{ id: string; content_hash: string }>(
        `select version.id,version.content_hash
           from course_version version join course on course.id=version.course_id
          where course.slug=$1 and version.version=$2 for update of version`,
        [brief.courseId, brief.courseVersion],
      );
      if (!version.rows[0]) throw new ModuleProjectError("NOT_FOUND");
      const inserted = await client.query(
        `insert into module_project_template
          (course_version_id,module_key,template_key,template_version,
           source_course_content_hash,content_hash,title,brief,stage,row_version,created_at,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'draft',1,now(),now())
         on conflict (template_key) do nothing`,
        [version.rows[0].id, brief.moduleId, brief.templateKey, brief.templateVersion,
          version.rows[0].content_hash, brief.contentHash, brief.title, JSON.stringify(brief)],
      );
      const stored = await client.query<TemplateRow>(
        `select * from module_project_template where template_key=$1 for update`,
        [brief.templateKey],
      );
      const row = stored.rows[0];
      if (!row
        || row.course_version_id !== version.rows[0].id
        || row.module_key !== brief.moduleId
        || row.template_version !== brief.templateVersion
        || row.source_course_content_hash !== version.rows[0].content_hash
        || row.content_hash !== brief.contentHash) {
        throw new ModuleProjectError("CONTENT_VERSION_MUTATION");
      }
      if (inserted.rowCount === 1) created += 1;
      else unchanged += 1;
    }
    await client.query("commit");
    return { courses: snapshot.courses.length, templates: catalog.length, created, unchanged } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertAdmin(client: PoolClient, actorUserId: string) {
  const actor = await client.query<{ role: string | null; status: string }>(
    `select role,status from "user" where id=$1 for update`, [actorUserId],
  );
  if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
    throw new ModuleProjectError("ADMIN_REQUIRED");
  }
}

export async function transitionModuleProjectTemplate(input: {
  actorUserId: string;
  templateId: string;
  requestId: string;
  targetStage: "beta" | "verified" | "retired";
  expectedVersion: number;
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!input.actorUserId.trim() || !UUID_PATTERN.test(input.templateId)
    || !UUID_PATTERN.test(input.requestId) || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 1 || reason.length < 20 || reason.length > 2_000
    || !Number.isFinite(now.getTime())) throw new ModuleProjectError("INVALID_REQUEST");
  const inputHash = transitionHash({
    actorUserId: input.actorUserId,
    templateId: input.templateId,
    requestId: input.requestId,
    targetStage: input.targetStage,
    expectedVersion: input.expectedVersion,
    reason,
  });
  const event = eventName(input.targetStage);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdmin(client, input.actorUserId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`module-project-template:${input.templateId}`]);
    const previous = await client.query<{
      actor_user_id: string; event: string; input_hash: string; reason: string;
      evidence: Record<string, unknown>; resulting_version: string | number;
    }>(
      `select actor_user_id,event,input_hash,reason,evidence,resulting_version
         from module_project_template_event where template_id=$1 and request_id=$2`,
      [input.templateId, input.requestId],
    );
    if (previous.rows[0]) {
      const row = previous.rows[0];
      if (row.actor_user_id !== input.actorUserId || row.event !== event
        || row.input_hash !== inputHash || row.reason !== reason) {
        throw new ModuleProjectError("IDEMPOTENCY_MISMATCH");
      }
      await client.query("commit");
      return {
        templateId: input.templateId,
        stage: input.targetStage,
        rowVersion: Number(row.resulting_version),
        replayed: true,
      } as const;
    }
    const templates = await client.query<TemplateRow & {
      course_stage: string; course_content_hash: string; current_publication: boolean;
      release_evidence_count: string | number; artifact_count: string | number;
      unapproved_count: string | number;
    }>(
      `select template.*,version.stage course_stage,version.content_hash course_content_hash,
              coalesce(pointer.current_course_version_id=version.id,false) current_publication,
              (select count(*) from curriculum_release_evidence release where release.course_version_id=version.id) release_evidence_count,
              (select count(*) from curriculum_artifact artifact where artifact.course_version_id=version.id) artifact_count,
              (select count(*) from curriculum_artifact artifact where artifact.course_version_id=version.id and artifact.review_status<>'approved') unapproved_count
         from module_project_template template
         join course_version version on version.id=template.course_version_id
         left join curriculum_publication_pointer pointer on pointer.course_id=version.course_id
        where template.id=$1 for update of template,version`,
      [input.templateId],
    );
    const template = templates.rows[0];
    if (!template) throw new ModuleProjectError("NOT_FOUND");
    projectTemplate(template);
    if (Number(template.row_version) !== input.expectedVersion) throw new ModuleProjectError("VERSION_CONFLICT");
    const allowed = (template.stage === "draft" && input.targetStage === "beta")
      || (template.stage === "beta" && input.targetStage === "verified")
      || (["draft", "beta", "verified"].includes(template.stage) && input.targetStage === "retired");
    if (!allowed) throw new ModuleProjectError("INVALID_TRANSITION");
    if (input.targetStage !== "retired") {
      const publicationValid = template.current_publication
        && Number(template.artifact_count) > 0
        && Number(template.unapproved_count) === 0
        && Number(template.release_evidence_count) > 0
        && template.source_course_content_hash === template.course_content_hash
        && (input.targetStage === "beta"
          ? ["beta", "verified"].includes(template.course_stage)
          : template.course_stage === "verified");
      if (!publicationValid) throw new ModuleProjectError("PUBLICATION_GATE_FAILED");
    }
    const resultingVersion = Number(template.row_version) + 1;
    const update = input.targetStage === "retired"
      ? `stage='retired',reviewed_by_user_id=coalesce(reviewed_by_user_id,$4),
          reviewed_at=coalesce(reviewed_at,$3),retired_at=$3,row_version=row_version+1,updated_at=$3`
      : `stage=$2::publication_stage,reviewed_by_user_id=$4,reviewed_at=$3,
          published_at=coalesce(published_at,$3),retired_at=null,row_version=row_version+1,updated_at=$3`;
    const updated = await client.query(
      `update module_project_template set ${update}
        where id=$1 and row_version=$5 and stage=$6::publication_stage returning id`,
      [input.templateId, input.targetStage, now, input.actorUserId, input.expectedVersion, template.stage],
    );
    if (updated.rowCount !== 1) throw new ModuleProjectError("WRITE_CONFLICT");
    const evidence = {
      schemaVersion: 1,
      templateId: input.templateId,
      templateKey: template.template_key,
      templateContentHash: template.content_hash,
      courseVersionId: template.course_version_id,
      sourceCourseContentHash: template.source_course_content_hash,
      previousStage: template.stage,
      resultingStage: input.targetStage,
      resultingVersion,
      policyVersion: MODULE_PROJECT_REVIEW_POLICY,
      directAwardPolicy: "none",
    };
    await client.query(
      `insert into module_project_template_event
        (template_id,actor_user_id,request_id,event,input_hash,reason,evidence,evidence_hash,resulting_version,occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
      [input.templateId, input.actorUserId, input.requestId, event, inputHash, reason,
        JSON.stringify(evidence), hashSocialEvidence(evidence), resultingVersion, now],
    );
    await client.query("commit");
    return { templateId: input.templateId, stage: input.targetStage, rowVersion: resultingVersion, replayed: false } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listAdminModuleProjectTemplates() {
  const result = await pool.query<TemplateRow & {
    course_slug: string; course_title: string; course_version: string; course_stage: string;
  }>(
    `select template.*,course.slug course_slug,course.title course_title,
            version.version course_version,version.stage course_stage
       from module_project_template template
       join course_version version on version.id=template.course_version_id
       join course on course.id=version.course_id
      order by course.title,version.version,template.module_key,template.id limit 1000`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    courseId: row.course_slug,
    courseTitle: row.course_title,
    courseVersionId: row.course_version_id,
    courseVersion: row.course_version,
    courseStage: row.course_stage,
    moduleId: row.module_key,
    templateKey: row.template_key,
    templateVersion: row.template_version,
    contentHash: row.content_hash,
    title: row.title,
    stage: row.stage,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null,
    retiredAt: row.retired_at?.toISOString() ?? null,
    rowVersion: Number(row.row_version),
    updatedAt: row.updated_at.toISOString(),
  }));
}

type LearnerTemplateRow = TemplateRow & {
  course_slug: string; course_title: string; course_version: string; course_stage: string;
  enrollment_id: string; enrollment_status: string; latest_plan: unknown;
  current_publication: boolean; mastery_satisfied: boolean;
  project_id: string | null; project_status: string | null; project_updated_at: Date | null;
};

export async function listLearnerModuleProjects(userId: string) {
  if (!userId.trim()) throw new ModuleProjectError("INVALID_REQUEST");
  const result = await pool.query<LearnerTemplateRow>(
    `select template.*,course.slug course_slug,course.title course_title,
            version.version course_version,version.stage course_stage,
            enrollment.id enrollment_id,enrollment.status enrollment_status,
            plan.plan latest_plan,
            coalesce(pointer.current_course_version_id=version.id,false) current_publication,
            exists (
              select 1 from user_achievement owned
              join achievement badge on badge.id=owned.achievement_id
              join attempt evidence_attempt
                on owned.evidence_id='exam-attempt:' || evidence_attempt.id::text
               and evidence_attempt.user_id=owned.user_id
               and evidence_attempt.enrollment_id=enrollment.id
             where owned.user_id=$1 and owned.revoked_at is null
               and badge.rule_version=$2
               and badge.rule->>'event'='exam_mastery'
               and badge.rule->>'courseId'=course.slug
               and badge.rule->>'moduleId'=template.module_key
               and badge.rule->>'minimumScorePercent'='95'
               and badge.rule->>'criticalRequirementsRequired'='true'
               and evidence_attempt.status='graded' and evidence_attempt.passed=true
               and evidence_attempt.mastery_awarded=true
               and round(evidence_attempt.score::numeric,4) >= 0.95
               and evidence_attempt.assistance_level='A0'
               and evidence_attempt.solution_revealed=false
            ) mastery_satisfied,
            owned_project.id project_id,owned_project.status project_status,
            owned_project.updated_at project_updated_at
       from module_project_template template
       join course_version version on version.id=template.course_version_id
       join course on course.id=version.course_id
       join enrollment on enrollment.course_version_id=version.id and enrollment.user_id=$1
       left join curriculum_publication_pointer pointer on pointer.course_id=course.id
       left join lateral (
         select revision.plan from plan_revision revision
          where revision.enrollment_id=enrollment.id order by revision.revision desc limit 1
       ) plan on true
       left join project owned_project
         on owned_project.user_id=$1 and owned_project.assignment_template_id=template.id
      order by course.title,version.version,template.module_key,template.id limit 1000`,
    [userId, EXAM_MASTERY_RULE_VERSION],
  );
  return result.rows.map((row) => {
    const brief = projectTemplate(row);
    const planSatisfied = moduleProjectPlanSatisfied(row.latest_plan, brief);
    const state = moduleProjectAccessState({
      templateStage: row.stage,
      courseStage: row.course_stage,
      currentPublication: row.current_publication,
      enrollmentStatus: row.enrollment_status,
      planSatisfied,
      masterySatisfied: row.mastery_satisfied,
      projectId: row.project_id,
    });
    return {
      templateId: row.id,
      courseId: row.course_slug,
      courseTitle: row.course_title,
      courseVersion: row.course_version,
      moduleId: row.module_key,
      title: row.title,
      stage: row.stage,
      state,
      reason: state === "ready" ? "The exact module is in your plan and independent module mastery is verified."
        : state === "started" ? "Your learner-owned project already exists."
          : state === "draft" ? "This brief still needs administrator editorial review."
            : state === "plan_locked" ? "Finish or restore every required skill for this module in your active plan."
              : state === "mastery_locked" ? "Pass the module mastery exam independently before starting this project."
                : state === "retired" ? "This template or course version is no longer the current publication."
                  : "An active or completed enrollment is required.",
      directAwardPolicy: "none" as const,
      brief,
      project: row.project_id ? {
        id: row.project_id,
        status: row.project_status,
        updatedAt: row.project_updated_at?.toISOString() ?? null,
      } : null,
    };
  });
}

async function readStartedProject(client: PoolClient, projectId: string, userId: string) {
  const project = await client.query<{
    id: string; title: string; summary: string; status: string; assignment_template_id: string;
    assignment_content_hash: string; assignment_stage_at_start: string; created_at: Date; updated_at: Date;
  }>(
    `select id,title,summary,status,assignment_template_id,assignment_content_hash,
            assignment_stage_at_start,created_at,updated_at
       from project where id=$1 and user_id=$2`, [projectId, userId],
  );
  if (!project.rows[0]) throw new ModuleProjectError("NOT_FOUND");
  return {
    id: project.rows[0].id,
    title: project.rows[0].title,
    summary: project.rows[0].summary,
    status: project.rows[0].status,
    assignmentTemplateId: project.rows[0].assignment_template_id,
    assignmentContentHash: project.rows[0].assignment_content_hash,
    assignmentStageAtStart: project.rows[0].assignment_stage_at_start,
    createdAt: project.rows[0].created_at.toISOString(),
    updatedAt: project.rows[0].updated_at.toISOString(),
  };
}

export async function startModuleProject(input: {
  userId: string;
  templateId: string;
  requestId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!input.userId.trim() || !UUID_PATTERN.test(input.templateId)
    || !UUID_PATTERN.test(input.requestId) || !Number.isFinite(now.getTime())) {
    throw new ModuleProjectError("INVALID_REQUEST");
  }
  const inputHash = startHash(input.userId, input.templateId);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`module-project-start:${input.userId}:${input.templateId}`]);
    const learner = await client.query<{ role: string | null; status: string }>(
      `select role,status from "user" where id=$1 for update`, [input.userId],
    );
    if (learner.rows[0]?.role !== "learner" || learner.rows[0]?.status !== "active") {
      throw new ModuleProjectError("NOT_FOUND");
    }
    const receipt = await client.query<{ template_id: string; project_id: string; input_hash: string }>(
      `select template_id,project_id,input_hash from module_project_start_receipt
        where user_id=$1 and request_id=$2`, [input.userId, input.requestId],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].template_id !== input.templateId || receipt.rows[0].input_hash !== inputHash) {
        throw new ModuleProjectError("IDEMPOTENCY_MISMATCH");
      }
      const project = await readStartedProject(client, receipt.rows[0].project_id, input.userId);
      await client.query("commit");
      return { project, replayed: true, reusedExisting: false } as const;
    }
    const templates = await client.query<TemplateRow & {
      course_slug: string; course_version: string; course_stage: string;
      course_content_hash: string; current_publication: boolean;
      enrollment_id: string; enrollment_status: string; latest_plan: unknown;
      mastery_satisfied: boolean;
    }>(
      `select template.*,course.slug course_slug,version.version course_version,
              version.stage course_stage,version.content_hash course_content_hash,
              coalesce(pointer.current_course_version_id=version.id,false) current_publication,
              enrollment.id enrollment_id,enrollment.status enrollment_status,plan.plan latest_plan,
              exists (
                select 1 from user_achievement owned
                join achievement badge on badge.id=owned.achievement_id
                join attempt evidence_attempt
                  on owned.evidence_id='exam-attempt:' || evidence_attempt.id::text
                 and evidence_attempt.user_id=owned.user_id
                 and evidence_attempt.enrollment_id=enrollment.id
               where owned.user_id=$2 and owned.revoked_at is null
                 and badge.rule_version=$3 and badge.rule->>'event'='exam_mastery'
                 and badge.rule->>'courseId'=course.slug
                 and badge.rule->>'moduleId'=template.module_key
                 and badge.rule->>'minimumScorePercent'='95'
                 and badge.rule->>'criticalRequirementsRequired'='true'
                 and evidence_attempt.status='graded' and evidence_attempt.passed=true
                 and evidence_attempt.mastery_awarded=true and evidence_attempt.assistance_level='A0'
                 and round(evidence_attempt.score::numeric,4) >= 0.95
                 and evidence_attempt.solution_revealed=false
              ) mastery_satisfied
         from module_project_template template
         join course_version version on version.id=template.course_version_id
         join course on course.id=version.course_id
         join enrollment on enrollment.course_version_id=version.id and enrollment.user_id=$2
         left join curriculum_publication_pointer pointer on pointer.course_id=course.id
         left join lateral (
           select revision.plan from plan_revision revision
            where revision.enrollment_id=enrollment.id order by revision.revision desc limit 1
         ) plan on true
        where template.id=$1 for update of template,enrollment`,
      [input.templateId, input.userId, EXAM_MASTERY_RULE_VERSION],
    );
    const template = templates.rows[0];
    if (!template) throw new ModuleProjectError("NOT_FOUND");
    const brief = projectTemplate(template);
    if (!template.current_publication
      || !["beta", "verified"].includes(template.stage)
      || !["beta", "verified"].includes(template.course_stage)
      || template.source_course_content_hash !== template.course_content_hash
      || !(template.enrollment_status === "active" || template.enrollment_status === "completed")) {
      throw new ModuleProjectError("PUBLICATION_GATE_FAILED");
    }
    if (!moduleProjectPlanSatisfied(template.latest_plan, brief)) throw new ModuleProjectError("PLAN_GATE_FAILED");
    if (!template.mastery_satisfied) throw new ModuleProjectError("MASTERY_GATE_FAILED");
    const existing = await client.query<{ id: string }>(
      `select id from project where user_id=$1 and assignment_template_id=$2 for update`,
      [input.userId, input.templateId],
    );
    let projectId = existing.rows[0]?.id;
    if (!projectId) {
      const provenance = {
        schemaVersion: 1,
        policyVersion: MODULE_PROJECT_START_POLICY,
        templateId: template.id,
        templateKey: template.template_key,
        templateVersion: template.template_version,
        templateContentHash: template.content_hash,
        templateStage: template.stage,
        courseVersionId: template.course_version_id,
        courseVersion: template.course_version,
        courseContentHash: template.source_course_content_hash,
        courseId: template.course_slug,
        moduleId: template.module_key,
        directAwardPolicy: "none",
      };
      const inserted = await client.query<{ id: string }>(
        `insert into project
          (user_id,title,summary,status,visibility,prd,assignment_template_id,
           assignment_content_hash,assignment_stage_at_start,assignment_provenance,created_at,updated_at)
         values ($1,$2,$3,'idea','private',$4::jsonb,$5,$6,$7,$8::jsonb,$9,$9)
         returning id`,
        [input.userId, brief.title, brief.problem, JSON.stringify({
          version: "module-project-1.0",
          track: brief.courseId,
          difficulty: "module-transfer",
          problem: brief.problem,
          scenario: brief.laymanScenario,
          artifact: brief.artifact,
          milestones: brief.milestones,
          acceptance: brief.acceptanceChecks,
          reflectionPrompts: brief.reflectionPrompts,
          stretchGoals: brief.stretchGoals,
          editorialNotice: brief.editorialNotice,
          awardNotice: brief.awardNotice,
        }), input.templateId, template.content_hash, template.stage, JSON.stringify(provenance), now],
      );
      projectId = inserted.rows[0]?.id;
      if (!projectId) throw new ModuleProjectError("WRITE_CONFLICT");
    }
    await client.query(
      `insert into module_project_start_receipt
        (user_id,request_id,template_id,project_id,input_hash,created_at)
       values ($1,$2,$3,$4,$5,$6)`,
      [input.userId, input.requestId, input.templateId, projectId, inputHash, now],
    );
    const project = await readStartedProject(client, projectId, input.userId);
    await client.query("commit");
    return { project, replayed: false, reusedExisting: Boolean(existing.rows[0]) } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") throw new ModuleProjectError("WRITE_CONFLICT");
    throw error;
  } finally {
    client.release();
  }
}
