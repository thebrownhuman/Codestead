import type { PoolClient } from "pg";

import { pool } from "@/lib/db/client";

import { buildProjectReviewAppealEvidence } from "./evidence";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ["open", "under_review", "needs_learner_input"] as const;

export type ProjectReviewAppealErrorCode =
  | "INVALID_TIME"
  | "INVALID_REQUEST_ID"
  | "INVALID_REASON"
  | "INVALID_CATEGORY"
  | "REVIEW_NOT_FOUND"
  | "INELIGIBLE_REVIEW"
  | "IDEMPOTENCY_MISMATCH"
  | "ALREADY_OPEN"
  | "WRITE_CONFLICT";

export class ProjectReviewAppealError extends Error {
  constructor(
    public readonly code: ProjectReviewAppealErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectReviewAppealError";
  }
}

type OwnedReviewRow = {
  review_id: string;
  commit_sha: string;
  analyzer_version: string;
  rubric_version: string;
  model_call_id: string | null;
  analysis_provenance: Record<string, unknown>;
  findings: unknown;
  findings_hash: string | null;
  review_status: string;
  review_created_at: Date;
  project_id: string;
  project_title: string;
  github_url: string | null;
  github_commit_sha: string | null;
};

type ExistingAppealRow = {
  id: string;
  project_review_id: string | null;
  category: string;
  reason: string;
  evidence_hash: string;
};

export type SubmitProjectReviewAppealResult = Readonly<{
  accepted: true;
  duplicate: boolean;
  appealId: string;
  evidenceHash: string;
}>;

function exactReplay(
  row: ExistingAppealRow | undefined,
  input: { reviewId: string; category: string; reason: string },
) {
  return Boolean(
    row
    && row.project_review_id === input.reviewId
    && row.category === input.category
    && row.reason === input.reason,
  );
}

async function findRequest(
  client: PoolClient,
  userId: string,
  requestId: string,
) {
  const result = await client.query<ExistingAppealRow>(
    `select id, project_review_id, category, reason, evidence_hash
       from appeal
      where user_id = $1 and submission_request_id = $2
      limit 1`,
    [userId, requestId],
  );
  return result.rows[0];
}

export async function submitProjectReviewAppeal(input: {
  userId: string;
  projectId: string;
  projectReviewId: string;
  clientRequestId: string;
  category: "project_finding";
  reason: string;
  now?: Date;
}): Promise<SubmitProjectReviewAppealResult> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!Number.isFinite(now.getTime())) {
    throw new ProjectReviewAppealError("INVALID_TIME", "Appeal timestamp is invalid.");
  }
  if (!UUID_PATTERN.test(input.clientRequestId)) {
    throw new ProjectReviewAppealError("INVALID_REQUEST_ID", "Appeal request id must be a UUID.");
  }
  if (reason.length < 20 || reason.length > 1_000) {
    throw new ProjectReviewAppealError(
      "INVALID_REASON",
      "Give a concise appeal reason from 20 to 1000 characters.",
    );
  }
  if (input.category !== "project_finding") {
    throw new ProjectReviewAppealError(
      "INVALID_CATEGORY",
      "Project reviews only accept the project_finding appeal category.",
    );
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `project-review-appeal:${input.projectReviewId}`,
    ]);
    const owned = await client.query<OwnedReviewRow>(
      `select pr.id as review_id, pr.commit_sha, pr.analyzer_version,
              pr.rubric_version, pr.model_call_id, pr.analysis_provenance,
              pr.findings, pr.findings_hash, pr.status as review_status,
              pr.created_at as review_created_at, p.id as project_id,
              p.title as project_title, p.github_url, p.github_commit_sha
         from project_review pr
         join project p on p.id = pr.project_id
        where pr.id = $1 and p.id = $2 and p.user_id = $3
        for update of pr, p`,
      [input.projectReviewId, input.projectId, input.userId],
    );
    const row = owned.rows[0];
    if (!row) {
      throw new ProjectReviewAppealError("REVIEW_NOT_FOUND", "Project review was not found.");
    }

    const sameRequest = await findRequest(client, input.userId, input.clientRequestId);
    if (sameRequest) {
      if (!exactReplay(sameRequest, {
        reviewId: row.review_id,
        category: input.category,
        reason,
      })) {
        throw new ProjectReviewAppealError(
          "IDEMPOTENCY_MISMATCH",
          "This appeal request id was already used with different input.",
        );
      }
      await client.query("commit");
      return {
        accepted: true,
        duplicate: true,
        appealId: sameRequest.id,
        evidenceHash: sameRequest.evidence_hash,
      };
    }

    if (row.review_status !== "complete" || !Array.isArray(row.findings)) {
      throw new ProjectReviewAppealError(
        "INELIGIBLE_REVIEW",
        "Only a completed stored review can be appealed.",
      );
    }
    const findings = row.findings.every(
      (finding) => finding !== null && typeof finding === "object" && !Array.isArray(finding),
    )
      ? row.findings as Record<string, unknown>[]
      : null;
    if (!findings) {
      throw new ProjectReviewAppealError(
        "INELIGIBLE_REVIEW",
        "The stored review evidence is invalid and cannot be appealed.",
      );
    }

    const alreadyOpen = await client.query<{ id: string }>(
      `select id from appeal
        where project_review_id = $1 and status = any($2::text[])
        limit 1`,
      [row.review_id, OPEN_STATUSES],
    );
    if (alreadyOpen.rows[0]) {
      throw new ProjectReviewAppealError(
        "ALREADY_OPEN",
        "An appeal is already open for this project review.",
      );
    }

    const snapshot = buildProjectReviewAppealEvidence({
      project: {
        id: row.project_id,
        title: row.project_title,
        githubUrl: row.github_url,
        githubCommitSha: row.github_commit_sha,
      },
      review: {
        id: row.review_id,
        commitSha: row.commit_sha,
        analyzerVersion: row.analyzer_version,
        rubricVersion: row.rubric_version,
        modelCallId: row.model_call_id,
        analysisProvenance: row.analysis_provenance,
        findings,
        findingsHash: row.findings_hash,
        status: row.review_status,
        createdAt: row.review_created_at,
      },
      category: input.category,
      capturedAt: now,
    });
    const created = await client.query<{ id: string }>(
      `insert into appeal
        (user_id, project_review_id, category, submission_request_id, reason,
         evidence, evidence_hash, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, 'open', $8, $8)
       on conflict do nothing
       returning id`,
      [
        input.userId,
        row.review_id,
        input.category,
        input.clientRequestId,
        reason,
        JSON.stringify(snapshot.evidence),
        snapshot.evidenceHash,
        now,
      ],
    );
    const createdId = created.rows[0]?.id;
    if (!createdId) {
      const racedRequest = await findRequest(client, input.userId, input.clientRequestId);
      if (exactReplay(racedRequest, {
        reviewId: row.review_id,
        category: input.category,
        reason,
      })) {
        await client.query("commit");
        return {
          accepted: true,
          duplicate: true,
          appealId: racedRequest!.id,
          evidenceHash: racedRequest!.evidence_hash,
        };
      }
      const racedOpen = await client.query<{ id: string }>(
        `select id from appeal
          where project_review_id = $1 and status = any($2::text[])
          limit 1`,
        [row.review_id, OPEN_STATUSES],
      );
      if (racedOpen.rows[0]) {
        throw new ProjectReviewAppealError(
          "ALREADY_OPEN",
          "An appeal is already open for this project review.",
        );
      }
      throw new ProjectReviewAppealError("WRITE_CONFLICT", "Appeal could not be recorded.");
    }

    await client.query(
      `insert into appeal_event
        (appeal_id, actor_user_id, actor_role, event, client_request_id,
         reason, evidence, occurred_at)
       values ($1, $2, 'learner', 'submitted', $3, $4, $5::jsonb, $6)`,
      [
        createdId,
        input.userId,
        input.clientRequestId,
        reason,
        JSON.stringify({
          category: input.category,
          evidenceHash: snapshot.evidenceHash,
          commitSha: row.commit_sha,
          analyzerVersion: row.analyzer_version,
          rubricVersion: row.rubric_version,
          findingsHash: snapshot.evidence.review.findingsHash,
        }),
        now,
      ],
    );
    await client.query(
      `insert into notification (user_id, type, title, body, action_url, created_at)
       select id, 'appeal-updated', 'A project review was appealed',
              'A learner disputed a stored project-review finding. Review the immutable evidence.',
              $1, $2
         from "user"
        where role = 'admin' and status = 'active'`,
      [`/admin/appeals?appeal=${createdId}`, now],
    );
    await client.query("commit");
    return {
      accepted: true,
      duplicate: false,
      appealId: createdId,
      evidenceHash: snapshot.evidenceHash,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
