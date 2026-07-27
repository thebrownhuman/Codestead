import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitRunnerJob: vi.fn(),
  applyAssessmentMasteryProjectionRepair: vi.fn(),
  beginRunnerDispatch: vi.fn(),
  correctionMasteryLanguageContext: vi.fn(),
  correctionTarget: vi.fn(),
  effectiveAnswers: vi.fn(),
  gradeExamSubmission: vi.fn(),
  masteryEffect: vi.fn(),
  poolConnect: vi.fn(),
  poolQuery: vi.fn(),
  reconcileAssessmentCorrectionCompletion: vi.fn(),
  recordRunnerDispatch: vi.fn(),
  refreshRunnerAdmission: vi.fn(),
  replaceFormEvidence: vi.fn(),
  reviewedReplacement: vi.fn(),
  runnerEvidenceManifest: vi.fn(),
  settleRunnerJob: vi.fn(),
  configuredRunnerClient: vi.fn(),
  submit: vi.fn(),
  verifyImpactSnapshot: vi.fn(),
  waitForJob: vi.fn(),
  waitFrom: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.poolConnect, query: mocks.poolQuery },
}));
vi.mock("@/lib/security/audit-writer", () => ({
  writeAuditEvent: mocks.writeAuditEvent,
}));
vi.mock("@/app/api/exams/_lib/policy", () => ({
  gradeExamSubmission: mocks.gradeExamSubmission,
}));
vi.mock("../completion", () => ({
  reconcileAssessmentCorrectionCompletion:
    mocks.reconcileAssessmentCorrectionCompletion,
}));
vi.mock("../mastery-repair", () => ({
  applyAssessmentMasteryProjectionRepair:
    mocks.applyAssessmentMasteryProjectionRepair,
}));
vi.mock("../domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../domain")>();
  return {
    ...actual,
    correctionMasteryLanguageContext:
      mocks.correctionMasteryLanguageContext,
    correctionTarget: mocks.correctionTarget,
    effectiveAnswers: mocks.effectiveAnswers,
    masteryEffect: mocks.masteryEffect,
    replaceFormEvidence: mocks.replaceFormEvidence,
    reviewedReplacement: mocks.reviewedReplacement,
    runnerEvidenceManifest: mocks.runnerEvidenceManifest,
    verifyImpactSnapshot: mocks.verifyImpactSnapshot,
  };
});
vi.mock("@/lib/runner/admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runner/admission")>();
  return {
    ...actual,
    admitRunnerJob: mocks.admitRunnerJob,
    beginRunnerDispatch: mocks.beginRunnerDispatch,
    recordRunnerDispatch: mocks.recordRunnerDispatch,
    refreshRunnerAdmission: mocks.refreshRunnerAdmission,
    settleRunnerJob: mocks.settleRunnerJob,
  };
});
vi.mock("@/lib/runner/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runner/client")>();
  return { ...actual, configuredRunnerClient: mocks.configuredRunnerClient };
});

import { AssessmentCorrectionError } from "../domain";
import { configuredRegradeExecutor, type RegradeExecutionInput } from "../runner-executor";
import { processOneAssessmentRegrade } from "../worker";
import { RunnerAdmissionError, type RunnerAdmission } from "@/lib/runner/admission";

const DIGEST = `sha256:${"a".repeat(64)}`;
const admission: RunnerAdmission = {
  submissionId: "10000000-0000-4000-8000-000000000001",
  runnerJobId: "20000000-0000-4000-8000-000000000001",
  userId: "learner-1",
  requestId: "correction-admission-request",
  requestHash: "b".repeat(64),
  submissionType: "assessment_correction_regrade",
  status: "queued",
  remoteJobId: null,
  result: null,
  runtimeImageDigest: "pending-runner-result",
  queuedAt: new Date("2026-07-13T00:00:00.000Z"),
  duplicate: false,
};
const execution: RegradeExecutionInput = {
  jobId: "30000000-0000-4000-8000-000000000001",
  jobAttemptCount: 1,
  runnerRequestGeneration: 1,
  correctionId: "40000000-0000-4000-8000-000000000001",
  attemptId: "50000000-0000-4000-8000-000000000001",
  userId: "learner-1",
  itemId: "python.item-1",
  language: "python",
  expectedRuntimeVersion: "Python 3.14",
  sourceCode: "print(1)\n",
  evidence: {
    kind: "runner-tests",
    bundleVersion: "reviewed-v2",
    tests: [{
      id: "hidden-1",
      visibility: "HIDDEN",
      category: "edge",
      stdin: "",
      expectedStdout: "1\n",
      comparison: "EXACT",
      critical: true,
    }],
  },
  expectedRuntimeImageDigest: DIGEST,
};
const runnerResult = {
  status: "ACCEPTED",
  imageDigest: DIGEST,
  runtimeVersion: "Python 3.14",
  compile: { status: "OK", stdout: "", stderr: "", exitCode: 0 },
  tests: [{ id: "hidden-1", visibility: "HIDDEN", category: "edge", status: "PASSED", feedbackCode: "OK" }],
  totals: { passed: 1, failed: 0, total: 1 },
};
function completedJob(jobId = "remote-job-a") {
  return {
    jobId,
    submissionId: "remote-submission",
    correlationId: "remote-correlation",
    requestHash: "c".repeat(64),
    state: "COMPLETED" as const,
    queuePosition: null,
    result: runnerResult,
  };
}

type OutboxReleaseCandidate = {
  readonly id: string;
  readonly operation_id: string;
  readonly idempotency_authority_sha256: string;
  readonly idempotency_original_payload_sha256: string;
  readonly delivery_hold_version: string;
};

const WORKER_NOW = new Date("2026-07-13T00:00:00.000Z");
const ORIGINAL_RESULT_HASH = "1".repeat(64);
const replacementEvidence = {
  kind: "runner-tests" as const,
  bundleVersion: "reviewed-v2",
  runtimeImageDigest: DIGEST,
  tests: execution.evidence.tests,
};
const workerSnapshot = {
  form: {
    courseId: "course-1",
    moduleId: "module-1",
    contentVersion: "content-v1",
    items: [{
      id: execution.itemId,
      skillId: "skill-1",
      gradingEvidence: execution.evidence,
    }],
  },
  originalResult: { outcome: "failed" },
};
const claimedWorkerRow = {
  id: execution.jobId,
  correction_id: execution.correctionId,
  impact_id: "60000000-0000-4000-8000-000000000001",
  attempt_count: 0,
  runner_request_generation: execution.runnerRequestGeneration,
  attempt_id: execution.attemptId,
  user_id: "70000000-0000-4000-8000-000000000001",
  exam_session_id: null,
  snapshot: workerSnapshot,
  snapshot_hash: "2".repeat(64),
  form_hash: "3".repeat(64),
  answer_set_hash: "4".repeat(64),
  original_result_hash: ORIGINAL_RESULT_HASH,
  replacement_evidence: replacementEvidence,
  faulty_bundle_version: "faulty-v1",
  faulty_evidence_hash: "5".repeat(64),
  course_id: workerSnapshot.form.courseId,
  module_id: workerSnapshot.form.moduleId,
  item_id: execution.itemId,
  skill_id: "skill-1",
  content_version: workerSnapshot.form.contentVersion,
  created_by: "80000000-0000-4000-8000-000000000001",
  source_appeal_id: null,
  review_hash: "6".repeat(64),
};
const correctedWorkerResult = {
  outcome: "passed",
  gradingStatus: "graded",
  infrastructureFailure: false,
};

function normalizeSql(sql: string) {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}

type MockQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

function queryResult(
  rows: Record<string, unknown>[] = [],
  rowCount = rows.length,
): MockQueryResult {
  return { rows, rowCount };
}

function databaseClient(handler: (
  sql: string,
  values?: readonly unknown[],
) => Promise<MockQueryResult>) {
  return {
    query: vi.fn(handler),
    release: vi.fn(),
  };
}

function workerClaimClient() {
  return databaseClient(async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("join assessment_correction_impact")) {
      return queryResult([claimedWorkerRow], 1);
    }
    if (
      normalized.includes("from assessment_regrade_job j")
      && normalized.includes("j.status = 'running'")
    ) {
      return queryResult([], 0);
    }
    return queryResult([], 1);
  });
}

function workerPersistClient(input: {
  readonly outboxRow: OutboxReleaseCandidate | null;
  readonly releaseError?: Error;
  readonly releaseRows?: ReadonlyArray<{
    readonly outbox_id: string;
    readonly operation_id: string;
  }>;
}) {
  return databaseClient(async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes('from "user"')) {
      return queryResult([{
        status: "active",
        name: "Ada Learner",
        email: "ada@example.com",
      }], 1);
    }
    if (normalized.startsWith("select status from assessment_regrade_job")) {
      return queryResult([{ status: "running" }], 1);
    }
    if (normalized.includes("from assessment_attempt_effective_result")) {
      return queryResult([{
        outcome_id: null,
        result_hash: ORIGINAL_RESULT_HASH,
        revision: 0,
        result: workerSnapshot.originalResult,
      }], 1);
    }
    if (normalized.startsWith("select id from assessment_regrade_outcome")) {
      return queryResult([], 0);
    }
    if (normalized.startsWith("insert into assessment_regrade_outcome")) {
      return queryResult([{
        id: "90000000-0000-4000-8000-000000000001",
      }], 1);
    }
    if (normalized.startsWith("insert into assessment_mastery_adjustment")) {
      return queryResult([{
        id: "a0000000-0000-4000-8000-000000000001",
      }], 1);
    }
    if (normalized.startsWith("insert into assessment_mastery_projection_repair")) {
      return queryResult([{
        id: "b0000000-0000-4000-8000-000000000001",
      }], 1);
    }
    if (normalized.startsWith("insert into email_outbox")) {
      return input.outboxRow
        ? queryResult([input.outboxRow], 1) : queryResult([], 0);
    }
    if (normalized.includes("public.release_email_outbox_delivery")) {
      if (input.releaseError) throw input.releaseError;
      if (!input.outboxRow) {
        throw new Error("Release must not run for an exact replay.");
      }
      const rows = input.releaseRows ?? [{
        outbox_id: input.outboxRow.id,
        operation_id: input.outboxRow.operation_id,
      }];
      return queryResult([...rows], rows.length);
    }
    return queryResult([], 1);
  });
}

function workerFailureClient() {
  return databaseClient(async (sql) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes("select count(*)::int count")) {
      return queryResult([{ count: 0 }], 1);
    }
    if (normalized.includes("count(*) filter (where status = 'succeeded')")) {
      return queryResult([{ succeeded: 0, failed: 1, pending: 0 }], 1);
    }
    return queryResult([], 1);
  });
}

describe("assessment correction runner reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admitRunnerJob.mockResolvedValue(admission);
    mocks.beginRunnerDispatch.mockResolvedValue({ replayed: false, remoteJobId: null });
    mocks.recordRunnerDispatch.mockResolvedValue({ replayed: false });
    mocks.settleRunnerJob.mockResolvedValue({ replayed: false });
    mocks.configuredRunnerClient.mockReturnValue({
      submit: mocks.submit,
      waitForJob: mocks.waitForJob,
      waitFrom: mocks.waitFrom,
    });
    mocks.submit.mockResolvedValue(completedJob());
  });

  it("resumes a known immutable remote job with GET and never POSTs again", async () => {
    const known = { ...admission, duplicate: true, status: "running" as const, remoteJobId: "remote-known" };
    mocks.admitRunnerJob.mockResolvedValueOnce(known);
    mocks.beginRunnerDispatch.mockResolvedValueOnce({ replayed: false, remoteJobId: "remote-known" });
    mocks.waitForJob.mockResolvedValueOnce(completedJob("remote-known"));

    await expect(configuredRegradeExecutor.execute(execution)).resolves.toMatchObject({ status: "ACCEPTED" });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.waitForJob).toHaveBeenCalledWith("remote-known", expect.objectContaining({
      mode: "TEST",
      runtimeVersion: "Python 3.14",
    }));
    expect(mocks.recordRunnerDispatch).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({ remoteJobId: "remote-known" }));
  });

  it("treats a different remote identity as indeterminate and never settles", async () => {
    mocks.submit.mockResolvedValueOnce({
      ...completedJob("remote-job-b"),
      state: "QUEUED",
      result: undefined,
    });
    mocks.recordRunnerDispatch.mockRejectedValueOnce(new RunnerAdmissionError("REMOTE_JOB_ID_MISMATCH"));

    await expect(configuredRegradeExecutor.execute(execution)).rejects.toEqual(
      new AssessmentCorrectionError("RUNNER_INDETERMINATE"),
    );
    expect(mocks.waitFrom).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("preserves the active generation when recording a trusted remote acceptance is ambiguous", async () => {
    mocks.submit.mockResolvedValueOnce({
      ...completedJob("remote-job-c"),
      state: "RUNNING",
      result: undefined,
    });
    mocks.recordRunnerDispatch.mockRejectedValueOnce(new Error("connection reset after commit"));
    mocks.refreshRunnerAdmission.mockResolvedValueOnce({
      ...admission,
      duplicate: true,
      status: "running",
      remoteJobId: "remote-job-c",
    });

    await expect(configuredRegradeExecutor.execute(execution)).rejects.toEqual(
      new AssessmentCorrectionError("RUNNER_INDETERMINATE"),
    );
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
    expect(mocks.refreshRunnerAdmission).toHaveBeenCalledWith(admission);
  });

  it("does not overwrite a trusted remote completion after ambiguous settlement persistence", async () => {
    mocks.settleRunnerJob.mockRejectedValueOnce(new Error("connection reset after commit"));
    mocks.refreshRunnerAdmission.mockResolvedValueOnce({
      ...admission,
      duplicate: true,
      status: "running",
      remoteJobId: "remote-job-a",
    });

    await expect(configuredRegradeExecutor.execute(execution)).rejects.toEqual(
      new AssessmentCorrectionError("RUNNER_INDETERMINATE"),
    );
    expect(mocks.settleRunnerJob).toHaveBeenCalledTimes(1);
    expect(mocks.refreshRunnerAdmission).toHaveBeenCalledWith(admission);
  });

  it("returns persisted winning terminal truth when settlement loses its CAS", async () => {
    mocks.settleRunnerJob.mockResolvedValueOnce({ replayed: true });
    const stored = {
      status: "ACCEPTED",
      requestHash: "d".repeat(64),
      sourceHash: "e".repeat(64),
      runtimeVersion: "Python 3.14",
      imageDigest: DIGEST,
      testBundleVersion: "reviewed-v2",
      compile: { status: "OK", exitCode: 0, stdout: "", stderr: "", wallTimeMs: 0 },
      tests: [{ id: "hidden-1", visibility: "HIDDEN", category: "edge", status: "PASSED", feedbackCode: "OK", exitCode: null, wallTimeMs: 0 }],
      totals: { passed: 1, failed: 0, total: 1 },
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
    };
    mocks.refreshRunnerAdmission.mockResolvedValueOnce({
      ...admission,
      duplicate: true,
      status: "succeeded",
      remoteJobId: "remote-job-a",
      runtimeImageDigest: DIGEST,
      result: stored,
    });

    await expect(configuredRegradeExecutor.execute(execution)).resolves.toEqual(stored);
    expect(mocks.refreshRunnerAdmission).toHaveBeenCalledWith(admission);
  });
});

describe("assessment correction outbox release", () => {
  const outboxRow: OutboxReleaseCandidate = {
    id: "c0000000-0000-4000-8000-000000000001",
    operation_id: "d0000000-0000-4000-8000-000000000001",
    idempotency_authority_sha256: "7".repeat(64),
    idempotency_original_payload_sha256: "8".repeat(64),
    delivery_hold_version: "task7-v1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolConnect.mockReset();
    mocks.correctionTarget.mockReturnValue({});
    mocks.reviewedReplacement.mockImplementation(
      (_target: unknown, replacement: typeof replacementEvidence) => replacement,
    );
    mocks.verifyImpactSnapshot.mockReturnValue(true);
    mocks.replaceFormEvidence.mockImplementation((form: unknown) => form);
    mocks.effectiveAnswers.mockReturnValue({});
    mocks.gradeExamSubmission.mockReturnValue(correctedWorkerResult);
    mocks.runnerEvidenceManifest.mockReturnValue({ schemaVersion: 1 });
    mocks.masteryEffect.mockReturnValue("no_change");
    mocks.correctionMasteryLanguageContext.mockReturnValue("python");
    mocks.applyAssessmentMasteryProjectionRepair.mockResolvedValue(undefined);
    mocks.reconcileAssessmentCorrectionCompletion.mockResolvedValue(undefined);
    mocks.writeAuditEvent.mockResolvedValue(undefined);
  });

  it("releases an inserted email outbox row before committing its outcome", async () => {
    const claimClient = workerClaimClient();
    const persistClient = workerPersistClient({ outboxRow });
    mocks.poolConnect
      .mockResolvedValueOnce(claimClient)
      .mockResolvedValueOnce(persistClient);

    await expect(processOneAssessmentRegrade({
      workerId: "assessment-worker-1",
      now: WORKER_NOW,
      clock: () => WORKER_NOW,
    })).resolves.toMatchObject({
      processed: true,
      succeeded: true,
      replayed: false,
    });

    const queries = persistClient.query.mock.calls.map(([sql]) => normalizeSql(sql));
    const insertIndex = queries.findIndex((sql) => sql.startsWith("insert into email_outbox"));
    const releaseIndex = queries.findIndex((sql) => (
      sql.includes("public.release_email_outbox_delivery")
    ));
    const commitIndex = queries.indexOf("commit");
    expect(insertIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(insertIndex);
    expect(commitIndex).toBeGreaterThan(releaseIndex);
    expect(queries[insertIndex]).toMatch(
      /on conflict \(idempotency_key\) do nothing returning id, operation_id, idempotency_authority_sha256, idempotency_original_payload_sha256, delivery_hold_version$/u,
    );
    expect(queries[releaseIndex]).toBe(
      "select released.outbox_id::text as outbox_id, released.operation_id::text as operation_id from public.release_email_outbox_delivery( $1::uuid, $2::uuid, $3::text, $4::text, $5::text ) as released",
    );
    expect(persistClient.query.mock.calls[releaseIndex]?.[1]).toEqual([
      outboxRow.id,
      outboxRow.operation_id,
      outboxRow.idempotency_authority_sha256,
      outboxRow.idempotency_original_payload_sha256,
      outboxRow.delivery_hold_version,
    ]);
  });

  it("commits an exact outbox replay without issuing a new release receipt", async () => {
    const claimClient = workerClaimClient();
    const persistClient = workerPersistClient({ outboxRow: null });
    mocks.poolConnect
      .mockResolvedValueOnce(claimClient)
      .mockResolvedValueOnce(persistClient);

    await expect(processOneAssessmentRegrade({
      workerId: "assessment-worker-1",
      now: WORKER_NOW,
      clock: () => WORKER_NOW,
    })).resolves.toMatchObject({
      processed: true,
      succeeded: true,
      replayed: false,
    });

    const queries = persistClient.query.mock.calls.map(
      ([sql]) => normalizeSql(sql),
    );
    const insertIndex = queries.findIndex((sql) =>
      sql.startsWith("insert into email_outbox")
    );
    expect(insertIndex).toBeGreaterThanOrEqual(0);
    expect(queries.some((sql) =>
      sql.includes("public.release_email_outbox_delivery")
    )).toBe(false);
    expect(queries).toContain("commit");
    expect(queries).not.toContain("rollback");
  });

  it.each([
    ["zero rows", []],
    [
      "multiple rows",
      [
        {
          outbox_id: outboxRow.id,
          operation_id: outboxRow.operation_id,
        },
        {
          outbox_id: outboxRow.id,
          operation_id: outboxRow.operation_id,
        },
      ],
    ],
    [
      "a different outbox",
      [{
        outbox_id: "e0000000-0000-4000-8000-000000000001",
        operation_id: outboxRow.operation_id,
      }],
    ],
    [
      "a different operation",
      [{
        outbox_id: outboxRow.id,
        operation_id: "f0000000-0000-4000-8000-000000000001",
      }],
    ],
  ] as const)(
    "rolls back the outcome transaction when release returns %s",
    async (_label, releaseRows) => {
      const claimClient = workerClaimClient();
      const persistClient = workerPersistClient({
        outboxRow,
        releaseRows: [...releaseRows],
      });
      const failureClient = workerFailureClient();
      mocks.poolConnect
        .mockResolvedValueOnce(claimClient)
        .mockResolvedValueOnce(persistClient)
        .mockResolvedValueOnce(failureClient);

      await expect(processOneAssessmentRegrade({
        workerId: "assessment-worker-1",
        now: WORKER_NOW,
        clock: () => WORKER_NOW,
      })).resolves.toMatchObject({
        processed: true,
        succeeded: false,
        errorCode: "REGRADING_FAILED",
        failureRecorded: true,
      });

      const queries = persistClient.query.mock.calls.map(
        ([sql]) => normalizeSql(sql),
      );
      const releaseIndex = queries.findIndex((sql) =>
        sql.includes("public.release_email_outbox_delivery")
      );
      const rollbackIndex = queries.indexOf("rollback");
      expect(releaseIndex).toBeGreaterThanOrEqual(0);
      expect(rollbackIndex).toBeGreaterThan(releaseIndex);
      expect(queries).not.toContain("commit");
      expect(failureClient.query).toHaveBeenCalledWith("commit");
    },
  );

  it("rolls back the outcome transaction when outbox release issuance fails", async () => {
    const claimClient = workerClaimClient();
    const persistClient = workerPersistClient({
      outboxRow,
      releaseError: new Error("release rejected"),
    });
    const failureClient = workerFailureClient();
    mocks.poolConnect
      .mockResolvedValueOnce(claimClient)
      .mockResolvedValueOnce(persistClient)
      .mockResolvedValueOnce(failureClient);

    await expect(processOneAssessmentRegrade({
      workerId: "assessment-worker-1",
      now: WORKER_NOW,
      clock: () => WORKER_NOW,
    })).resolves.toMatchObject({
      processed: true,
      succeeded: false,
      errorCode: "REGRADING_FAILED",
      failureRecorded: true,
    });

    const queries = persistClient.query.mock.calls.map(([sql]) => normalizeSql(sql));
    const insertIndex = queries.findIndex((sql) => sql.startsWith("insert into email_outbox"));
    const releaseIndex = queries.findIndex((sql) => (
      sql.includes("public.release_email_outbox_delivery")
    ));
    const rollbackIndex = queries.indexOf("rollback");
    expect(insertIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(insertIndex);
    expect(rollbackIndex).toBeGreaterThan(releaseIndex);
    expect(queries).not.toContain("commit");
    expect(failureClient.query).toHaveBeenCalledWith("commit");
  });
});
