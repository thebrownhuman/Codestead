import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect, query: mocks.query },
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { hashAppealEvidence } from "@/lib/appeals/evidence";
import {
  PROJECT_REVIEW_ANALYZER_VERSION,
  PROJECT_REVIEW_RUBRIC_VERSION,
} from "@/lib/github/reviewer";

import {
  getProjectReviewCorrection,
  hasCurrentProjectReviewCorrectionLease,
  hasCompleteProjectReviewProvenance,
  listProjectReviewCorrections,
  processOneProjectReviewCorrection,
  processProjectReviewCorrectionBatch,
  ProjectReviewCorrectionError,
  queueProjectReviewCorrection,
  queueProjectReviewCorrectionWithClient,
  requestProjectReviewCorrectionRetry,
} from "../review-correction-service";

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };

function result(rows: Record<string, unknown>[] = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount };
}

function fakeClient(
  handler: (sql: string, params: readonly unknown[]) => QueryResult | Promise<QueryResult>,
) {
  return {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => (
      handler(sql.replace(/\s+/g, " ").trim(), params)
    )),
    release: vi.fn(),
  };
}

const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const REVIEW_ID = "10000000-0000-4000-8000-000000000002";
const REQUEST_ID = "10000000-0000-4000-8000-000000000003";
const PROJECT_ID = "10000000-0000-4000-8000-000000000004";
const CORRECTION_ID = "10000000-0000-4000-8000-000000000005";
const APPEAL_ID = "10000000-0000-4000-8000-000000000006";
const LEARNER_ID = "10000000-0000-4000-8000-000000000007";
const SECOND_CORRECTION_ID = "10000000-0000-4000-8000-000000000008";
const COMMIT_SHA = "a".repeat(40);
const NOW = new Date("2026-07-13T00:00:00.000Z");
const REASON = "The defective review requires a deterministic correction.";

const deterministic = {
  schemaVersion: 1,
  analysisMode: "deterministic_static",
  aiUsed: false,
  promptVersion: null,
  provider: null,
  model: null,
  modelCallId: null,
  rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
  repositoryExecution: "none",
  runnerTemplateId: null,
};

const sourceFindings = [{
  severity: "warning",
  category: "tests",
  message: "Add boundary coverage.",
  evidence: "No boundary test found.",
}];

const baseReview = {
  review_id: REVIEW_ID,
  project_id: PROJECT_ID,
  user_id: LEARNER_ID,
  github_url: "https://github.com/example/project",
  commit_sha: COMMIT_SHA,
  analyzer_version: "source-static-v1",
  rubric_version: PROJECT_REVIEW_RUBRIC_VERSION,
  model_call_id: null,
  analysis_provenance: deterministic,
  findings: sourceFindings,
  findings_hash: hashAppealEvidence(sourceFindings),
  status: "complete",
};

const existingCorrection = {
  id: CORRECTION_ID,
  project_id: PROJECT_ID,
  source_review_id: REVIEW_ID,
  source_appeal_id: null,
  requested_by: ADMIN_ID,
  request_id: REQUEST_ID,
  reason: REASON,
  status: "queued" as const,
  revision: 2,
  user_id: LEARNER_ID,
};

function queueInput(overrides: Record<string, unknown> = {}) {
  return {
    actorUserId: ADMIN_ID,
    sourceReviewId: REVIEW_ID,
    requestId: REQUEST_ID,
    reason: REASON,
    now: NOW,
    ...overrides,
  };
}

function queueClient(options: {
  actor?: Record<string, unknown> | null;
  existingRequest?: Record<string, unknown> | null;
  review?: Record<string, unknown> | null;
  appeal?: Record<string, unknown> | null;
  appealCorrection?: Record<string, unknown> | null;
  revision?: number | null;
  createdId?: string | null;
} = {}) {
  return fakeClient((sql) => {
    if (sql.includes('select role, status from "user"')) {
      return result(options.actor === null ? [] : [options.actor ?? { role: "admin", status: "active" }]);
    }
    if (sql.includes("where c.requested_by = $1 and c.request_id = $2")) {
      return result(options.existingRequest ? [options.existingRequest] : []);
    }
    if (sql.includes("select r.id as review_id")) {
      return result(options.review === null ? [] : [options.review ?? baseReview]);
    }
    if (sql.includes("select id, project_review_id, status, decision from appeal")) {
      return result(options.appeal === null ? [] : [options.appeal ?? {
        id: APPEAL_ID,
        project_review_id: REVIEW_ID,
        status: "overturned",
        decision: "overturned",
      }]);
    }
    if (sql.includes("where c.source_appeal_id = $1")) {
      return result(options.appealCorrection ? [options.appealCorrection] : []);
    }
    if (sql.includes("select coalesce(max(revision)")) {
      return result(options.revision === null ? [] : [{ next_revision: options.revision ?? 3 }]);
    }
    if (sql.includes("insert into project_review_correction") && sql.includes("returning id")) {
      return result(options.createdId === null ? [] : [{ id: options.createdId ?? CORRECTION_ID }]);
    }
    return result();
  });
}

const claimedRow = {
  id: CORRECTION_ID,
  project_id: PROJECT_ID,
  source_review_id: REVIEW_ID,
  source_appeal_id: null,
  requested_by: ADMIN_ID,
  user_id: LEARNER_ID,
  revision: 2,
  reason: REASON,
  github_url: "https://github.com/example/project",
  source_commit_sha: COMMIT_SHA,
  source_analyzer_version: "source-static-v1",
  source_rubric_version: PROJECT_REVIEW_RUBRIC_VERSION,
  source_provenance: deterministic,
  source_findings_hash: hashAppealEvidence(sourceFindings),
  target_analyzer_version: PROJECT_REVIEW_ANALYZER_VERSION,
  target_rubric_version: PROJECT_REVIEW_RUBRIC_VERSION,
  attempt_count: 0,
};

function claimClient(options: {
  selected?: Record<string, unknown> | null;
  expired?: Record<string, unknown>[];
} = {}) {
  return fakeClient((sql) => {
    if (sql.includes("where status = 'running' and lease_expires_at < $1")) {
      return result(options.expired ?? []);
    }
    if (sql.includes("select c.id, c.project_id, c.source_review_id") && sql.includes("for update of c skip locked")) {
      return result(options.selected === null ? [] : [options.selected ?? claimedRow]);
    }
    return result();
  });
}

function correctionResult(overrides: Record<string, unknown> = {}) {
  return {
    repositoryUrl: "https://github.com/example/project",
    defaultBranch: "main",
    commitSha: COMMIT_SHA,
    filesReviewed: 3,
    findings: [{
      severity: "important",
      category: "security",
      message: "Validate input.",
      evidence: "Input reaches a parser.",
    }],
    analyzerVersion: PROJECT_REVIEW_ANALYZER_VERSION,
    rubricVersion: PROJECT_REVIEW_RUBRIC_VERSION,
    provenance: deterministic,
    ...overrides,
  };
}

function successPersistenceClient(options: {
  lease?: Record<string, unknown> | null;
  source?: Record<string, unknown> | null;
  projectState?: Record<string, unknown> | null;
  effective?: Record<string, unknown> | null;
  updateCount?: number;
} = {}) {
  return fakeClient((sql) => {
    if (sql.includes("select status, lease_owner, attempt_count") && sql.includes("from project_review_correction")) {
      return result(options.lease === null ? [] : [options.lease ?? {
        status: "running",
        lease_owner: "worker-1",
        attempt_count: 1,
      }]);
    }
    if (sql.includes("select project_id, commit_sha, analyzer_version") && sql.includes("from project_review where id")) {
      return result(options.source === null ? [] : [options.source ?? {
        project_id: PROJECT_ID,
        commit_sha: COMMIT_SHA,
        analyzer_version: "source-static-v1",
        rubric_version: PROJECT_REVIEW_RUBRIC_VERSION,
        model_call_id: null,
        analysis_provenance: deterministic,
        findings: sourceFindings,
        findings_hash: hashAppealEvidence(sourceFindings),
        status: "complete",
      }]);
    }
    if (sql.includes("select p.github_commit_sha")) {
      return result(options.projectState === null ? [] : [options.projectState ?? {
        github_commit_sha: COMMIT_SHA,
        latest_review_id: REVIEW_ID,
      }]);
    }
    if (sql.includes("select e.source_review_id")) {
      return result(options.effective ? [options.effective] : []);
    }
    if (sql.includes("set status = 'succeeded'")) {
      return result([], options.updateCount ?? 1);
    }
    return result();
  });
}

function failurePersistenceClient(updateCount = 1) {
  return fakeClient((sql) => {
    if (sql.includes("set status = 'failed'") && sql.includes("last_error_code = $2")) {
      return result([], updateCount);
    }
    return result();
  });
}

function retryClient(options: {
  actor?: Record<string, unknown> | null;
  correction?: Record<string, unknown> | null;
  prior?: Record<string, unknown> | null;
  updateCount?: number;
} = {}) {
  return fakeClient((sql) => {
    if (sql.includes('select role, status from "user"')) {
      return result(options.actor === null ? [] : [options.actor ?? { role: "admin", status: "active" }]);
    }
    if (sql.includes("select c.id, c.status, c.attempt_count")) {
      return result(options.correction === null ? [] : [options.correction ?? {
        id: CORRECTION_ID,
        status: "failed",
        attempt_count: 1,
        last_error_code: "STATIC_ANALYSIS_FAILED",
        user_id: LEARNER_ID,
      }]);
    }
    if (sql.includes("where correction_id = $1 and request_id = $2")) {
      return result(options.prior ? [options.prior] : []);
    }
    if (sql.includes("set status = 'queued'")) {
      return result([], options.updateCount ?? 1);
    }
    return result();
  });
}

describe("project review correction contracts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.writeAuditEvent.mockResolvedValue(undefined);
  });

  it("accepts explicit deterministic/no-AI provenance and rejects hidden execution authority", () => {
    expect(hasCompleteProjectReviewProvenance(
      deterministic,
      null,
      PROJECT_REVIEW_RUBRIC_VERSION,
    )).toBe(true);
    expect(hasCompleteProjectReviewProvenance({
      ...deterministic,
      repositoryExecution: "build",
      runnerTemplateId: "unapproved-template",
    }, null, PROJECT_REVIEW_RUBRIC_VERSION)).toBe(false);
    expect(hasCompleteProjectReviewProvenance({
      ...deterministic,
      aiUsed: true,
    }, null, PROJECT_REVIEW_RUBRIC_VERSION)).toBe(false);
    expect(hasCompleteProjectReviewProvenance(
      deterministic,
      null,
      "different-rubric-v2",
    )).toBe(false);
  });

  it("accepts AI provenance only when a real prompt, provider, model and persisted call agree", () => {
    const modelCallId = "10000000-0000-4000-8000-000000000001";
    const ai = {
      ...deterministic,
      analysisMode: "ai_assisted",
      aiUsed: true,
      promptVersion: "project-review-v2",
      provider: "nvidia_nim",
      model: "approved-review-model",
      modelCallId,
    };
    expect(hasCompleteProjectReviewProvenance(ai, modelCallId, PROJECT_REVIEW_RUBRIC_VERSION)).toBe(true);
    expect(hasCompleteProjectReviewProvenance(ai, null, PROJECT_REVIEW_RUBRIC_VERSION)).toBe(false);
    expect(hasCompleteProjectReviewProvenance(
      { ...ai, promptVersion: null },
      modelCallId,
      PROJECT_REVIEW_RUBRIC_VERSION,
    )).toBe(false);
  });

  it("rejects malformed queue identity before opening a database transaction", async () => {
    await expect(queueProjectReviewCorrection({
      actorUserId: "admin",
      sourceReviewId: "not-a-review-id",
      requestId: "10000000-0000-4000-8000-000000000001",
      reason: "This defective review requires a deterministic correction.",
    })).rejects.toBeInstanceOf(ProjectReviewCorrectionError);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects unsafe worker and correction identifiers before claiming a lease", async () => {
    await expect(processOneProjectReviewCorrection({ workerId: "x" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(processOneProjectReviewCorrection({
      workerId: "valid-worker",
      correctionId: "not-a-uuid",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("bounds durable worker batches before touching the queue", async () => {
    await expect(processProjectReviewCorrectionBatch({
      workerId: "valid-worker",
      limit: 11,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("fences a reused worker identity by the unique attempt generation", () => {
    expect(hasCurrentProjectReviewCorrectionLease({
      status: "running",
      leaseOwner: "same-host-worker",
      attemptCount: 2,
    }, {
      workerId: "same-host-worker",
      attemptCount: 2,
    })).toBe(true);
    expect(hasCurrentProjectReviewCorrectionLease({
      status: "running",
      leaseOwner: "same-host-worker",
      attemptCount: 2,
    }, {
      workerId: "same-host-worker",
      attemptCount: 1,
    })).toBe(false);
  });

  it("rejects malformed and incomplete provenance across both analysis modes", () => {
    for (const value of [null, [], "bad", { ...deterministic, schemaVersion: 2 }, {
      ...deterministic,
      runnerTemplateId: "template",
    }, {
      ...deterministic,
      analysisMode: "unknown",
    }]) {
      expect(hasCompleteProjectReviewProvenance(
        value,
        null,
        PROJECT_REVIEW_RUBRIC_VERSION,
      )).toBe(false);
    }

    const modelCallId = "10000000-0000-4000-8000-000000000099";
    const ai = {
      ...deterministic,
      analysisMode: "ai_assisted",
      aiUsed: true,
      promptVersion: "prompt-v1",
      provider: "nvidia_nim",
      model: "review-model",
      modelCallId,
    };
    for (const override of [
      { aiUsed: false },
      { promptVersion: "" },
      { provider: "" },
      { model: "" },
      { modelCallId: null },
    ]) {
      expect(hasCompleteProjectReviewProvenance(
        { ...ai, ...override },
        modelCallId,
        PROJECT_REVIEW_RUBRIC_VERSION,
      )).toBe(false);
    }
  });

  it("queues a correction with immutable event evidence and learner notification", async () => {
    const client = queueClient();
    const queued = await queueProjectReviewCorrectionWithClient(
      client as never,
      queueInput(),
    );

    expect(queued).toEqual({
      correctionId: CORRECTION_ID,
      projectId: PROJECT_ID,
      sourceReviewId: REVIEW_ID,
      userId: LEARNER_ID,
      status: "queued",
      revision: 3,
      duplicate: false,
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into project_review_correction_event"),
      expect.arrayContaining([CORRECTION_ID, ADMIN_ID, "admin", "queued", REQUEST_ID, REASON]),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("project-review-correction-queued"),
      [LEARNER_ID, NOW],
    );
  });

  it("returns exact queue replays and rejects changed idempotent requests", async () => {
    const exact = queueClient({ existingRequest: existingCorrection });
    await expect(queueProjectReviewCorrectionWithClient(
      exact as never,
      queueInput(),
    )).resolves.toMatchObject({ correctionId: CORRECTION_ID, duplicate: true, revision: 2 });

    const changed = queueClient({
      existingRequest: { ...existingCorrection, reason: "A different correction reason with enough detail." },
    });
    await expect(queueProjectReviewCorrectionWithClient(
      changed as never,
      queueInput(),
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it.each([
    ["ADMIN_REQUIRED", { actor: { role: "learner", status: "active" } }, {}],
    ["REVIEW_NOT_FOUND", { review: null }, {}],
    ["REVIEW_NOT_CORRECTABLE", { review: { ...baseReview, github_url: null } }, {}],
    ["REVIEW_NOT_CORRECTABLE", { review: { ...baseReview, findings: [null] } }, {}],
    ["PROVENANCE_INCOMPLETE", { review: { ...baseReview, analysis_provenance: { ...deterministic, aiUsed: true } } }, {}],
    ["APPEAL_NOT_OVERTURNED", { appeal: { id: APPEAL_ID, project_review_id: REVIEW_ID, status: "open", decision: null } }, { sourceAppealId: APPEAL_ID }],
    ["CORRECTION_ALREADY_EXISTS", { appealCorrection: { ...existingCorrection, source_appeal_id: APPEAL_ID, reason: "A conflicting prior reason with detail." } }, { sourceAppealId: APPEAL_ID }],
    ["SOURCE_EVIDENCE_CHANGED", { review: { ...baseReview, findings_hash: "wrong-hash" } }, {}],
    ["WRITE_CONFLICT", { createdId: null }, {}],
  ] as const)("fails queueing safely with %s", async (code, options, inputOverride) => {
    const client = queueClient(options);
    await expect(queueProjectReviewCorrectionWithClient(
      client as never,
      queueInput(inputOverride),
    )).rejects.toMatchObject({ code });
  });

  it("replays the appeal-linked correction only when every field agrees", async () => {
    const linked = {
      ...existingCorrection,
      source_appeal_id: APPEAL_ID,
    };
    const client = queueClient({ appealCorrection: linked });
    await expect(queueProjectReviewCorrectionWithClient(
      client as never,
      queueInput({ sourceAppealId: APPEAL_ID }),
    )).resolves.toMatchObject({ correctionId: CORRECTION_ID, duplicate: true });
  });

  it("commits the transactional queue wrapper and rolls back authorization failures", async () => {
    const success = queueClient({ existingRequest: existingCorrection });
    mocks.connect.mockResolvedValueOnce(success);
    await expect(queueProjectReviewCorrection(queueInput())).resolves.toMatchObject({ duplicate: true });
    expect(success.query).toHaveBeenCalledWith("commit");
    expect(success.release).toHaveBeenCalledOnce();

    const denied = queueClient({ actor: { role: "learner", status: "active" } });
    mocks.connect.mockResolvedValueOnce(denied);
    await expect(queueProjectReviewCorrection({
      ...queueInput(),
      requestId: "10000000-0000-4000-8000-000000000010",
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(denied.query).toHaveBeenCalledWith("rollback");
    expect(denied.release).toHaveBeenCalledOnce();
  });

  it("recovers expired leases at both retryable and dead-letter generations before reporting an empty queue", async () => {
    const client = claimClient({
      selected: null,
      expired: [
        { id: CORRECTION_ID, attempt_count: 1, lease_owner: "old-worker" },
        { id: SECOND_CORRECTION_ID, attempt_count: 3, lease_owner: null },
      ],
    });
    mocks.connect.mockResolvedValueOnce(client);

    await expect(processOneProjectReviewCorrection({
      workerId: "worker-1",
      now: NOW,
    })).resolves.toEqual({ processed: false });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("project_review_correction_event"),
      expect.arrayContaining([CORRECTION_ID, null, "system", "analysis_failed"]),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("from \"user\" where role = 'admin'"),
      expect.arrayContaining(["project-review-correction-failed"]),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("from \"user\" where role = 'admin'"),
      expect.arrayContaining(["project-review-correction-dead-lettered"]),
    );
  });

  it("rolls back a claim whose project no longer has a repository URL", async () => {
    const client = claimClient({ selected: { ...claimedRow, github_url: null } });
    mocks.connect.mockResolvedValueOnce(client);
    await expect(processOneProjectReviewCorrection({
      workerId: "worker-1",
      now: NOW,
    })).rejects.toMatchObject({ code: "REVIEW_NOT_CORRECTABLE" });
    expect(client.query).toHaveBeenCalledWith("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("persists successful corrective evidence and applies a newer projection revision", async () => {
    const claim = claimClient();
    const persistence = successPersistenceClient({
      effective: {
        source_review_id: REVIEW_ID,
        correction_id: SECOND_CORRECTION_ID,
        revision: "4",
        correction_revision: 1,
      },
    });
    mocks.connect.mockResolvedValueOnce(claim).mockResolvedValueOnce(persistence);
    mocks.writeAuditEvent.mockRejectedValueOnce(new Error("audit transport unavailable"));
    const analyzer = vi.fn().mockResolvedValue(correctionResult());

    await expect(processOneProjectReviewCorrection({
      workerId: "worker-1",
      analyzer,
      now: NOW,
    })).resolves.toMatchObject({
      processed: true,
      succeeded: true,
      correctionId: CORRECTION_ID,
      projectionApplied: true,
      replayed: false,
    });
    expect(analyzer).toHaveBeenCalledWith("https://github.com/example/project", COMMIT_SHA);
    expect(persistence.query).toHaveBeenCalledWith(
      expect.stringContaining("update project_review_effective"),
      expect.arrayContaining([PROJECT_ID, REVIEW_ID, CORRECTION_ID, COMMIT_SHA]),
    );
    expect(persistence.query).toHaveBeenCalledWith("commit");
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "success",
      metadata: expect.objectContaining({ projectionApplied: true }),
    }));
  });

  it("preserves a successful correction without replacing a newer effective review", async () => {
    const claim = claimClient();
    const persistence = successPersistenceClient({
      projectState: {
        github_commit_sha: COMMIT_SHA,
        latest_review_id: "10000000-0000-4000-8000-000000000099",
      },
    });
    mocks.connect.mockResolvedValueOnce(claim).mockResolvedValueOnce(persistence);

    await expect(processOneProjectReviewCorrection({
      workerId: "worker-1",
      analyzer: vi.fn().mockResolvedValue(correctionResult()),
      now: NOW,
    })).resolves.toMatchObject({
      processed: true,
      succeeded: true,
      projectionApplied: false,
    });
    expect(persistence.query).not.toHaveBeenCalledWith(
      expect.stringContaining("insert into project_review_effective"),
      expect.anything(),
    );
    expect(persistence.query).toHaveBeenCalledWith(
      expect.stringContaining("project_review_correction_event"),
      expect.arrayContaining([CORRECTION_ID, null, "system", "projection_skipped"]),
    );
  });

  it.each([
    ["STATIC_ANALYSIS_FAILED", new Error("repository read failed"), 0],
    ["PINNED_COMMIT_MISMATCH", new Error("Unable to resolve exact pinned commit"), 2],
  ] as const)("records analyzer failure as %s with bounded retry state", async (code, failure, attemptCount) => {
    const claim = claimClient({ selected: { ...claimedRow, attempt_count: attemptCount } });
    const persistence = failurePersistenceClient();
    mocks.connect.mockResolvedValueOnce(claim).mockResolvedValueOnce(persistence);
    mocks.writeAuditEvent.mockRejectedValueOnce(new Error("audit transport unavailable"));

    await expect(processOneProjectReviewCorrection({
      workerId: "worker-1",
      analyzer: vi.fn().mockRejectedValue(failure),
      now: NOW,
    })).resolves.toEqual({
      processed: true,
      succeeded: false,
      correctionId: CORRECTION_ID,
      errorCode: code,
    });
    expect(persistence.query).toHaveBeenCalledWith(
      expect.stringContaining("set status = 'failed'"),
      expect.arrayContaining([CORRECTION_ID, code]),
    );
    expect(persistence.query).toHaveBeenCalledWith(
      expect.stringContaining("from \"user\" where role = 'admin'"),
      expect.arrayContaining([
        attemptCount === 2
          ? "project-review-correction-dead-lettered"
          : "project-review-correction-failed",
      ]),
    );
  });

  it.each([
    ["PINNED_COMMIT_MISMATCH", {}, { commitSha: "b".repeat(40) }],
    ["PROVENANCE_INCOMPLETE", {}, { provenance: { ...deterministic, aiUsed: true } }],
    ["SOURCE_EVIDENCE_CHANGED", { source: { ...baseReview, project_id: PROJECT_ID, findings_hash: "changed" } }, {}],
    ["WRITE_CONFLICT", { lease: { status: "running", lease_owner: "different-worker", attempt_count: 1 } }, {}],
  ] as const)("turns persistence validation failure %s into a safe failed correction", async (
    code,
    persistenceOptions,
    resultOverride,
  ) => {
    const claim = claimClient();
    const attemptedSuccess = successPersistenceClient(persistenceOptions);
    const failed = failurePersistenceClient();
    mocks.connect
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce(attemptedSuccess)
      .mockResolvedValueOnce(failed);

    await expect(processOneProjectReviewCorrection({
      workerId: "worker-1",
      analyzer: vi.fn().mockResolvedValue(correctionResult(resultOverride)),
      now: NOW,
    })).resolves.toMatchObject({ processed: true, succeeded: false, errorCode: code });
    expect(attemptedSuccess.query).toHaveBeenCalledWith("rollback");
    expect(failed.query).toHaveBeenCalledWith("commit");
  });

  it("does not append failure evidence after a lost failure lease update", async () => {
    const claim = claimClient();
    const failure = failurePersistenceClient(0);
    mocks.connect.mockResolvedValueOnce(claim).mockResolvedValueOnce(failure);

    await expect(processOneProjectReviewCorrection({
      workerId: "worker-1",
      analyzer: vi.fn().mockRejectedValue(new Error("network")),
      now: NOW,
    })).resolves.toMatchObject({ succeeded: false, errorCode: "STATIC_ANALYSIS_FAILED" });
    expect(failure.query).not.toHaveBeenCalledWith(
      expect.stringContaining("project_review_correction_event"),
      expect.anything(),
    );
    expect(failure.query).toHaveBeenCalledWith("commit");
  });

  it("reports a bounded batch with one failure and then stops on an empty claim", async () => {
    const firstClaim = claimClient();
    const firstFailure = failurePersistenceClient();
    const emptyClaim = claimClient({ selected: null });
    mocks.connect
      .mockResolvedValueOnce(firstClaim)
      .mockResolvedValueOnce(firstFailure)
      .mockResolvedValueOnce(emptyClaim);

    await expect(processProjectReviewCorrectionBatch({
      workerId: "worker-1",
      limit: 2,
      analyzer: vi.fn().mockRejectedValue(new Error("temporary failure")),
    })).resolves.toMatchObject({ processed: 1, succeeded: 0, failed: 1 });
  });

  it("rejects malformed retry input before opening a transaction", async () => {
    await expect(requestProjectReviewCorrectionRetry({
      actorUserId: ADMIN_ID,
      correctionId: "bad-id",
      requestId: REQUEST_ID,
      reason: REASON,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["ADMIN_REQUIRED", { actor: { role: "learner", status: "active" } }],
    ["REVIEW_NOT_FOUND", { correction: null }],
    ["IDEMPOTENCY_MISMATCH", { prior: { actor_user_id: ADMIN_ID, event: "retry_queued", reason: "different reason" } }],
    ["CORRECTION_DEAD_LETTERED", { correction: { id: CORRECTION_ID, status: "failed", attempt_count: 3, last_error_code: "FAILED", user_id: LEARNER_ID } }],
    ["CORRECTION_NOT_RETRYABLE", { correction: { id: CORRECTION_ID, status: "queued", attempt_count: 1, last_error_code: null, user_id: LEARNER_ID } }],
    ["WRITE_CONFLICT", { updateCount: 0 }],
  ] as const)("rolls back retry outcome %s", async (code, options) => {
    const client = retryClient(options);
    mocks.connect.mockResolvedValueOnce(client);
    await expect(requestProjectReviewCorrectionRetry({
      actorUserId: ADMIN_ID,
      correctionId: CORRECTION_ID,
      requestId: REQUEST_ID,
      reason: REASON,
      now: NOW,
    })).rejects.toMatchObject({ code });
    expect(client.query).toHaveBeenCalledWith("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns an exact retry replay without appending another event", async () => {
    const client = retryClient({
      prior: { actor_user_id: ADMIN_ID, event: "retry_queued", reason: REASON },
    });
    mocks.connect.mockResolvedValueOnce(client);
    await expect(requestProjectReviewCorrectionRetry({
      actorUserId: ADMIN_ID,
      correctionId: CORRECTION_ID,
      requestId: REQUEST_ID,
      reason: REASON,
      now: NOW,
    })).resolves.toEqual({
      correctionId: CORRECTION_ID,
      userId: LEARNER_ID,
      status: "failed",
      attemptCount: 1,
      duplicate: true,
    });
    expect(client.query).toHaveBeenCalledWith("commit");
  });

  it("queues an authorized retry and records its prior failure evidence", async () => {
    const client = retryClient();
    mocks.connect.mockResolvedValueOnce(client);
    await expect(requestProjectReviewCorrectionRetry({
      actorUserId: ADMIN_ID,
      correctionId: CORRECTION_ID,
      requestId: REQUEST_ID,
      reason: `  ${REASON}  `,
      now: NOW,
    })).resolves.toEqual({
      correctionId: CORRECTION_ID,
      userId: LEARNER_ID,
      status: "queued",
      attemptCount: 1,
      duplicate: false,
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("project_review_correction_event"),
      expect.arrayContaining([CORRECTION_ID, ADMIN_ID, "admin", "retry_queued", REQUEST_ID, REASON]),
    );
    expect(client.query).toHaveBeenCalledWith("commit");
  });

  it("validates list bounds and maps nullable lifecycle fields for all scope", async () => {
    await expect(listProjectReviewCorrections({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const createdAt = new Date("2026-07-01T00:00:00.000Z");
    const completedAt = new Date("2026-07-02T00:00:00.000Z");
    mocks.query.mockResolvedValueOnce(result([{
      id: CORRECTION_ID,
      project_id: PROJECT_ID,
      project_title: "Compiler visualizer",
      user_id: LEARNER_ID,
      learner_name: "Learner",
      source_review_id: REVIEW_ID,
      source_appeal_id: APPEAL_ID,
      revision: "2",
      source_commit_sha: COMMIT_SHA,
      status: "succeeded",
      attempt_count: "1",
      last_error_code: null,
      projection_applied: false,
      dead_lettered_at: null,
      created_at: createdAt,
      completed_at: completedAt,
    }]));

    await expect(listProjectReviewCorrections({ scope: "all", limit: 25 })).resolves.toEqual([{
      id: CORRECTION_ID,
      projectId: PROJECT_ID,
      projectTitle: "Compiler visualizer",
      userId: LEARNER_ID,
      learnerName: "Learner",
      sourceReviewId: REVIEW_ID,
      sourceAppealId: APPEAL_ID,
      revision: 2,
      sourceCommitSha: COMMIT_SHA,
      status: "succeeded",
      attemptCount: 1,
      lastErrorCode: null,
      projectionApplied: false,
      deadLettered: false,
      deadLetteredAt: null,
      createdAt: createdAt.toISOString(),
      completedAt: completedAt.toISOString(),
    }]);
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [false, 25]);
  });

  it("rejects unknown correction detail and maps evidence/timeline integrity", async () => {
    await expect(getProjectReviewCorrection("bad-id")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    mocks.query.mockResolvedValueOnce(result()).mockResolvedValueOnce(result());
    await expect(getProjectReviewCorrection(CORRECTION_ID)).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });

    const evidence = { schemaVersion: 1, result: "preserved" };
    const eventEvidence = { schemaVersion: 1, event: "queued" };
    const createdAt = new Date("2026-07-01T00:00:00.000Z");
    const startedAt = new Date("2026-07-01T00:01:00.000Z");
    const completedAt = new Date("2026-07-01T00:02:00.000Z");
    const deadLetteredAt = new Date("2026-07-01T00:03:00.000Z");
    mocks.query.mockResolvedValueOnce(result([{
      id: CORRECTION_ID,
      project_id: PROJECT_ID,
      project_title: "Compiler visualizer",
      user_id: LEARNER_ID,
      learner_name: "Learner",
      source_review_id: REVIEW_ID,
      source_appeal_id: null,
      requested_by: ADMIN_ID,
      revision: "2",
      reason: REASON,
      source_commit_sha: COMMIT_SHA,
      source_analyzer_version: "source-static-v1",
      source_rubric_version: PROJECT_REVIEW_RUBRIC_VERSION,
      source_provenance: deterministic,
      source_findings_hash: hashAppealEvidence(sourceFindings),
      target_analyzer_version: PROJECT_REVIEW_ANALYZER_VERSION,
      target_rubric_version: PROJECT_REVIEW_RUBRIC_VERSION,
      status: "failed",
      attempt_count: "3",
      last_error_code: "STATIC_ANALYSIS_FAILED",
      result_findings: null,
      result_findings_hash: null,
      result_provenance: null,
      evidence,
      evidence_hash: hashAppealEvidence(evidence),
      projection_applied: null,
      created_at: createdAt,
      started_at: startedAt,
      completed_at: completedAt,
      dead_lettered_at: deadLetteredAt,
    }])).mockResolvedValueOnce(result([{
      id: "event-1",
      actor_role: "system",
      event: "analysis_failed",
      reason: "Static analysis failed safely.",
      evidence: eventEvidence,
      evidence_hash: "tampered",
      occurred_at: completedAt,
    }]));

    const detail = await getProjectReviewCorrection(CORRECTION_ID);
    expect(detail.correction).toMatchObject({
      id: CORRECTION_ID,
      revision: 2,
      attemptCount: 3,
      evidenceHashValid: true,
      deadLettered: true,
      deadLetteredAt: deadLetteredAt.toISOString(),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    });
    expect(detail.timeline).toEqual([expect.objectContaining({
      id: "event-1",
      evidenceHashValid: false,
      occurredAt: completedAt.toISOString(),
    })]);
  });
});
