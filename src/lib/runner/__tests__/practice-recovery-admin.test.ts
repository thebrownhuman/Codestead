import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dbLimit = vi.fn();
  const dbWhere = vi.fn(() => ({ limit: dbLimit }));
  const dbInnerJoin = vi.fn(() => ({ where: dbWhere }));
  const dbFrom = vi.fn(() => ({ innerJoin: dbInnerJoin }));
  const dbSelect = vi.fn(() => ({ from: dbFrom }));

  const txLimit = vi.fn();
  const txWhere = vi.fn(() => ({ limit: txLimit }));
  const txInnerJoin = vi.fn();
  txInnerJoin.mockImplementation(() => ({ innerJoin: txInnerJoin, where: txWhere }));
  const txFrom = vi.fn(() => ({ innerJoin: txInnerJoin, where: txWhere }));
  const txSelect = vi.fn(() => ({ from: txFrom }));
  const txReturning = vi.fn();
  const txUpdateWhere = vi.fn(() => ({ returning: txReturning }));
  const txSet = vi.fn<(values: Record<string, unknown>) => { where: typeof txUpdateWhere }>(
    () => ({ where: txUpdateWhere }),
  );
  const txUpdate = vi.fn(() => ({ set: txSet }));
  const txValues = vi.fn(async () => undefined);
  const txInsert = vi.fn(() => ({ values: txValues }));
  const txExecute = vi.fn(async () => undefined);
  const tx = {
    execute: txExecute,
    select: txSelect,
    update: txUpdate,
    insert: txInsert,
  };
  const transaction = vi.fn();

  return {
    dbLimit,
    dbSelect,
    transaction,
    tx,
    txExecute,
    txLimit,
    txReturning,
    txSet,
    txValues,
    lockUserAuthority: vi.fn(async () => undefined),
    writeAuditEventInTransaction: vi.fn(async () => undefined),
  };
});

vi.mock("@/lib/db/client", () => ({
  db: { select: mocks.dbSelect, transaction: mocks.transaction },
}));
vi.mock("@/lib/security/audit-writer", () => ({
  writeAuditEventInTransaction: mocks.writeAuditEventInTransaction,
}));
vi.mock("@/lib/security/user-authority-lock", () => ({
  lockUserAuthority: mocks.lockUserAuthority,
}));

import { notification } from "@/lib/db/schema";
import {
  PracticeRecoveryAdminError,
  resolveQuarantinedPracticeRunnerJob,
} from "../practice-recovery-admin";

const JOB_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "20000000-0000-4000-8000-000000000002";
const SUBMISSION_ID = "30000000-0000-4000-8000-000000000003";
const ACTOR_ID = "admin-internal-1";
const LEARNER_ID = "learner-internal-1";
const NOW = new Date("2026-07-13T12:34:56.000Z");

const base = {
  actorUserId: ACTOR_ID,
  runnerJobId: JOB_ID,
  requestId: REQUEST_ID,
  reason: "Runner journal was reconciled after an isolated VM restart.",
  isolatedRunnerRestarted: true,
  journalReconciled: true,
  now: NOW,
} as const;

function current(overrides: Record<string, unknown> = {}) {
  return {
    runnerJobId: JOB_ID,
    runnerStatus: "running",
    recoveryState: "quarantined",
    recoveryAttemptCount: 3,
    recoveryLastErrorCode: "PRACTICE_RECOVERY_SNAPSHOT_CORRUPT",
    remoteRunnerJobId: "remote-runner-7",
    result: null,
    submissionId: SUBMISSION_ID,
    submissionStatus: "leased",
    submissionType: "server_run",
    runnerRequestId: "practice-request-7",
    learnerUserId: LEARNER_ID,
    learnerRole: "learner",
    learnerStatus: "active",
    ...overrides,
  };
}

function arrangeTransaction(options: {
  actor?: unknown[];
  current?: unknown[];
  updateRows?: unknown[][];
} = {}) {
  mocks.dbLimit.mockReset().mockResolvedValue([{ learnerUserId: LEARNER_ID }]);
  mocks.txLimit.mockReset()
    .mockResolvedValueOnce(options.actor ?? [{ role: "admin", status: "active" }])
    .mockResolvedValueOnce(options.current ?? [current()]);
  const updateRows = options.updateRows ?? [[{ id: JOB_ID }], [{ id: SUBMISSION_ID }]];
  mocks.txReturning.mockReset();
  for (const rows of updateRows) mocks.txReturning.mockResolvedValueOnce(rows);
}

async function expectCode(
  promise: Promise<unknown>,
  code: InstanceType<typeof PracticeRecoveryAdminError>["code"],
) {
  await expect(promise).rejects.toMatchObject({ name: "PracticeRecoveryAdminError", code });
}

describe("administrator practice quarantine resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockReset().mockImplementation(
      async (callback: (tx: typeof mocks.tx) => Promise<unknown>) => callback(mocks.tx),
    );
    mocks.txExecute.mockReset().mockResolvedValue(undefined);
    mocks.txValues.mockReset().mockResolvedValue(undefined);
    mocks.lockUserAuthority.mockReset().mockResolvedValue(undefined);
    mocks.writeAuditEventInTransaction.mockReset().mockResolvedValue(undefined);
    arrangeTransaction();
  });

  it.each([
    ["empty actor", { actorUserId: "" }],
    ["oversized actor", { actorUserId: "a".repeat(256) }],
    ["malformed job UUID", { runnerJobId: "runner-job" }],
    ["malformed request UUID", { requestId: "request-id" }],
    ["short trimmed reason", { reason: "  not enough detail  " }],
    ["oversized reason", { reason: "r".repeat(501) }],
    ["invalid clock", { now: new Date(Number.NaN) }],
  ])("rejects %s before any database access", async (_label, override) => {
    await expectCode(resolveQuarantinedPracticeRunnerJob({ ...base, ...override }), "INVALID_INPUT");
    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])("requires both restart and journal attestations (%s/%s)", async (
    isolatedRunnerRestarted,
    journalReconciled,
  ) => {
    await expectCode(resolveQuarantinedPracticeRunnerJob({
      ...base,
      isolatedRunnerRestarted,
      journalReconciled,
    }), "ATTESTATION_REQUIRED");
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });

  it("fails closed when the global authority-lock subject cannot be found", async () => {
    mocks.dbLimit.mockReset().mockResolvedValue([]);
    await expectCode(resolveQuarantinedPracticeRunnerJob(base), "RUNNER_JOB_NOT_FOUND");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.lockUserAuthority).not.toHaveBeenCalled();
  });

  it.each([
    ["missing actor", []],
    ["learner actor", [{ role: "learner", status: "active" }]],
    ["suspended admin", [{ role: "admin", status: "suspended" }]],
  ])("rejects an unauthorized %s inside the authority-locked transaction", async (_label, actor) => {
    arrangeTransaction({ actor });
    await expectCode(resolveQuarantinedPracticeRunnerJob(base), "ADMIN_REQUIRED");
    expect(mocks.lockUserAuthority).toHaveBeenCalledWith(mocks.tx, LEARNER_ID);
    expect(mocks.txExecute).toHaveBeenCalledTimes(4);
    expect(mocks.txSet).not.toHaveBeenCalled();
    expect(mocks.writeAuditEventInTransaction).not.toHaveBeenCalled();
  });

  it("fails closed if the locked runner/submission row vanishes", async () => {
    arrangeTransaction({ current: [] });
    await expectCode(resolveQuarantinedPracticeRunnerJob(base), "RUNNER_JOB_NOT_FOUND");
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it.each([
    ["non-learner owner", { learnerRole: "admin", learnerStatus: "active" }],
    ["deleted learner", { learnerRole: "learner", learnerStatus: "deleted" }],
  ])("rejects a %s", async (_label, owner) => {
    arrangeTransaction({ current: [current(owner)] });
    await expectCode(resolveQuarantinedPracticeRunnerJob(base), "LEARNER_NOT_ACTIVE");
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it.each(["exam_final_test", "assessment_correction_regrade", "project_review"])(
    "never resolves official/non-practice submission type %s",
    async (submissionType) => {
      arrangeTransaction({ current: [current({ submissionType })] });
      await expectCode(resolveQuarantinedPracticeRunnerJob(base), "NOT_PRACTICE_JOB");
      expect(mocks.txSet).not.toHaveBeenCalled();
      expect(mocks.txValues).not.toHaveBeenCalled();
    },
  );

  it("rejects a practice job that is no longer quarantined", async () => {
    arrangeTransaction({ current: [current({ recoveryState: "ready" })] });
    await expectCode(resolveQuarantinedPracticeRunnerJob(base), "NOT_QUARANTINED");
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", "failed"],
    ["cancelled", "completed"],
  ])("rejects terminal status pair %s/%s before compare-and-set", async (runnerStatus, submissionStatus) => {
    arrangeTransaction({ current: [current({ runnerStatus, submissionStatus })] });
    await expectCode(resolveQuarantinedPracticeRunnerJob(base), "STATUS_CONFLICT");
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it.each([
    ["active", "queued", "running"],
    ["pending", "leased", "completed"],
    ["suspended", "completed", "running"],
    ["deletion_pending", "failed", "queued"],
  ])(
    "atomically resolves a %s learner with status pair %s/%s",
    async (learnerStatus, runnerStatus, submissionStatus) => {
      arrangeTransaction({ current: [current({ learnerStatus, runnerStatus, submissionStatus })] });
      const result = await resolveQuarantinedPracticeRunnerJob(base);

      expect(result).toEqual({
        runnerJobId: JOB_ID,
        submissionId: SUBMISSION_ID,
        learnerUserId: LEARNER_ID,
        status: "cancelled",
        officialEvidenceChanged: false,
        replayed: false,
      });
      expect(mocks.txSet).toHaveBeenNthCalledWith(1, expect.objectContaining({
        status: "cancelled",
        completedAt: NOW,
        recoveryNextAttemptAt: null,
        recoveryLastErrorCode: "PRACTICE_QUARANTINE_OPERATOR_RESOLVED",
        result: expect.objectContaining({
          error: "PRACTICE_QUARANTINE_OPERATOR_RESOLVED",
          resolutionRequestId: REQUEST_ID,
          officialEvidenceChanged: false,
          resolvedAt: NOW.toISOString(),
        }),
      }));
      expect(mocks.txSet).toHaveBeenNthCalledWith(2, {
        status: "cancelled",
        runtimeImageDigest: "practice-quarantine-operator-resolved",
      });
      expect(mocks.txValues).toHaveBeenCalledWith(expect.objectContaining({
        userId: LEARNER_ID,
        type: "practice-runner-recovery-resolved",
        createdAt: NOW,
      }));
      expect(mocks.writeAuditEventInTransaction).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({
        actorUserId: ACTOR_ID,
        subjectUserId: LEARNER_ID,
        resourceId: JOB_ID,
        reason: base.reason,
        correlationId: REQUEST_ID,
        metadata: expect.objectContaining({
          priorRunnerStatus: runnerStatus,
          priorSubmissionStatus: submissionStatus,
          remoteRunnerJobId: "remote-runner-7",
          runnerRequestId: "practice-request-7",
          isolatedRunnerRestarted: true,
          journalReconciled: true,
          officialEvidenceChanged: false,
        }),
      }));
    },
  );

  it("trims the audit reason and uses a current clock when now is omitted", async () => {
    const before = Date.now();
    const result = await resolveQuarantinedPracticeRunnerJob({
      ...base,
      reason: `  ${base.reason}  `,
      now: undefined,
    });
    const after = Date.now();
    const completedAt = mocks.txSet.mock.calls[0]?.[0]?.completedAt as Date;

    expect(result.replayed).toBe(false);
    expect(completedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(completedAt.getTime()).toBeLessThanOrEqual(after);
    expect(mocks.writeAuditEventInTransaction).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({ reason: base.reason }),
    );
  });

  it("preserves the legacy missing-snapshot sentinel required by the database constraint", async () => {
    arrangeTransaction({
      current: [current({ recoveryLastErrorCode: "PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING" })],
    });
    await resolveQuarantinedPracticeRunnerJob(base);
    expect(mocks.txSet).toHaveBeenNthCalledWith(1, expect.objectContaining({
      recoveryLastErrorCode: "PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING",
    }));
  });

  it.each([
    ["runner compare-and-set", [[], [{ id: SUBMISSION_ID }]]],
    ["submission compare-and-set", [[{ id: JOB_ID }], []]],
  ])("rolls back on a lost %s", async (_label, updateRows) => {
    arrangeTransaction({ updateRows });
    await expectCode(resolveQuarantinedPracticeRunnerJob(base), "STATUS_CONFLICT");
    expect(mocks.txValues).not.toHaveBeenCalled();
    expect(mocks.writeAuditEventInTransaction).not.toHaveBeenCalled();
  });

  it("propagates notification failure so the surrounding transaction can roll back", async () => {
    mocks.txValues.mockRejectedValueOnce(new Error("notification write failed"));
    await expect(resolveQuarantinedPracticeRunnerJob(base)).rejects.toThrow("notification write failed");
    expect(mocks.writeAuditEventInTransaction).not.toHaveBeenCalled();
  });

  it("propagates audit failure so cancellation and notification cannot commit independently", async () => {
    mocks.writeAuditEventInTransaction.mockRejectedValueOnce(new Error("audit write failed"));
    await expect(resolveQuarantinedPracticeRunnerJob(base)).rejects.toThrow("audit write failed");
    expect(mocks.txValues).toHaveBeenCalledTimes(1);
  });

  it("propagates authority-lock failure before acquiring runner row locks", async () => {
    mocks.lockUserAuthority.mockRejectedValueOnce(new Error("authority lock failed"));
    await expect(resolveQuarantinedPracticeRunnerJob(base)).rejects.toThrow("authority lock failed");
    expect(mocks.txExecute).not.toHaveBeenCalled();
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it("replays an identical completed resolution without duplicate writes", async () => {
    await resolveQuarantinedPracticeRunnerJob(base);
    const storedResult = mocks.txSet.mock.calls[0]?.[0]?.result;
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (tx: typeof mocks.tx) => Promise<unknown>) => callback(mocks.tx),
    );
    mocks.lockUserAuthority.mockResolvedValue(undefined);
    mocks.txExecute.mockResolvedValue(undefined);
    arrangeTransaction({
      current: [current({
        runnerStatus: "cancelled",
        submissionStatus: "cancelled",
        result: storedResult,
      })],
    });

    await expect(resolveQuarantinedPracticeRunnerJob(base)).resolves.toEqual({
      runnerJobId: JOB_ID,
      submissionId: SUBMISSION_ID,
      learnerUserId: LEARNER_ID,
      status: "cancelled",
      officialEvidenceChanged: false,
      replayed: true,
    });
    expect(mocks.txSet).not.toHaveBeenCalled();
    expect(mocks.txValues).not.toHaveBeenCalled();
    expect(mocks.writeAuditEventInTransaction).not.toHaveBeenCalled();
  });

  it("rejects same request ID with changed request semantics", async () => {
    await resolveQuarantinedPracticeRunnerJob(base);
    const storedResult = mocks.txSet.mock.calls[0]?.[0]?.result;
    arrangeTransaction({
      current: [current({
        runnerStatus: "cancelled",
        submissionStatus: "cancelled",
        result: storedResult,
      })],
    });
    await expectCode(resolveQuarantinedPracticeRunnerJob({
      ...base,
      reason: "A different sufficiently detailed operator resolution reason.",
    }), "IDEMPOTENCY_CONFLICT");
  });

  it.each([
    null,
    [],
    "not-an-object",
    { resolutionRequestId: 7, resolutionRequestHash: false },
    { resolutionRequestId: "different-request", resolutionRequestHash: "different-hash" },
  ])("rejects malformed or mismatched prior idempotency metadata %#", async (result) => {
    arrangeTransaction({
      current: [current({ runnerStatus: "cancelled", submissionStatus: "cancelled", result })],
    });
    await expectCode(resolveQuarantinedPracticeRunnerJob(base), "IDEMPOTENCY_CONFLICT");
    expect(mocks.txSet).not.toHaveBeenCalled();
  });

  it("inserts only the learner-facing recovery notification table", async () => {
    await resolveQuarantinedPracticeRunnerJob(base);
    expect(mocks.tx.insert).toHaveBeenCalledWith(notification);
  });
});
