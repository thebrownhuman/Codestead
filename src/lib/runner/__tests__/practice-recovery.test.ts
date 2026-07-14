import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  guardQuery: vi.fn(),
  release: vi.fn(),
  beginRunnerDispatch: vi.fn(),
  recordRunnerDispatch: vi.fn(),
  refreshRunnerAdmission: vi.fn(),
  settleRunnerJob: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: {
    query: mocks.poolQuery,
    connect: vi.fn(async () => ({ query: mocks.guardQuery, release: mocks.release })),
  },
}));

vi.mock("../admission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../admission")>(),
  beginRunnerDispatch: mocks.beginRunnerDispatch,
  recordRunnerDispatch: mocks.recordRunnerDispatch,
  refreshRunnerAdmission: mocks.refreshRunnerAdmission,
  settleRunnerJob: mocks.settleRunnerJob,
}));

import { buildPracticeRunnerRequest, practiceAdmissionRequestHash } from "../practice-dispatch";
import { processPracticeRunnerRecoveryBatch } from "../practice-recovery";
import type { RunnerAdmission } from "../admission";

const sourceCode = "print('durable')\n";
const admission: RunnerAdmission = {
  submissionId: "10000000-0000-4000-8000-000000000001",
  runnerJobId: "10000000-0000-4000-8000-000000000002",
  userId: "learner-one",
  requestId: "10000000-0000-4000-8000-000000000003",
  requestHash: practiceAdmissionRequestHash({
    userId: "learner-one",
    requestId: "10000000-0000-4000-8000-000000000003",
    language: "python",
    sourceHash: createHash("sha256").update(sourceCode).digest("hex"),
    mode: "quick_run",
    runtimeVersion: "Python 3.14",
    entrypoint: "main.py",
    submissionType: "server_run",
  }),
  submissionType: "server_run",
  status: "leased",
  remoteJobId: null,
  result: null,
  runtimeImageDigest: "pending-runner-result",
  queuedAt: new Date("2026-07-13T00:00:00.000Z"),
  duplicate: true,
};
const snapshot = buildPracticeRunnerRequest({
  admission,
  language: "python",
  runtimeVersion: "Python 3.14",
  entrypoint: "main.py",
  sourceCode,
  mode: "quick_run",
});
const row = {
  runner_job_id: admission.runnerJobId,
  submission_id: admission.submissionId,
  user_id: admission.userId,
  request_id: admission.requestId,
  request_hash: admission.requestHash,
  submission_type: admission.submissionType,
  submission_status: "leased",
  job_status: "leased",
  runtime_image_digest: admission.runtimeImageDigest,
  source_code: sourceCode,
  source_hash: createHash("sha256").update(sourceCode).digest("hex"),
  language: "python",
  remote_job_id: null,
  result: null,
  limits: snapshot.limits,
  dispatch_request: snapshot,
  recovery_state: "ready",
  recovery_attempt_count: 0,
  recovery_next_attempt_at: null,
  queued_at: admission.queuedAt,
};
const runnerResult = {
  status: "ACCEPTED",
  imageDigest: `sha256:${"b".repeat(64)}`,
  runtimeVersion: "Python 3.14",
  compile: { status: "OK", stdout: "", stderr: "", exitCode: 0 },
  run: { stdout: "durable\n", stderr: "", exitCode: 0, wallTimeMs: 2 },
  tests: [],
  totals: { passed: 0, failed: 0, total: 0 },
};

function runner(overrides: Record<string, unknown> = {}) {
  return {
    submit: vi.fn(async () => ({
      jobId: "remote-practice-job",
      submissionId: admission.submissionId,
      correlationId: snapshot.correlationId,
      requestHash: "c".repeat(64),
      state: "COMPLETED" as const,
      queuePosition: null,
      result: runnerResult,
    })),
    waitForJob: vi.fn(),
    waitFrom: vi.fn(),
    ...overrides,
  };
}

describe("practice runner crash recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("with stale as")) return { rows: [], rowCount: 0 };
      if (statement.includes("select j.id")) return { rows: [{ id: admission.runnerJobId }], rowCount: 1 };
      throw new Error(`Unexpected pool SQL: ${statement}`);
    });
    mocks.guardQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (statement.includes("pg_advisory_unlock")) return { rows: [{ pg_advisory_unlock: true }] };
      if (statement.includes("from runner_job j")) return { rows: [row] };
      if (statement.includes("select recovery_attempt_count")) return { rows: [{ recovery_attempt_count: 0 }] };
      if (statement.includes("update runner_job")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    mocks.beginRunnerDispatch.mockResolvedValue({ replayed: false, remoteJobId: null });
    mocks.recordRunnerDispatch.mockResolvedValue({ replayed: false });
    mocks.settleRunnerJob.mockResolvedValue({ replayed: false });
  });

  it("replays the exact persisted request id and releases the local admission on terminal truth", async () => {
    const remote = runner();
    const report = await processPracticeRunnerRecoveryBatch({
      runner: remote,
      now: new Date("2026-07-13T00:10:00.000Z"),
      clock: () => new Date("2026-07-13T00:10:01.000Z"),
    });

    expect(report).toEqual({ cancelledUndispatched: 0, processed: 1, reconciled: 1, indeterminate: 0, corrupt: 0, skipped: 0 });
    expect(remote.submit).toHaveBeenCalledWith(snapshot, admission.requestId);
    expect(mocks.beginRunnerDispatch).toHaveBeenCalledWith(expect.objectContaining({
      admission: expect.objectContaining({ requestId: admission.requestId }),
      dispatchRequest: snapshot,
    }));
    expect(mocks.settleRunnerJob).toHaveBeenCalledWith(expect.objectContaining({
      admission: expect.objectContaining({ runnerJobId: admission.runnerJobId }),
      remoteJobId: "remote-practice-job",
      status: "succeeded",
      result: runnerResult,
    }));
  });

  it("never fallback-settles after dispatch-record persistence becomes ambiguous", async () => {
    const queued = {
      jobId: "remote-practice-job",
      submissionId: admission.submissionId,
      correlationId: snapshot.correlationId,
      requestHash: "c".repeat(64),
      state: "QUEUED" as const,
      queuePosition: 1,
    };
    const remote = runner({ submit: vi.fn(async () => queued) });
    mocks.recordRunnerDispatch.mockRejectedValueOnce(new Error("commit acknowledgement lost"));

    await expect(processPracticeRunnerRecoveryBatch({ runner: remote })).resolves.toMatchObject({
      reconciled: 0,
      indeterminate: 1,
    });
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("does not call settlement a second time after terminal persistence becomes ambiguous", async () => {
    const remote = runner();
    mocks.settleRunnerJob.mockRejectedValueOnce(new Error("commit acknowledgement lost"));

    await expect(processPracticeRunnerRecoveryBatch({ runner: remote })).resolves.toMatchObject({
      reconciled: 0,
      indeterminate: 1,
    });
    expect(mocks.settleRunnerJob).toHaveBeenCalledOnce();
  });

  it("uses GET for a persisted remote identity and never POSTs a fresh job", async () => {
    mocks.guardQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (statement.includes("pg_advisory_unlock")) return { rows: [{}] };
      if (statement.includes("from runner_job j")) return { rows: [{ ...row, remote_job_id: "known-remote" }] };
      if (statement.includes("update runner_job")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    mocks.beginRunnerDispatch.mockResolvedValueOnce({ replayed: false, remoteJobId: "known-remote" });
    const remote = runner({
      waitForJob: vi.fn(async () => ({
        jobId: "known-remote",
        submissionId: admission.submissionId,
        correlationId: snapshot.correlationId,
        requestHash: "c".repeat(64),
        state: "COMPLETED" as const,
        queuePosition: null,
        result: runnerResult,
      })),
    });

    await expect(processPracticeRunnerRecoveryBatch({ runner: remote })).resolves.toMatchObject({ reconciled: 1 });
    expect(remote.submit).not.toHaveBeenCalled();
    expect(remote.waitForJob).toHaveBeenCalledWith("known-remote", snapshot);
  });

  it("fails closed on a corrupt snapshot and skips a concurrently locked admission", async () => {
    mocks.guardQuery.mockImplementationOnce(async () => ({ rows: [{ acquired: false }] }));
    await expect(processPracticeRunnerRecoveryBatch({ runner: runner() })).resolves.toMatchObject({ skipped: 1 });

    mocks.guardQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (statement.includes("pg_advisory_unlock")) return { rows: [{}] };
      if (statement.includes("from runner_job j")) {
        return { rows: [{ ...row, dispatch_request: { ...snapshot, tests: [{ visibility: "HIDDEN" }] } }] };
      }
      if (statement.includes("update runner_job")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    const remote = runner();
    await expect(processPracticeRunnerRecoveryBatch({ runner: remote })).resolves.toMatchObject({ corrupt: 1 });
    expect(remote.submit).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
  });

  it("terminalizes a stale pre-dispatch practice admission without configuring or calling a runner", async () => {
    mocks.poolQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("with stale as")) return { rows: [{ submission_id: admission.submissionId }], rowCount: 1 };
      if (statement.includes("select j.id")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected pool SQL: ${statement}`);
    });
    const remote = runner();

    await expect(processPracticeRunnerRecoveryBatch({ runner: remote })).resolves.toEqual({
      cancelledUndispatched: 1,
      processed: 0,
      reconciled: 0,
      indeterminate: 0,
      corrupt: 0,
      skipped: 0,
    });
    expect(remote.submit).not.toHaveBeenCalled();
    expect(mocks.beginRunnerDispatch).not.toHaveBeenCalled();
    expect(mocks.guardQuery).not.toHaveBeenCalled();
  });

  it("quarantines status-mismatched persistence instead of repeatedly selecting or settling it", async () => {
    mocks.guardQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (statement.includes("pg_advisory_unlock")) return { rows: [{}] };
      if (statement.includes("from runner_job j")) return { rows: [{ ...row, job_status: "running" }] };
      if (statement.includes("update runner_job")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    const remote = runner();

    await expect(processPracticeRunnerRecoveryBatch({ runner: remote })).resolves.toMatchObject({
      corrupt: 1,
      indeterminate: 0,
    });
    expect(remote.submit).not.toHaveBeenCalled();
    expect(mocks.settleRunnerJob).not.toHaveBeenCalled();
    expect(mocks.guardQuery).toHaveBeenCalledWith(
      expect.stringContaining("recovery_state = 'quarantined'"),
      [admission.runnerJobId],
    );
  });

  it("quarantines two corrupt oldest jobs so a later healthy job progresses in the next bounded batch", async () => {
    const corruptOne = "10000000-0000-4000-8000-000000000011";
    const corruptTwo = "10000000-0000-4000-8000-000000000012";
    const healthy = "10000000-0000-4000-8000-000000000013";
    let candidateRead = 0;
    mocks.poolQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("with stale as")) return { rows: [], rowCount: 0 };
      if (statement.includes("select j.id")) {
        candidateRead += 1;
        return candidateRead === 1
          ? { rows: [{ id: corruptOne }, { id: corruptTwo }], rowCount: 2 }
          : { rows: [{ id: healthy }], rowCount: 1 };
      }
      throw new Error(`Unexpected pool SQL: ${statement}`);
    });
    mocks.guardQuery.mockImplementation(async (statement: string, params?: unknown[]) => {
      if (statement.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (statement.includes("pg_advisory_unlock")) return { rows: [{}] };
      if (statement.includes("from runner_job j")) {
        const jobId = String(params?.[0]);
        return { rows: [{
          ...row,
          runner_job_id: jobId,
          dispatch_request: jobId === healthy ? snapshot : { ...snapshot, unexpected: true },
        }] };
      }
      if (statement.includes("update runner_job")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    const remote = runner();

    await expect(processPracticeRunnerRecoveryBatch({ runner: remote, limit: 2 })).resolves.toMatchObject({
      processed: 2,
      corrupt: 2,
    });
    await expect(processPracticeRunnerRecoveryBatch({ runner: remote, limit: 2 })).resolves.toMatchObject({
      processed: 1,
      reconciled: 1,
    });
    expect(remote.submit).toHaveBeenCalledOnce();
  });

  it("backs off indeterminate jobs and retries the same immutable request only when selected as due", async () => {
    let candidateRead = 0;
    mocks.poolQuery.mockImplementation(async (statement: string, params?: unknown[]) => {
      if (statement.includes("with stale as")) return { rows: [], rowCount: 0 };
      if (statement.includes("select j.id")) {
        candidateRead += 1;
        expect(statement).toContain("recovery_next_attempt_at <= $2");
        expect(params).toHaveLength(3);
        if (candidateRead === 2) return { rows: [], rowCount: 0 };
        return { rows: [{ id: admission.runnerJobId }], rowCount: 1 };
      }
      throw new Error(`Unexpected pool SQL: ${statement}`);
    });
    const dispositionUpdates: unknown[][] = [];
    mocks.guardQuery.mockImplementation(async (statement: string, params?: unknown[]) => {
      if (statement.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (statement.includes("pg_advisory_unlock")) return { rows: [{}] };
      if (statement.includes("from runner_job j")) return { rows: [row] };
      if (statement.includes("select recovery_attempt_count")) return { rows: [{ recovery_attempt_count: 0 }] };
      if (statement.includes("update runner_job")) {
        if (statement.includes("recovery_state = 'retry_wait'")) dispositionUpdates.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    mocks.beginRunnerDispatch
      .mockRejectedValueOnce(new Error("remote outcome unknown"))
      .mockResolvedValueOnce({ replayed: false, remoteJobId: null });
    const remote = runner();
    const now = new Date("2026-07-13T00:10:00.000Z");

    await expect(processPracticeRunnerRecoveryBatch({ runner: remote, now, clock: () => now })).resolves.toMatchObject({
      indeterminate: 1,
    });
    expect(dispositionUpdates).toHaveLength(1);
    expect(dispositionUpdates[0]?.[1]).toBe(1);
    expect((dispositionUpdates[0]?.[2] as Date).getTime()).toBe(now.getTime() + 5_000);
    await expect(processPracticeRunnerRecoveryBatch({ runner: remote, now: new Date(now.getTime() + 4_999) })).resolves.toMatchObject({
      processed: 0,
    });
    await expect(processPracticeRunnerRecoveryBatch({ runner: remote, now: new Date(now.getTime() + 5_000) })).resolves.toMatchObject({
      reconciled: 1,
    });
    expect(remote.submit).toHaveBeenCalledWith(snapshot, admission.requestId);
  });

  it("moves two indeterminate oldest jobs into retry wait so a later healthy job is not starved", async () => {
    const first = "10000000-0000-4000-8000-000000000021";
    const second = "10000000-0000-4000-8000-000000000022";
    const healthy = "10000000-0000-4000-8000-000000000023";
    let candidateRead = 0;
    mocks.poolQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("with stale as")) return { rows: [], rowCount: 0 };
      if (statement.includes("select j.id")) {
        candidateRead += 1;
        return candidateRead === 1
          ? { rows: [{ id: first }, { id: second }], rowCount: 2 }
          : { rows: [{ id: healthy }], rowCount: 1 };
      }
      throw new Error(`Unexpected pool SQL: ${statement}`);
    });
    mocks.guardQuery.mockImplementation(async (statement: string, params?: unknown[]) => {
      if (statement.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (statement.includes("pg_advisory_unlock")) return { rows: [{}] };
      if (statement.includes("from runner_job j")) return { rows: [{ ...row, runner_job_id: String(params?.[0]) }] };
      if (statement.includes("select recovery_attempt_count")) return { rows: [{ recovery_attempt_count: 0 }] };
      if (statement.includes("update runner_job")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    mocks.beginRunnerDispatch
      .mockRejectedValueOnce(new Error("unknown one"))
      .mockRejectedValueOnce(new Error("unknown two"))
      .mockResolvedValueOnce({ replayed: false, remoteJobId: null });
    const remote = runner();

    await expect(processPracticeRunnerRecoveryBatch({ runner: remote, limit: 2 })).resolves.toMatchObject({
      processed: 2,
      indeterminate: 2,
    });
    await expect(processPracticeRunnerRecoveryBatch({ runner: remote, limit: 2 })).resolves.toMatchObject({
      processed: 1,
      reconciled: 1,
    });
    expect(remote.submit).toHaveBeenCalledOnce();
  });
});
