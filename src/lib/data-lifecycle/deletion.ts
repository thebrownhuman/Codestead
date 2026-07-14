import { createHash, createHmac, randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";

import {
  enqueueFileErasures,
  FileErasureError,
  fileErasureSummary,
  processFileErasures,
  purgeCompletedFileErasureJobs,
} from "./file-erasure";
import { addUtcMonths, RETENTION_POLICY_VERSION } from "./policy";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELETED_COMMUNITY_POST_TITLE = "Deleted post";
const DELETED_COMMUNITY_BODY = "[deleted by account owner]";
const DELETED_COMMUNITY_HASH = createHash("sha256")
  .update("learncoding:deleted-community-content:v1", "utf8")
  .digest("hex");

export class AccountDeletionError extends Error {
  constructor(
    public readonly code:
      | "ADMIN_REQUIRED"
      | "LEARNER_NOT_FOUND"
      | "RUN_IN_PROGRESS"
      | "PREVIOUS_RUN_FAILED"
      | "PROVIDER_OPERATION_IN_PROGRESS"
      | "RUNNER_OPERATION_IN_PROGRESS"
      | "FILE_ERASURE_FAILED",
  ) {
    super(code);
  }
}

export type AccountDeletionReport = Readonly<{
  runId: string;
  tombstoneId: string;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  primaryStoreDeletionComplete: true;
  objectFileErasureComplete: true;
  deletedRows: Readonly<Record<string, number>>;
  deletedObjectFiles: number;
  alreadyAbsentObjectFiles: number;
  backupStatus:
    | "awaiting_retention_expiry"
    | "eligible_for_operator_verification"
    | "verified_expired";
  backupRetentionUntil: string;
  backupNotice: string;
  learnerNotificationQueued: true;
  replayed: boolean;
}>;

function normalizeCompletedDeletionReport(report: AccountDeletionReport) {
  // Reports created before the durable-queue rollout were persisted only
  // after their synchronous unlink loop completed. Normalize those immutable
  // successful records without pretending a pending/failed run completed.
  return {
    ...report,
    objectFileErasureComplete: true as const,
    alreadyAbsentObjectFiles: report.alreadyAbsentObjectFiles ?? 0,
  };
}

export async function backupExpiryReport(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("A valid backup report timestamp is required.");
  const result = await pool.query<{
    id: string;
    user_id: string;
    primary_deletion_completed_at: Date;
    backup_retention_until: Date;
    backup_status: string;
  }>(
    `select id, user_id, primary_deletion_completed_at, backup_retention_until, backup_status
       from account_deletion_tombstone
      where backup_status <> 'verified_expired'
      order by backup_retention_until asc, id asc`,
  );
  return {
    policyVersion: RETENTION_POLICY_VERSION,
    evaluatedAt: now.toISOString(),
    records: result.rows.map((row) => ({
      tombstoneId: row.id,
      userId: row.user_id,
      primaryDeletionCompletedAt: row.primary_deletion_completed_at.toISOString(),
      backupRetentionUntil: row.backup_retention_until.toISOString(),
      backupStatus: row.backup_status,
      retentionWindowElapsed: row.backup_retention_until <= now,
      operatorVerificationRequired: true,
      statement: row.backup_retention_until <= now
        ? "Retention window elapsed; verify every configured local/offsite restore-point set before changing status."
        : "Encrypted backups may still contain deleted data. No erasure is claimed.",
    })),
  };
}

function lifecycleSecret() {
  const value = process.env.DELETION_TOMBSTONE_KEY
    ?? (process.env.NODE_ENV === "production" ? undefined : process.env.BETTER_AUTH_SECRET);
  if (!value || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("DELETION_TOMBSTONE_KEY must contain at least 32 bytes.");
  }
  return value;
}

export function deletionIdentityHash(input: { userId: string; email: string }, secret: string) {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Tombstone HMAC key is too short.");
  return createHmac("sha256", secret)
    .update("learncoding:account-deletion:v1\0")
    .update(input.userId)
    .update("\0")
    .update(input.email.trim().toLowerCase())
    .digest("hex");
}

async function deleteCount(client: PoolClient, statement: string, values: unknown[]) {
  const result = await client.query(statement, values);
  return result.rowCount ?? 0;
}

async function cancelUndispatchedRunnerAdmissions(client: PoolClient, userId: string, now: Date) {
  await client.query(
    `with cancellable as (
       select s.id submission_id,j.id runner_job_id
         from code_submission s join runner_job j on j.submission_id = s.id
        where s.user_id = $1 and s.status = 'queued' and j.status = 'queued'
          and j.lease_owner is null
        for update of s,j
     ), cancelled_jobs as (
       update runner_job j set status = 'cancelled',
              result = $2::jsonb,completed_at = $3
         from cancellable c where j.id = c.runner_job_id
         returning j.submission_id
     )
     update code_submission s set status = 'cancelled',runtime_image_digest = 'account-deletion-pre-dispatch'
       from cancelled_jobs c where s.id = c.submission_id`,
    [userId, JSON.stringify({
      error: "ACCOUNT_DELETION_PRE_DISPATCH",
      retryable: false,
      officialEvidenceChanged: false,
    }), now],
  );
}

async function authorizeAndClaim(input: {
  actorUserId: string;
  learnerId: string;
  requestId: string;
  now: Date;
}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(input.learnerId)]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`runner-learner:${input.learnerId}`]);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`account-delete:${input.learnerId}`]);
    const actor = await client.query<{ role: string | null; status: string }>(
      `select role, status from "user" where id = $1 for update`,
      [input.actorUserId],
    );
    if (actor.rows[0]?.role !== "admin" || actor.rows[0]?.status !== "active") {
      throw new AccountDeletionError("ADMIN_REQUIRED");
    }
    const learner = await client.query<{
      id: string;
      email: string;
      role: string | null;
      status: string;
    }>(
      `select id, email, role, status from "user" where id = $1 for update`,
      [input.learnerId],
    );
    const target = learner.rows[0];
    if (!target || target.role !== "learner") throw new AccountDeletionError("LEARNER_NOT_FOUND");

    if (target.status === "deleted") {
      const tombstone = await client.query<{
        report: AccountDeletionReport;
        backup_status: AccountDeletionReport["backupStatus"];
      }>(
        `select report, backup_status from account_deletion_tombstone where user_id = $1`,
        [input.learnerId],
      );
      if (!tombstone.rows[0]) throw new AccountDeletionError("LEARNER_NOT_FOUND");
      await client.query("commit");
      return {
        replay: {
          ...normalizeCompletedDeletionReport(tombstone.rows[0].report),
          backupStatus: tombstone.rows[0].backup_status,
          replayed: true,
        },
        client: null,
      } as const;
    }

    // Fail before claiming the lifecycle run or erasing object files. The
    // same predicate is checked again in the final deletion transaction to
    // close the window between claim and primary-store erasure.
    const providerOperationsInFlight = await client.query<{ blocked: boolean }>(
      `select exists (
         select 1 from provider_operation_receipt
          where owner_user_id = $1 and status = 'processing'
         union all
         select 1
           from admin_fallback_reservation reservation
           join admin_fallback_grant grant_row on grant_row.id = reservation.grant_id
          where grant_row.learner_id = $1 and reservation.status = 'reserved'
       ) as blocked`,
      [input.learnerId],
    );
    if (providerOperationsInFlight.rows[0]?.blocked) {
      throw new AccountDeletionError("PROVIDER_OPERATION_IN_PROGRESS");
    }
    await cancelUndispatchedRunnerAdmissions(client, input.learnerId, input.now);
    const runnerOperationInFlight = await client.query<{ blocked: boolean }>(
      `select exists (
         select 1 from code_submission s
           left join runner_job j on j.submission_id = s.id
          where s.user_id = $1
            and (s.status in ('queued','leased','running') or j.status in ('queued','leased','running'))
       ) as blocked`,
      [input.learnerId],
    );
    if (runnerOperationInFlight.rows[0]?.blocked) {
      throw new AccountDeletionError("RUNNER_OPERATION_IN_PROGRESS");
    }

    const idempotencyKey = `account-deletion:${input.learnerId}:${input.requestId}`;
    const inserted = await client.query<{ id: string }>(
      `insert into data_lifecycle_run
        (operation, policy_version, idempotency_key, status, actor_user_id, target_user_id, started_at)
       values ('account_deletion', $1, $2, 'running', $3, $4, $5)
       on conflict (idempotency_key) do nothing returning id`,
      [RETENTION_POLICY_VERSION, idempotencyKey, input.actorUserId, input.learnerId, input.now],
    );
    let runId = inserted.rows[0]?.id;
    if (!runId) {
      const existing = await client.query<{
        id: string;
        status: string;
        report: AccountDeletionReport | { phase?: string; deletedRows?: Record<string, number> };
      }>(
        `select id, status, report from data_lifecycle_run where idempotency_key = $1 for update`,
        [idempotencyKey],
      );
      const prior = existing.rows[0];
      if (!prior) throw new Error("Deletion idempotency state could not be resolved.");
      if (prior.status === "succeeded") {
        await client.query("commit");
        return {
          replay: {
            ...normalizeCompletedDeletionReport(prior.report as AccountDeletionReport),
            replayed: true,
          },
          client: null,
        } as const;
      }
      if (prior.status === "running") {
        if (!("phase" in prior.report) || prior.report.phase !== "file_erasure_pending") {
          throw new AccountDeletionError("RUN_IN_PROGRESS");
        }
        // The database-erasure checkpoint is durable and the file worker is
        // lease/advisory-lock protected, so the exact same request can recover
        // a process crash without creating a second lifecycle run.
        runId = prior.id;
      }
      if (prior.status === "failed") {
        const resumed = await client.query<{ id: string }>(
          `update data_lifecycle_run set status = 'running', error_code = null,
             started_at = $2, completed_at = null, updated_at = $2
           where id = $1 and status = 'failed' returning id`,
          [prior.id, input.now],
        );
        runId = resumed.rows[0]?.id;
      }
      if (!runId) throw new AccountDeletionError("PREVIOUS_RUN_FAILED");
    }
    await client.query(
      `update "user" set status = 'deletion_pending', updated_at = $2 where id = $1`,
      [input.learnerId, input.now],
    );
    await client.query("delete from session where user_id = $1", [input.learnerId]);
    await client.query("commit");
    return { replay: null, runId: runId!, target, client: null } as const;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteLearnerAccount(input: {
  actorUserId: string;
  learnerId: string;
  requestId: string;
  reason: string;
  now?: Date;
  objectStorageRoot?: string;
}): Promise<AccountDeletionReport> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("A valid deletion timestamp is required.");
  if (!UUID_PATTERN.test(input.requestId)) throw new Error("requestId must be a UUID.");
  if (input.reason.trim().length < 8 || input.reason.length > 500) {
    throw new Error("A deletion reason from 8 to 500 characters is required.");
  }
  const claim = await authorizeAndClaim({ ...input, now });
  if (claim.replay) return claim.replay;
  const root = input.objectStorageRoot ?? process.env.OBJECT_STORAGE_PATH ?? "./data/objects";
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(input.learnerId)]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`runner-learner:${input.learnerId}`]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`account-delete:${input.learnerId}`]);
      const current = await client.query<{ status: string }>(
        `select status from "user" where id = $1 for update`,
        [input.learnerId],
      );
      if (current.rows[0]?.status !== "deletion_pending") {
        throw new AccountDeletionError("LEARNER_NOT_FOUND");
      }
      const priorCheckpoint = await client.query<{
        report: { phase?: string; deletedRows?: Record<string, number> };
      }>("select report from data_lifecycle_run where id = $1 for update", [claim.runId]);
      const priorDeletedRows = priorCheckpoint.rows[0]?.report?.phase === "file_erasure_pending"
        ? priorCheckpoint.rows[0].report.deletedRows ?? {}
        : {};
      await client.query("select set_config('app.account_deletion_authorized', '1', true)");
      const deletedRows: Record<string, number> = {};
      const id = input.learnerId;
      await cancelUndispatchedRunnerAdmissions(client, id, now);
      const runnerOperationInFlight = await client.query<{ blocked: boolean }>(
        `select exists (
           select 1 from code_submission s
             left join runner_job j on j.submission_id = s.id
            where s.user_id = $1
              and (s.status in ('queued','leased','running') or j.status in ('queued','leased','running'))
         ) as blocked`,
        [id],
      );
      if (runnerOperationInFlight.rows[0]?.blocked) {
        throw new AccountDeletionError("RUNNER_OPERATION_IN_PROGRESS");
      }

      // Public portfolio selections must disappear before their owner-bound
      // projects, achievements, or certificates. Certificate evidence is
      // append-only during normal operation, but this transaction has the
      // explicit account-deletion capability set above.
      deletedRows.publicPortfolioProjectSnapshots = await deleteCount(client, "delete from public_portfolio_project_snapshot where user_id = $1", [id]);
      deletedRows.publicPortfolioProjects = await deleteCount(client, "delete from public_portfolio_project where user_id = $1", [id]);
      deletedRows.publicPortfolioAchievements = await deleteCount(client, "delete from public_portfolio_achievement where user_id = $1", [id]);
      deletedRows.publicPortfolioCertificates = await deleteCount(client, "delete from public_portfolio_certificate where user_id = $1", [id]);
      deletedRows.publicPortfolioEvents = await deleteCount(client, "delete from public_portfolio_event where user_id = $1 or actor_user_id = $1", [id]);
      deletedRows.publicPortfolios = await deleteCount(client, "delete from public_portfolio where user_id = $1", [id]);
      deletedRows.certificateOperationReceipts = await deleteCount(client, "delete from certificate_operation_receipt where user_id = $1", [id]);
      deletedRows.certificateRevocations = await deleteCount(
        client,
        "delete from certificate_revocation where certificate_id in (select id from course_certificate where user_id = $1)",
        [id],
      );
      deletedRows.courseCertificates = await deleteCount(client, "delete from course_certificate where user_id = $1", [id]);

      deletedRows.leaderboardScoreSnapshots = await deleteCount(client, "delete from leaderboard_score_snapshot where user_id = $1", [id]);
      deletedRows.cohortProfileEvents = await deleteCount(client, "delete from cohort_profile_event where user_id = $1 or actor_user_id = $1", [id]);
      deletedRows.cohortProfile = await deleteCount(client, "delete from cohort_profile where user_id = $1", [id]);
      deletedRows.consentRecords = await deleteCount(client, "delete from consent_record where user_id = $1", [id]);
      // Preserve other learners' replies and shared challenge history while
      // erasing this learner's community text and private competition answers.
      // The user authority row is pseudonymized later in this transaction.
      deletedRows.codingBattleSubmissions = await deleteCount(
        client,
        "delete from coding_battle_submission where user_id = $1",
        [id],
      );
      deletedRows.codingBattleParticipants = await deleteCount(
        client,
        "delete from coding_battle_participant where user_id = $1",
        [id],
      );
      deletedRows.unlinkedCreatedCodingBattles = await deleteCount(
        client,
        "update coding_battle set creator_user_id = null, updated_at = $2 where creator_user_id = $1",
        [id, now],
      );
      deletedRows.communityOperationReceipts = await deleteCount(
        client,
        "delete from community_operation_receipt where user_id = $1",
        [id],
      );
      deletedRows.communityReports = await deleteCount(
        client,
        "delete from community_report where reporter_user_id = $1",
        [id],
      );
      deletedRows.scrubbedCommunityReplies = await deleteCount(
        client,
        `update community_reply
            set body = $2, content_hash = $3, state = 'deleted', deleted_at = coalesce(deleted_at, $4),
                moderated_by_user_id = null, moderation_reason = null,
                row_version = row_version + 1, edited_at = null, updated_at = $4
          where author_user_id = $1`,
        [id, DELETED_COMMUNITY_BODY, DELETED_COMMUNITY_HASH, now],
      );
      deletedRows.scrubbedCommunityPosts = await deleteCount(
        client,
        `update community_post
            set title = $2, body = $3, content_hash = $4, state = 'deleted',
                deleted_at = coalesce(deleted_at, $5), moderated_by_user_id = null,
                moderation_reason = null, row_version = row_version + 1,
                edited_at = null, updated_at = $5
          where author_user_id = $1`,
        [id, DELETED_COMMUNITY_POST_TITLE, DELETED_COMMUNITY_BODY, DELETED_COMMUNITY_HASH, now],
      );
      deletedRows.communityGroupMemberships = await deleteCount(
        client,
        "delete from community_group_member where user_id = $1",
        [id],
      );
      deletedRows.unlinkedCreatedCommunityGroups = await deleteCount(
        client,
        `update community_group
            set created_by_user_id = null,
                name = 'Archived study group ' || id::text,
                description = 'This study group remains for existing members after its creator deleted their account.',
                row_version = row_version + 1, updated_at = $2
          where created_by_user_id = $1`,
        [id, now],
      );
      deletedRows.emailOutbox = await deleteCount(client, "delete from email_outbox where user_id = $1 or lower(to_email) = lower($2)", [id, claim.target.email]);
      deletedRows.notifications = await deleteCount(client, "delete from notification where user_id = $1", [id]);
      deletedRows.inactivityEpisodes = await deleteCount(client, "delete from inactivity_episode where user_id = $1", [id]);
      deletedRows.smartReminderDispatches = await deleteCount(client, "delete from smart_reminder_dispatch where user_id = $1", [id]);
      deletedRows.notificationPreferences = await deleteCount(client, "delete from notification_preference where user_id = $1", [id]);
      deletedRows.sessionRevocationRequests = await deleteCount(client, "delete from session_revocation_request where user_id = $1", [id]);
      // Proof-backed requests must be removed first because the proof foreign
      // key is deliberately RESTRICT: decision evidence cannot disappear while
      // a live request still points at it. Account deletion owns both rows and
      // erases them in this explicit order.
      deletedRows.lostDeviceProofs = await deleteCount(client, "delete from lost_device_proof where user_id = $1", [id]);
      deletedRows.sessionHistory = await deleteCount(client, "delete from auth_session_history where user_id = $1", [id]);
      deletedRows.sessions = await deleteCount(client, "delete from session where user_id = $1", [id]);
      deletedRows.assessmentMasteryProjectionRepairs = await deleteCount(client, "delete from assessment_mastery_projection_repair where user_id = $1", [id]);
      deletedRows.assessmentMasteryAdjustments = await deleteCount(client, "delete from assessment_mastery_adjustment where user_id = $1", [id]);
      deletedRows.assessmentEffectiveResults = await deleteCount(client, "delete from assessment_attempt_effective_result where user_id = $1", [id]);
      deletedRows.assessmentRegradeOutcomes = await deleteCount(client, "delete from assessment_regrade_outcome where user_id = $1", [id]);
      deletedRows.assessmentRegradeJobs = await deleteCount(client, "delete from assessment_regrade_job where impact_id in (select id from assessment_correction_impact where user_id = $1)", [id]);
      const correctionCleanup = await client.query<{
        deleted_impacts: number;
        deleted_corrections: number;
      }>(
        `with learner_impacts as materialized (
           select id,correction_id from assessment_correction_impact where user_id = $1
         ), deleted_impacts as (
           delete from assessment_correction_impact impact
            using learner_impacts owned
            where impact.id = owned.id
            returning owned.correction_id
         ), candidate_corrections as (
           select distinct correction_id from deleted_impacts
         ), deleted_corrections as (
           delete from assessment_correction correction
            using candidate_corrections owned
            where correction.id = owned.correction_id
              and not exists (
                select 1 from assessment_correction_impact remaining
                 where remaining.correction_id = correction.id
                   and remaining.user_id <> $1
              )
            returning correction.id
         )
         select
           (select count(*)::int from deleted_impacts) deleted_impacts,
           (select count(*)::int from deleted_corrections) deleted_corrections`,
        [id],
      );
      deletedRows.assessmentCorrectionImpacts = correctionCleanup.rows[0]?.deleted_impacts ?? 0;
      // Only corrections that became empty because this learner's own impacts
      // were removed are eligible. Pre-existing or unrelated empty corrections
      // are never swept or attributed to this account-deletion report.
      deletedRows.emptyAssessmentCorrections = correctionCleanup.rows[0]?.deleted_corrections ?? 0;
      // Reward receipts point at immutable ledger events. Erase the receipts
      // first, then their owner-bound ledger, before any source evidence.
      deletedRows.rewardReconciliationJobs = await deleteCount(client, "delete from reward_reconciliation_job where user_id = $1", [id]);
      deletedRows.rewardOperationReceipts = await deleteCount(client, "delete from reward_operation_receipt where user_id = $1", [id]);
      deletedRows.rewardLedger = await deleteCount(client, "delete from reward_ledger where user_id = $1", [id]);
      deletedRows.achievements = await deleteCount(client, "delete from user_achievement where user_id = $1", [id]);
      deletedRows.learningRequests = await deleteCount(client, "delete from learning_request where user_id = $1", [id]);
      deletedRows.storageQuotaChanges = await deleteCount(
        client,
        "delete from storage_quota_change where learner_user_id = $1",
        [id],
      );
      deletedRows.projectRevisionObjects = await deleteCount(
        client,
        `delete from project_revision_object link
          using project_revision revision, project p
          where link.revision_id = revision.id
            and revision.project_id = p.id and p.user_id = $1`,
        [id],
      );
      deletedRows.projectRevisions = await deleteCount(
        client,
        `delete from project_revision revision
          using project p
          where revision.project_id = p.id and p.user_id = $1`,
        [id],
      );
      const durableObjects = await client.query<{ id: string; storage_key: string }>(
        `select id, storage_key from stored_object
          where owner_user_id = $1 order by id for update`,
        [id],
      );
      await enqueueFileErasures(client, {
        lifecycleRunId: claim.runId,
        operation: "account_deletion",
        objects: durableObjects.rows.map((object) => ({
          id: object.id,
          storageKey: object.storage_key,
        })),
        now,
      });
      deletedRows.quotaLedger = await deleteCount(client, "delete from quota_ledger where user_id = $1 or object_id in (select id from stored_object where owner_user_id = $1)", [id]);
      deletedRows.storedObjects = await deleteCount(client, "delete from stored_object where owner_user_id = $1", [id]);
      deletedRows.chatThreads = await deleteCount(client, "delete from chat_thread where user_id = $1", [id]);
      // Account deletion is the sole authorized way to remove correction
      // evidence. Remove that ledger first so its RESTRICT appeal reference is
      // released, then remove appeals so their project-review reference no
      // longer blocks the project's cascading review deletion.
      // Content-free module-project start receipts point at owner-bound
      // projects. Remove them explicitly before project evidence and never
      // rely only on a later user cascade.
      deletedRows.moduleProjectStartReceipts = await deleteCount(
        client,
        "delete from module_project_start_receipt where user_id = $1",
        [id],
      );
      deletedRows.projectReviewCorrections = await deleteCount(
        client,
        `delete from project_review_correction correction
          using project p
          where correction.project_id = p.id and p.user_id = $1`,
        [id],
      );
      deletedRows.appeals = await deleteCount(client, "delete from appeal where user_id = $1", [id]);
      deletedRows.projects = await deleteCount(client, "delete from project where user_id = $1", [id]);
      deletedRows.learnerDraftMutations = await deleteCount(
        client,
        "delete from learner_draft_mutation where draft_id in (select id from learner_draft where user_id = $1)",
        [id],
      );
      deletedRows.learnerDrafts = await deleteCount(client, "delete from learner_draft where user_id = $1", [id]);
      deletedRows.codeSubmissions = await deleteCount(client, "delete from code_submission where user_id = $1", [id]);
      // Daily-review items bind to attempts through an owner/activity/enrollment
      // composite foreign key. Erase the learner-owned allocation before its
      // source attempts so deletion cannot rely on a later user cascade.
      deletedRows.dailyReviewItems = await deleteCount(client, "delete from daily_review_item where user_id = $1", [id]);
      deletedRows.dailyReviewSessions = await deleteCount(client, "delete from daily_review_session where user_id = $1", [id]);
      deletedRows.reviewSchedules = await deleteCount(client, "delete from review_schedule where user_id = $1", [id]);
      deletedRows.masteryEvidence = await deleteCount(client, "delete from mastery_evidence where user_id = $1", [id]);
      deletedRows.learningSessions = await deleteCount(client, "delete from learning_session where user_id = $1", [id]);
      deletedRows.practiceHelpEvents = await deleteCount(client, "delete from practice_help_event where user_id = $1", [id]);
      deletedRows.attempts = await deleteCount(client, "delete from attempt where user_id = $1", [id]);
      deletedRows.conceptMastery = await deleteCount(client, "delete from concept_mastery where user_id = $1", [id]);
      deletedRows.planRevisions = await deleteCount(client, "delete from plan_revision where enrollment_id in (select id from enrollment where user_id = $1)", [id]);
      deletedRows.enrollments = await deleteCount(client, "delete from enrollment where user_id = $1", [id]);
      deletedRows.modelCalls = await deleteCount(client, "delete from model_call where user_id = $1", [id]);
      const providerOperationsInFlight = await client.query<{ blocked: boolean }>(
        `select exists (
           select 1 from provider_operation_receipt
            where owner_user_id = $1 and status = 'processing'
           union all
           select 1
             from admin_fallback_reservation reservation
             join admin_fallback_grant grant_row on grant_row.id = reservation.grant_id
            where grant_row.learner_id = $1 and reservation.status = 'reserved'
         ) as blocked`,
        [id],
      );
      if (providerOperationsInFlight.rows[0]?.blocked) {
        throw new AccountDeletionError("PROVIDER_OPERATION_IN_PROGRESS");
      }
      deletedRows.providerOperationReceipts = await deleteCount(
        client,
        "delete from provider_operation_receipt where owner_user_id = $1",
        [id],
      );
      deletedRows.fallbackReservations = await deleteCount(
        client,
        `delete from admin_fallback_reservation
          where grant_id in (
            select id from admin_fallback_grant
             where learner_id = $1 or granted_by = $1
                or credential_id in (select id from provider_credential where user_id = $1)
          )`,
        [id],
      );
      deletedRows.fallbackGrants = await deleteCount(
        client,
        `delete from admin_fallback_grant
          where learner_id = $1 or granted_by = $1
             or credential_id in (select id from provider_credential where user_id = $1)`,
        [id],
      );
      deletedRows.providerCredentials = await deleteCount(client, "delete from provider_credential where user_id = $1", [id]);
      deletedRows.accounts = await deleteCount(client, "delete from account where user_id = $1", [id]);
      deletedRows.twoFactor = await deleteCount(client, "delete from two_factor where user_id = $1", [id]);
      deletedRows.profile = await deleteCount(client, "delete from learner_profile where user_id = $1", [id]);
      deletedRows.backgroundJobs = await deleteCount(
        client,
        `delete from background_job
          where payload ->> 'userId' = $1 or payload ->> 'learnerId' = $1
             or payload ->> 'user_id' = $1 or payload ->> 'learner_id' = $1
             or lower(payload ->> 'email') = lower($2)
             or lower(payload ->> 'toEmail') = lower($2)`,
        [id, claim.target.email],
      );
      deletedRows.unlinkedActiveSessionActors = await deleteCount(
        client,
        "update session set impersonated_by = null where impersonated_by = $1",
        [id],
      );
      deletedRows.unlinkedSessionHistoryActors = await deleteCount(
        client,
        "update auth_session_history set revoked_by_user_id = null where revoked_by_user_id = $1",
        [id],
      );
      deletedRows.unlinkedRevocationDecisionActors = await deleteCount(
        client,
        "update session_revocation_request set decided_by = null where decided_by = $1",
        [id],
      );
      deletedRows.unlinkedAccessDecisionActors = await deleteCount(
        client,
        "update access_request set decided_by = null where decided_by = $1",
        [id],
      );
      deletedRows.unlinkedInvitationCreators = await deleteCount(
        client,
        "update invitation set created_by = null where created_by = $1",
        [id],
      );
      deletedRows.unlinkedCourseApprovers = await deleteCount(
        client,
        "update course_version set approved_by = null where approved_by = $1",
        [id],
      );
      deletedRows.unlinkedPlanCreators = await deleteCount(
        client,
        "update plan_revision set created_by = null where created_by = $1",
        [id],
      );
      deletedRows.unlinkedEvidenceRecorders = await deleteCount(
        client,
        "update mastery_evidence set recorded_by = null where recorded_by = $1",
        [id],
      );
      deletedRows.unlinkedExamFinalizers = await deleteCount(
        client,
        "update exam_session set finalized_by = null where finalized_by = $1",
        [id],
      );
      deletedRows.unlinkedLearningRequestDeciders = await deleteCount(
        client,
        "update learning_request set decision_by = null where decision_by = $1",
        [id],
      );
      deletedRows.unlinkedAppealDeciders = await deleteCount(
        client,
        "update appeal set decided_by = null where decided_by = $1",
        [id],
      );

      const matchingAccess = await client.query<{ id: string }>(
        "select id from access_request where lower(email) = lower($1)",
        [claim.target.email],
      );
      const accessIds = matchingAccess.rows.map((row) => row.id);
      deletedRows.invitations = await deleteCount(
        client,
        `delete from invitation where lower(email) = lower($1)
          or ($2::uuid[] <> '{}'::uuid[] and access_request_id = any($2::uuid[]))`,
        [claim.target.email, accessIds],
      );
      deletedRows.accessRequests = await deleteCount(client, "delete from access_request where lower(email) = lower($1)", [claim.target.email]);

      // A retry after a crash must preserve the counts committed by the first
      // database-erasure transaction. New counts are normally zero because
      // the deletes are idempotent; adding them also handles a partially
      // populated pre-existing test fixture without under-reporting.
      for (const [categoryName, priorCount] of Object.entries(priorDeletedRows)) {
        deletedRows[categoryName] = (deletedRows[categoryName] ?? 0) + priorCount;
      }
      const checkpoint = {
        phase: "file_erasure_pending",
        deletedRows,
      };
      await client.query(
        `update data_lifecycle_run
            set report = $2::jsonb, updated_at = $3
          where id = $1 and status = 'running'`,
        [claim.runId, JSON.stringify(checkpoint), now],
      );
      // The database removals and durable queue now commit before the first
      // physical unlink. A crash from this point is recoverable by replaying
      // the same deletion request; no completion report exists yet.
      await client.query("commit");

      let fileSummary;
      try {
        fileSummary = await processFileErasures({
          lifecycleRunId: claim.runId,
          objectStorageRoot: root,
        });
      } catch (error) {
        if (error instanceof FileErasureError) {
          throw new AccountDeletionError("FILE_ERASURE_FAILED");
        }
        throw error;
      }

      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(input.learnerId)]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`runner-learner:${input.learnerId}`]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`account-delete:${input.learnerId}`]);
      const finalUser = await client.query<{ status: string }>(
        `select status from "user" where id = $1 for update`,
        [input.learnerId],
      );
      if (finalUser.rows[0]?.status !== "deletion_pending") {
        throw new AccountDeletionError("LEARNER_NOT_FOUND");
      }
      const durableFileSummary = await fileErasureSummary(client, claim.runId);
      if (!durableFileSummary.complete || durableFileSummary.total !== fileSummary.total) {
        throw new AccountDeletionError("FILE_ERASURE_FAILED");
      }

      const tombstoneId = randomUUID();
      const identityHash = deletionIdentityHash(
        { userId: id, email: claim.target.email },
        lifecycleSecret(),
      );
      const backupRetentionUntil = addUtcMonths(now, 12);
      const pseudonymousEmail = `deleted+${tombstoneId}@invalid.local`;
      await client.query(
        `update "user" set
          name = 'Deleted learner', email = $2, email_verified = false, image = null,
          two_factor_enabled = false, status = 'deleted', timezone = 'UTC',
          must_change_password = false, adult_confirmed_at = null,
          last_meaningful_activity_at = null, banned = true,
          ban_reason = 'Account deleted by administrator', ban_expires = null,
          public_id = gen_random_uuid(), row_version = row_version + 1, updated_at = $3
        where id = $1`,
        [id, pseudonymousEmail, now],
      );
      const report: AccountDeletionReport = {
        runId: claim.runId,
        tombstoneId,
        policyVersion: RETENTION_POLICY_VERSION,
        primaryStoreDeletionComplete: true,
        objectFileErasureComplete: true,
        deletedRows,
        deletedObjectFiles: durableFileSummary.removed,
        alreadyAbsentObjectFiles: durableFileSummary.alreadyAbsent,
        backupStatus: "awaiting_retention_expiry",
        backupRetentionUntil: backupRetentionUntil.toISOString(),
        backupNotice:
          "Existing encrypted backups are not claimed erased. They remain subject to 7 daily, 4 weekly, and 12 monthly restore-point expiry and operator verification.",
        learnerNotificationQueued: true,
        replayed: false,
      };
      await client.query(
        `insert into account_deletion_tombstone
          (id, user_id, identity_hash, policy_version, requested_by_user_id,
           primary_deletion_completed_at, backup_retention_until, backup_status, report)
         values ($1, $2, $3, $4, $5, $6, $7, 'awaiting_retention_expiry', $8::jsonb)`,
        [tombstoneId, id, identityHash, RETENTION_POLICY_VERSION, input.actorUserId, now, backupRetentionUntil, JSON.stringify(report)],
      );
      const mailKey = createHash("sha256")
        .update(`account-deleted:${id}:${claim.runId}`)
        .digest("hex");
      await client.query(
        `insert into email_outbox
          (user_id, to_email, template, template_version, variables, idempotency_key, status)
         values (null, lower($1), 'account-deleted', '1', $2::jsonb, $3, 'pending')
         on conflict (idempotency_key) do nothing`,
        [
          claim.target.email,
          JSON.stringify({
            backupRetentionUntil: backupRetentionUntil.toISOString(),
          }),
          mailKey,
        ],
      );
      await client.query(
        `update data_lifecycle_run set status = 'succeeded', report = $2::jsonb,
          completed_at = $3, updated_at = $3 where id = $1`,
        [claim.runId, JSON.stringify(report), now],
      );
      await purgeCompletedFileErasureJobs(client, claim.runId);
      await client.query("commit");
      return report;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.query(
      `update data_lifecycle_run set status = 'failed', error_code = $2,
         completed_at = $3, updated_at = $3 where id = $1 and status = 'running'`,
      [
        claim.runId,
        error instanceof AccountDeletionError ? error.code : "ACCOUNT_DELETION_FAILED",
        new Date(),
      ],
    ).catch(() => undefined);
    throw error;
  }
}
