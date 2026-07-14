import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  course,
  courseVersion,
  enrollment,
  planRevision,
  user,
} from "@/lib/db/schema";

import {
  AdminPlanValidationError,
  analyzeAdminPlanChange,
  applyAdminPlanOperations,
  parseAdminPlan,
  type AdminPlanOperation,
  type PlanChangePreview,
  type PlanHistorySource,
} from "./plan-revisions";
import { adminPlanRequestHash } from "./idempotency";

export const ADMIN_PLAN_POLICY_VERSION = "admin-plan-revision-2026-07-12.v1";

export class AdminPlanServiceError extends Error {
  constructor(
    public readonly code:
      | "LEARNER_NOT_FOUND"
      | "ENROLLMENT_NOT_FOUND"
      | "NO_PLAN"
      | "REVISION_NOT_FOUND"
      | "VERSION_CONFLICT"
      | "PREREQUISITE_VIOLATION"
      | "FUTURE_EFFECTIVE_AT"
      | "EMPTY_CHANGE"
      | "IDEMPOTENCY_CONFLICT"
      | "IDEMPOTENCY_UNVERIFIABLE",
    message: string,
    public readonly preview?: PlanChangePreview,
  ) {
    super(message);
  }
}

type EnrollmentRow = {
  learnerUserId: string;
  learnerName: string;
  learnerEmail: string;
  enrollmentId: string;
  enrollmentStatus: string;
  implementationLanguage: string | null;
  courseSlug: string;
  courseTitle: string;
  courseVersion: string;
};

type RevisionRow = {
  id: string;
  enrollmentId: string;
  revision: number;
  parentId: string | null;
  source: string;
  reason: string;
  policyVersion: string;
  requestHash: string | null;
  createdBy: string | null;
  plan: Array<Record<string, unknown>>;
  createdAt: Date;
};

const enrollmentColumns = {
  learnerUserId: user.id,
  learnerName: user.name,
  learnerEmail: user.email,
  enrollmentId: enrollment.id,
  enrollmentStatus: enrollment.status,
  implementationLanguage: enrollment.implementationLanguage,
  courseSlug: course.slug,
  courseTitle: course.title,
  courseVersion: courseVersion.version,
} as const;

const revisionColumns = {
  id: planRevision.id,
  enrollmentId: planRevision.enrollmentId,
  revision: planRevision.revision,
  parentId: planRevision.parentId,
  source: planRevision.source,
  reason: planRevision.reason,
  policyVersion: planRevision.policyVersion,
  requestHash: planRevision.requestHash,
  createdBy: planRevision.createdBy,
  plan: planRevision.plan,
  createdAt: planRevision.createdAt,
} as const;

async function ownedEnrollment(learnerPublicId: string, enrollmentId: string) {
  const [row] = await db
    .select(enrollmentColumns)
    .from(enrollment)
    .innerJoin(user, eq(user.id, enrollment.userId))
    .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
    .innerJoin(course, eq(course.id, courseVersion.courseId))
    .where(and(
      eq(user.publicId, learnerPublicId),
      eq(user.role, "learner"),
      eq(enrollment.id, enrollmentId),
    ))
    .limit(1);
  if (!row) throw new AdminPlanServiceError("ENROLLMENT_NOT_FOUND", "The learner enrollment was not found.");
  return row as EnrollmentRow;
}

function revisionSummary(row: RevisionRow) {
  return {
    id: row.id,
    revision: row.revision,
    parentId: row.parentId,
    source: row.source,
    reason: row.reason,
    policyVersion: row.policyVersion,
    createdBy: row.createdBy,
    itemCount: Array.isArray(row.plan) ? row.plan.length : 0,
    createdAt: row.createdAt.toISOString(),
  };
}

function changeCount(preview: PlanChangePreview) {
  return preview.diff.added.length + preview.diff.removed.length +
    preview.diff.moved.length + preview.diff.changed.length;
}

function effectiveDate(value: string, now: Date) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new AdminPlanServiceError("FUTURE_EFFECTIVE_AT", "Choose a valid effective time.");
  }
  if (parsed.getTime() > now.getTime() + 30_000) {
    throw new AdminPlanServiceError(
      "FUTURE_EFFECTIVE_AT",
      "Scheduled activation is not supported yet. Choose an immediate effective time.",
    );
  }
  return parsed;
}

export async function listLearnerPlanHistory(learnerPublicId: string) {
  const [learner] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(and(eq(user.publicId, learnerPublicId), eq(user.role, "learner")))
    .limit(1);
  if (!learner) throw new AdminPlanServiceError("LEARNER_NOT_FOUND", "The learner was not found.");
  const enrollments = await db
    .select({
      enrollmentId: enrollment.id,
      status: enrollment.status,
      implementationLanguage: enrollment.implementationLanguage,
      courseSlug: course.slug,
      courseTitle: course.title,
      courseVersion: courseVersion.version,
    })
    .from(enrollment)
    .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
    .innerJoin(course, eq(course.id, courseVersion.courseId))
    .where(eq(enrollment.userId, learner.id))
    .orderBy(desc(enrollment.updatedAt));
  const ids = enrollments.map((row) => row.enrollmentId);
  const revisions = ids.length
    ? await db.select(revisionColumns).from(planRevision)
      .where(inArray(planRevision.enrollmentId, ids))
      .orderBy(desc(planRevision.revision), desc(planRevision.createdAt))
      .limit(1_000)
    : [];
  const byEnrollment = new Map<string, RevisionRow[]>();
  for (const revision of revisions as RevisionRow[]) {
    const rows = byEnrollment.get(revision.enrollmentId) ?? [];
    rows.push(revision);
    byEnrollment.set(revision.enrollmentId, rows);
  }
  return {
    learner: { publicId: learnerPublicId, name: learner.name },
    policyVersion: ADMIN_PLAN_POLICY_VERSION,
    enrollments: enrollments.map((item) => {
      const history = byEnrollment.get(item.enrollmentId) ?? [];
      return {
        ...item,
        latestRevision: history[0]?.revision ?? 0,
        revisions: history.map(revisionSummary),
      };
    }),
  };
}

export async function getLearnerPlanDetail(input: {
  learnerPublicId: string;
  enrollmentId: string;
  revision?: number;
}) {
  const owned = await ownedEnrollment(input.learnerPublicId, input.enrollmentId);
  const history = await db
    .select(revisionColumns)
    .from(planRevision)
    .where(eq(planRevision.enrollmentId, input.enrollmentId))
    .orderBy(desc(planRevision.revision))
    .limit(500) as RevisionRow[];
  const latest = history[0];
  if (!latest) throw new AdminPlanServiceError("NO_PLAN", "This enrollment does not have a plan revision.");
  const selected = input.revision === undefined
    ? latest
    : history.find((row) => row.revision === input.revision);
  if (!selected) throw new AdminPlanServiceError("REVISION_NOT_FOUND", "The requested plan revision was not found.");
  const analysis = analyzeAdminPlanChange(latest.plan, selected.plan, history.map((row) => row.plan));
  return {
    learner: {
      userId: owned.learnerUserId,
      name: owned.learnerName,
      email: owned.learnerEmail,
      publicId: input.learnerPublicId,
    },
    enrollment: {
      id: owned.enrollmentId,
      status: owned.enrollmentStatus,
      implementationLanguage: owned.implementationLanguage,
      courseSlug: owned.courseSlug,
      courseTitle: owned.courseTitle,
      courseVersion: owned.courseVersion,
    },
    latestRevision: latest.revision,
    selected: { ...revisionSummary(selected), plan: parseAdminPlan(selected.plan) },
    comparisonToLatest: analysis,
    history: history.map(revisionSummary),
  };
}

export async function previewLearnerPlanRevision(input: {
  actorUserId: string;
  learnerPublicId: string;
  enrollmentId: string;
  expectedRevision: number;
  effectiveAt: string;
  operations: readonly AdminPlanOperation[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const effectiveAt = effectiveDate(input.effectiveAt, now);
  const owned = await ownedEnrollment(input.learnerPublicId, input.enrollmentId);
  const history = await db
    .select(revisionColumns)
    .from(planRevision)
    .where(eq(planRevision.enrollmentId, input.enrollmentId))
    .orderBy(desc(planRevision.revision))
    .limit(500) as RevisionRow[];
  const latest = history[0];
  if (!latest) throw new AdminPlanServiceError("NO_PLAN", "This enrollment does not have a plan revision.");
  if (latest.revision !== input.expectedRevision) {
    throw new AdminPlanServiceError(
      "VERSION_CONFLICT",
      `The plan changed. Reload revision ${latest.revision} before saving.`,
    );
  }
  const preview = applyAdminPlanOperations({
    basePlan: latest.plan,
    history: history.map((row) => ({ revision: row.revision, plan: row.plan } satisfies PlanHistorySource)),
    operations: input.operations,
    actorUserId: input.actorUserId,
    effectiveAt: effectiveAt.toISOString(),
  });
  return {
    detail: {
      latestRevision: latest.revision,
      enrollment: owned,
      history: history.map(revisionSummary),
    },
    preview,
    effectiveAt,
  };
}

export async function createLearnerPlanRevision(input: {
  actorUserId: string;
  learnerPublicId: string;
  enrollmentId: string;
  requestId: string;
  expectedRevision: number;
  reason: string;
  effectiveAt: string;
  operations: readonly AdminPlanOperation[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const effectiveAt = effectiveDate(input.effectiveAt, now);
  const reason = input.reason.trim();
  const requestHash = adminPlanRequestHash({
    kind: "revise",
    actorUserId: input.actorUserId,
    learnerPublicId: input.learnerPublicId,
    enrollmentId: input.enrollmentId,
    expectedRevision: input.expectedRevision,
    reason,
    effectiveAt: effectiveAt.toISOString(),
    policyVersion: ADMIN_PLAN_POLICY_VERSION,
    operations: input.operations,
  });
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select(enrollmentColumns)
      .from(enrollment)
      .innerJoin(user, eq(user.id, enrollment.userId))
      .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
      .innerJoin(course, eq(course.id, courseVersion.courseId))
      .where(and(
        eq(user.publicId, input.learnerPublicId),
        eq(user.role, "learner"),
        eq(enrollment.id, input.enrollmentId),
      ))
      .limit(1) as EnrollmentRow[];
    if (!owned) throw new AdminPlanServiceError("ENROLLMENT_NOT_FOUND", "The learner enrollment was not found.");
    await tx.execute(sql`select id from ${enrollment} where ${enrollment.id} = ${input.enrollmentId} for update`);

    const [existing] = await tx
      .select(revisionColumns)
      .from(planRevision)
      .where(eq(planRevision.id, input.requestId))
      .limit(1) as RevisionRow[];
    if (existing) {
      if (existing.requestHash === null) {
        throw new AdminPlanServiceError(
          "IDEMPOTENCY_UNVERIFIABLE",
          "This request ID belongs to a legacy plan revision whose original input cannot be verified. Use a new request ID.",
        );
      }
      if (existing.enrollmentId !== input.enrollmentId || existing.requestHash !== requestHash) {
        throw new AdminPlanServiceError(
          "IDEMPOTENCY_CONFLICT",
          "This request ID was already used for different plan-revision input.",
        );
      }
      return {
        created: false as const,
        replayed: true as const,
        learner: owned,
        revision: revisionSummary(existing),
        preview: null,
      };
    }
    const history = await tx
      .select(revisionColumns)
      .from(planRevision)
      .where(eq(planRevision.enrollmentId, input.enrollmentId))
      .orderBy(desc(planRevision.revision))
      .limit(500) as RevisionRow[];
    const latest = history[0];
    if (!latest) throw new AdminPlanServiceError("NO_PLAN", "This enrollment does not have a plan revision.");
    if (latest.revision !== input.expectedRevision) {
      throw new AdminPlanServiceError(
        "VERSION_CONFLICT",
        `The plan changed. Reload revision ${latest.revision} before saving.`,
      );
    }
    const preview = applyAdminPlanOperations({
      basePlan: latest.plan,
      history: history.map((row) => ({ revision: row.revision, plan: row.plan })),
      operations: input.operations,
      actorUserId: input.actorUserId,
      effectiveAt: effectiveAt.toISOString(),
    });
    if (!preview.impact.canApply) {
      throw new AdminPlanServiceError(
        "PREREQUISITE_VIOLATION",
        "The proposed revision would remove or reorder a required prerequisite.",
        preview,
      );
    }
    if (changeCount(preview) === 0) {
      throw new AdminPlanServiceError("EMPTY_CHANGE", "The proposed revision does not change the plan.", preview);
    }
    const [created] = await tx.insert(planRevision).values({
      id: input.requestId,
      enrollmentId: input.enrollmentId,
      revision: latest.revision + 1,
      parentId: latest.id,
      source: "admin",
      reason,
      policyVersion: ADMIN_PLAN_POLICY_VERSION,
      requestHash,
      createdBy: input.actorUserId,
      plan: preview.plan.map((item) => ({ ...item })),
      createdAt: now,
    }).returning(revisionColumns) as RevisionRow[];
    return {
      created: true as const,
      replayed: false as const,
      learner: owned,
      revision: revisionSummary(created),
      preview,
    };
  });
}

export async function revertLearnerPlanRevision(input: {
  actorUserId: string;
  learnerPublicId: string;
  enrollmentId: string;
  requestId: string;
  expectedRevision: number;
  targetRevision: number;
  reason: string;
  effectiveAt: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const effectiveAt = effectiveDate(input.effectiveAt, now);
  const reason = input.reason.trim();
  const requestHash = adminPlanRequestHash({
    kind: "revert",
    actorUserId: input.actorUserId,
    learnerPublicId: input.learnerPublicId,
    enrollmentId: input.enrollmentId,
    expectedRevision: input.expectedRevision,
    targetRevision: input.targetRevision,
    reason,
    effectiveAt: effectiveAt.toISOString(),
    policyVersion: ADMIN_PLAN_POLICY_VERSION,
  });
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select(enrollmentColumns)
      .from(enrollment)
      .innerJoin(user, eq(user.id, enrollment.userId))
      .innerJoin(courseVersion, eq(courseVersion.id, enrollment.courseVersionId))
      .innerJoin(course, eq(course.id, courseVersion.courseId))
      .where(and(
        eq(user.publicId, input.learnerPublicId),
        eq(user.role, "learner"),
        eq(enrollment.id, input.enrollmentId),
      ))
      .limit(1) as EnrollmentRow[];
    if (!owned) throw new AdminPlanServiceError("ENROLLMENT_NOT_FOUND", "The learner enrollment was not found.");
    await tx.execute(sql`select id from ${enrollment} where ${enrollment.id} = ${input.enrollmentId} for update`);
    const [existing] = await tx
      .select(revisionColumns)
      .from(planRevision)
      .where(eq(planRevision.id, input.requestId))
      .limit(1) as RevisionRow[];
    if (existing) {
      if (existing.requestHash === null) {
        throw new AdminPlanServiceError(
          "IDEMPOTENCY_UNVERIFIABLE",
          "This request ID belongs to a legacy plan revision whose original input cannot be verified. Use a new request ID.",
        );
      }
      if (existing.enrollmentId !== input.enrollmentId || existing.requestHash !== requestHash) {
        throw new AdminPlanServiceError(
          "IDEMPOTENCY_CONFLICT",
          "This request ID was already used for different plan-revert input.",
        );
      }
      return { created: false as const, replayed: true as const, learner: owned, revision: revisionSummary(existing), preview: null };
    }
    const history = await tx.select(revisionColumns).from(planRevision)
      .where(eq(planRevision.enrollmentId, input.enrollmentId))
      .orderBy(desc(planRevision.revision)).limit(500) as RevisionRow[];
    const latest = history[0];
    if (!latest) throw new AdminPlanServiceError("NO_PLAN", "This enrollment does not have a plan revision.");
    if (latest.revision !== input.expectedRevision) {
      throw new AdminPlanServiceError("VERSION_CONFLICT", `The plan changed. Reload revision ${latest.revision} before reverting.`);
    }
    const target = history.find((row) => row.revision === input.targetRevision);
    if (!target) throw new AdminPlanServiceError("REVISION_NOT_FOUND", "The target revision was not found in this enrollment.");
    const analysis = analyzeAdminPlanChange(latest.plan, target.plan, history.map((row) => row.plan));
    const revertedPlan = parseAdminPlan(target.plan).map((item) => ({
      ...item,
      adminRevision: {
        actorUserId: input.actorUserId,
        effectiveAt: effectiveAt.toISOString(),
        operationTypes: ["revert"],
        targetRevision: input.targetRevision,
        evidencePreserved: true,
        masteryUnaffected: true,
        prerequisitesEnforced: true,
      },
    }));
    const preview: PlanChangePreview = { plan: revertedPlan, ...analysis };
    if (!preview.impact.canApply) {
      throw new AdminPlanServiceError("PREREQUISITE_VIOLATION", "The historical revision no longer satisfies the known prerequisite graph.", preview);
    }
    if (changeCount(preview) === 0) throw new AdminPlanServiceError("EMPTY_CHANGE", "The selected revision is already current.", preview);
    const [created] = await tx.insert(planRevision).values({
      id: input.requestId,
      enrollmentId: input.enrollmentId,
      revision: latest.revision + 1,
      parentId: latest.id,
      source: "admin_revert",
      reason,
      policyVersion: ADMIN_PLAN_POLICY_VERSION,
      requestHash,
      createdBy: input.actorUserId,
      plan: preview.plan.map((item) => ({ ...item })),
      createdAt: now,
    }).returning(revisionColumns) as RevisionRow[];
    return { created: true as const, replayed: false as const, learner: owned, revision: revisionSummary(created), preview };
  });
}

export function adminPlanHttpStatus(error: unknown) {
  if (error instanceof AdminPlanValidationError) return 400;
  if (!(error instanceof AdminPlanServiceError)) return 500;
  if (error.code === "LEARNER_NOT_FOUND" || error.code === "ENROLLMENT_NOT_FOUND" || error.code === "REVISION_NOT_FOUND") return 404;
  if (
    error.code === "VERSION_CONFLICT" ||
    error.code === "PREREQUISITE_VIOLATION" ||
    error.code === "EMPTY_CHANGE" ||
    error.code === "IDEMPOTENCY_CONFLICT" ||
    error.code === "IDEMPOTENCY_UNVERIFIABLE"
  ) return 409;
  return 400;
}
