import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitRunnerJob: vi.fn(),
  beginRunnerDispatch: vi.fn(),
  recordRunnerDispatch: vi.fn(),
  refreshRunnerAdmission: vi.fn(),
  settleRunnerJob: vi.fn(),
  configuredRunnerClient: vi.fn(),
  submit: vi.fn(),
  waitForJob: vi.fn(),
  waitFrom: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: { connect: vi.fn(), query: vi.fn() },
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: vi.fn() }));
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
