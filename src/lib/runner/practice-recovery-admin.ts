import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { db } from "@/lib/db/client";
import { codeSubmission, notification, runnerJob, user } from "@/lib/db/schema";
import { writeAuditEventInTransaction } from "@/lib/security/audit-writer";
import { lockUserAuthority } from "@/lib/security/user-authority-lock";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = ["queued", "leased", "running"] as const;
const PRACTICE_TYPES = ["server_compile", "server_run"] as const;
const RESOLUTION_CODE = "PRACTICE_QUARANTINE_OPERATOR_RESOLVED";

export type PracticeRecoveryAdminErrorCode =
  | "INVALID_INPUT"
  | "ADMIN_REQUIRED"
  | "RUNNER_JOB_NOT_FOUND"
  | "LEARNER_NOT_ACTIVE"
  | "NOT_PRACTICE_JOB"
  | "NOT_QUARANTINED"
  | "STATUS_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "ATTESTATION_REQUIRED";

export class PracticeRecoveryAdminError extends Error {
  constructor(public readonly code: PracticeRecoveryAdminErrorCode) {
    super(code);
    this.name = "PracticeRecoveryAdminError";
  }
}

export type PracticeQuarantineResolution = Readonly<{
  runnerJobId: string;
  submissionId: string;
  learnerUserId: string;
  status: "cancelled";
  officialEvidenceChanged: false;
  replayed: boolean;
}>;

function resolutionRequestId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).resolutionRequestId;
  return typeof candidate === "string" ? candidate : null;
}

function storedResolutionRequestHash(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).resolutionRequestHash;
  return typeof candidate === "string" ? candidate : null;
}

function hashResolutionRequest(input: {
  runnerJobId: string;
  requestId: string;
  reason: string;
  isolatedRunnerRestarted: boolean;
  journalReconciled: boolean;
}) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    runnerJobId: input.runnerJobId,
    requestId: input.requestId,
    reason: input.reason,
    isolatedRunnerRestarted: input.isolatedRunnerRestarted,
    journalReconciled: input.journalReconciled,
  })).digest("hex");
}

function validateInput(input: {
  actorUserId: string;
  runnerJobId: string;
  requestId: string;
  reason: string;
  isolatedRunnerRestarted: boolean;
  journalReconciled: boolean;
  now: Date;
}) {
  if (
    input.actorUserId.length < 1
    || input.actorUserId.length > 255
    || !UUID_PATTERN.test(input.runnerJobId)
    || !UUID_PATTERN.test(input.requestId)
    || input.reason.trim().length < 20
    || input.reason.length > 500
    || !Number.isFinite(input.now.getTime())
  ) throw new PracticeRecoveryAdminError("INVALID_INPUT");
  if (!input.isolatedRunnerRestarted || !input.journalReconciled) {
    throw new PracticeRecoveryAdminError("ATTESTATION_REQUIRED");
  }
}

/**
 * Terminalize a practice dispatch whose immutable recovery snapshot is corrupt.
 * This action is intentionally unavailable to learners and cannot be used for
 * exams or correction regrades. The operator must first stop/restart the
 * isolated runner and reconcile its durable journal, so no remote execution can
 * still race the local cancellation.
 */
export async function resolveQuarantinedPracticeRunnerJob(input: {
  readonly actorUserId: string;
  readonly runnerJobId: string;
  readonly requestId: string;
  readonly reason: string;
  readonly isolatedRunnerRestarted: boolean;
  readonly journalReconciled: boolean;
  readonly now?: Date;
}): Promise<PracticeQuarantineResolution> {
  const normalized = {
    ...input,
    reason: input.reason.trim(),
    now: input.now ?? new Date(),
  };
  validateInput(normalized);
  const requestHash = hashResolutionRequest(normalized);

  // This read chooses the global authority-lock key only. Every mutable fact is
  // re-read after that lock, so deletion or reassignment cannot race the write.
  const [candidate] = await db
    .select({ learnerUserId: codeSubmission.userId })
    .from(runnerJob)
    .innerJoin(codeSubmission, eq(codeSubmission.id, runnerJob.submissionId))
    .where(eq(runnerJob.id, normalized.runnerJobId))
    .limit(1);
  if (!candidate) throw new PracticeRecoveryAdminError("RUNNER_JOB_NOT_FOUND");

  return db.transaction(async (tx) => {
    await lockUserAuthority(tx, candidate.learnerUserId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`runner-learner:${candidate.learnerUserId}`}))`);
    await tx.execute(sql`select id from runner_job where id = ${normalized.runnerJobId}::uuid for update`);
    await tx.execute(sql`select id from code_submission where id = (
      select submission_id from runner_job where id = ${normalized.runnerJobId}::uuid
    ) for update`);
    await tx.execute(sql`select id from "user"
      where id in (${normalized.actorUserId}, ${candidate.learnerUserId})
      order by id for update`);

    const [actor] = await tx
      .select({ role: user.role, status: user.status })
      .from(user)
      .where(eq(user.id, normalized.actorUserId))
      .limit(1);
    if (actor?.role !== "admin" || actor.status !== "active") {
      throw new PracticeRecoveryAdminError("ADMIN_REQUIRED");
    }

    const [current] = await tx
      .select({
        runnerJobId: runnerJob.id,
        runnerStatus: runnerJob.status,
        recoveryState: runnerJob.recoveryState,
        recoveryAttemptCount: runnerJob.recoveryAttemptCount,
        recoveryLastErrorCode: runnerJob.recoveryLastErrorCode,
        remoteRunnerJobId: runnerJob.leaseOwner,
        result: runnerJob.result,
        submissionId: codeSubmission.id,
        submissionStatus: codeSubmission.status,
        submissionType: codeSubmission.submissionType,
        runnerRequestId: codeSubmission.requestId,
        learnerUserId: codeSubmission.userId,
        learnerRole: user.role,
        learnerStatus: user.status,
      })
      .from(runnerJob)
      .innerJoin(codeSubmission, eq(codeSubmission.id, runnerJob.submissionId))
      .innerJoin(user, eq(user.id, codeSubmission.userId))
      .where(and(
        eq(runnerJob.id, normalized.runnerJobId),
        eq(codeSubmission.userId, candidate.learnerUserId),
      ))
      .limit(1);
    if (!current) throw new PracticeRecoveryAdminError("RUNNER_JOB_NOT_FOUND");
    if (current.learnerRole !== "learner" || current.learnerStatus === "deleted") {
      throw new PracticeRecoveryAdminError("LEARNER_NOT_ACTIVE");
    }
    if (!PRACTICE_TYPES.includes(current.submissionType as (typeof PRACTICE_TYPES)[number])) {
      throw new PracticeRecoveryAdminError("NOT_PRACTICE_JOB");
    }

    const priorRequestId = resolutionRequestId(current.result);
    const priorRequestHash = storedResolutionRequestHash(current.result);
    if (current.runnerStatus === "cancelled" && current.submissionStatus === "cancelled") {
      if (priorRequestId !== normalized.requestId || priorRequestHash !== requestHash) {
        throw new PracticeRecoveryAdminError("IDEMPOTENCY_CONFLICT");
      }
      return {
        runnerJobId: current.runnerJobId,
        submissionId: current.submissionId,
        learnerUserId: current.learnerUserId,
        status: "cancelled",
        officialEvidenceChanged: false,
        replayed: true,
      };
    }
    if (current.recoveryState !== "quarantined") {
      throw new PracticeRecoveryAdminError("NOT_QUARANTINED");
    }
    const result = {
      error: RESOLUTION_CODE,
      retryable: true,
      officialEvidenceChanged: false,
      resolutionRequestId: normalized.requestId,
      resolutionRequestHash: requestHash,
      resolvedAt: normalized.now.toISOString(),
    };
    const runnerActive = ACTIVE_STATUSES.includes(current.runnerStatus as (typeof ACTIVE_STATUSES)[number]);
    const submissionActive = ACTIVE_STATUSES.includes(current.submissionStatus as (typeof ACTIVE_STATUSES)[number]);
    if (!runnerActive && !submissionActive) throw new PracticeRecoveryAdminError("STATUS_CONFLICT");

    const jobs = await tx
      .update(runnerJob)
      .set({
        status: "cancelled",
        result,
        completedAt: normalized.now,
        recoveryNextAttemptAt: null,
        recoveryLastErrorCode: current.recoveryLastErrorCode === "PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING"
          ? current.recoveryLastErrorCode
          : RESOLUTION_CODE,
      })
      .where(and(
        eq(runnerJob.id, current.runnerJobId),
        eq(runnerJob.recoveryState, "quarantined"),
        eq(runnerJob.status, current.runnerStatus),
      ))
      .returning({ id: runnerJob.id });
    const submissions = await tx
      .update(codeSubmission)
      .set({
        status: "cancelled",
        runtimeImageDigest: "practice-quarantine-operator-resolved",
      })
      .where(and(
        eq(codeSubmission.id, current.submissionId),
        eq(codeSubmission.userId, current.learnerUserId),
        eq(codeSubmission.status, current.submissionStatus),
      ))
      .returning({ id: codeSubmission.id });
    if (jobs.length !== 1 || submissions.length !== 1) {
      throw new PracticeRecoveryAdminError("STATUS_CONFLICT");
    }

    await tx.insert(notification).values({
      userId: current.learnerUserId,
      type: "practice-runner-recovery-resolved",
      title: "Practice run recovery completed",
      body: "An administrator safely closed an indeterminate practice run after reconciling the isolated runner. Retry the exercise with a new request if you still need the result.",
      actionUrl: "/learn",
      createdAt: normalized.now,
    });
    await writeAuditEventInTransaction(tx, {
      actorUserId: normalized.actorUserId,
      subjectUserId: current.learnerUserId,
      action: "runner.practice.quarantine.resolve",
      resourceType: "runner_job",
      resourceId: current.runnerJobId,
      reason: normalized.reason,
      outcome: "success",
      correlationId: normalized.requestId,
      metadata: {
        submissionId: current.submissionId,
        priorRunnerStatus: current.runnerStatus,
        priorSubmissionStatus: current.submissionStatus,
        priorRecoveryState: current.recoveryState,
        priorRecoveryAttemptCount: current.recoveryAttemptCount,
        priorRecoveryLastErrorCode: current.recoveryLastErrorCode,
        remoteRunnerJobId: current.remoteRunnerJobId,
        runnerRequestId: current.runnerRequestId,
        isolatedRunnerRestarted: true,
        journalReconciled: true,
        resolutionRequestHash: requestHash,
        officialEvidenceChanged: false,
      },
    });
    return {
      runnerJobId: current.runnerJobId,
      submissionId: current.submissionId,
      learnerUserId: current.learnerUserId,
      status: "cancelled",
      officialEvidenceChanged: false,
      replayed: false,
    };
  });
}
