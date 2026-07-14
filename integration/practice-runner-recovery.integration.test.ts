import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "@/lib/db/client";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import {
  admitRunnerJob,
  beginRunnerDispatch,
  hashRunnerAdmissionRequest,
  recordRunnerDispatch,
  settleRunnerJob,
} from "@/lib/runner/admission";
import { RunnerIndeterminateError, serializeRunnerRequest } from "@/lib/runner/client";
import {
  buildPracticeRunnerRequest,
  PRACTICE_LIMITS,
} from "@/lib/runner/practice-dispatch";
import {
  PRACTICE_RECOVERY_STALE_MS,
  processPracticeRunnerRecoveryBatch,
} from "@/lib/runner/practice-recovery";
import {
  PracticeRecoveryAdminError,
  resolveQuarantinedPracticeRunnerJob,
} from "@/lib/runner/practice-recovery-admin";

const ADMIN_ID = "practice-recovery-admin";
const LEARNER_ID = "practice-recovery-learner";
const REQUEST_ID = "91000000-0000-4000-8000-000000000001";
const BASE_TIME = new Date("2026-07-13T00:00:00.000Z");
const sourceCode = "print('recovered after app crash')\n";

async function createPracticeDispatch(input: {
  requestId: string;
  now: Date;
  sourceCode?: string;
  admittedStdin?: string;
  dispatchedStdin?: string;
  begin?: boolean;
  submissionType?: "server_run" | "server_compile" | "exam_final_test";
}) {
  const source = input.sourceCode ?? sourceCode;
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const submissionType = input.submissionType ?? "server_run";
  const mode = submissionType === "server_compile" ? "compile" : "quick_run";
  const admission = await admitRunnerJob({
    userId: LEARNER_ID,
    language: "python",
    sourceCode: source,
    sourceHash,
    submissionType,
    requestId: input.requestId,
    requestHash: hashRunnerAdmissionRequest({
      schemaVersion: 1,
      userId: LEARNER_ID,
      requestId: input.requestId,
      language: "python",
      sourceHash,
      stdin: input.admittedStdin ?? null,
      mode,
      runtimeVersion: "Python 3.14",
      entrypoint: "main.py",
      submissionType,
      limits: PRACTICE_LIMITS,
    }),
    limits: PRACTICE_LIMITS,
    now: input.now,
  });
  const request = buildPracticeRunnerRequest({
    admission,
    language: "python",
    runtimeVersion: "Python 3.14",
    entrypoint: "main.py",
    sourceCode: source,
    ...(input.dispatchedStdin === undefined ? {} : { stdin: input.dispatchedStdin }),
    mode,
  });
  if (input.begin !== false) {
    await beginRunnerDispatch({ admission, dispatchRequest: request, now: input.now });
  }
  return { admission, request, sourceHash };
}

function successfulRunner() {
  return {
    submit: vi.fn(async (request: ReturnType<typeof buildPracticeRunnerRequest>, idempotencyKey: string) => ({
      jobId: `remote-${idempotencyKey}`,
      submissionId: request.submissionId,
      correlationId: request.correlationId,
      requestHash: createHash("sha256").update(serializeRunnerRequest(request)).digest("hex"),
      state: "COMPLETED" as const,
      queuePosition: null,
      result: {
        status: "ACCEPTED",
        imageDigest: `sha256:${"c".repeat(64)}`,
        runtimeVersion: "Python 3.14",
        compile: { status: "OK", stdout: "", stderr: "", exitCode: 0 },
        run: { stdout: "ok\n", stderr: "", exitCode: 0, wallTimeMs: 2 },
        tests: [],
        totals: { passed: 0, failed: 0, total: 0 },
      },
    })),
    waitForJob: vi.fn(),
    waitFrom: vi.fn(),
  };
}

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Practice runner recovery tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(",");
  await pool.query(`truncate table ${names} restart identity cascade`);
}

beforeEach(async () => {
  await truncateApplicationTables();
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status,email_verified,two_factor_enabled)
     values ($1,'91000000-0000-4000-8000-000000000010','Recovery Admin','recovery-admin@integration.invalid','admin','active',true,true),
            ($2,'91000000-0000-4000-8000-000000000011','Recovery Learner','recovery-learner@integration.invalid','learner','active',true,true)`,
    [ADMIN_ID, LEARNER_ID],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("durable practice runner recovery in PostgreSQL", () => {
  it("reconciles an app-crash lease under the same request and unwedges deletion without a second remote job", async () => {
    const sourceHash = createHash("sha256").update(sourceCode).digest("hex");
    const admission = await admitRunnerJob({
      userId: LEARNER_ID,
      language: "python",
      sourceCode,
      sourceHash,
      submissionType: "server_run",
      requestId: REQUEST_ID,
      requestHash: hashRunnerAdmissionRequest({
        schemaVersion: 1,
        userId: LEARNER_ID,
        requestId: REQUEST_ID,
        language: "python",
        sourceHash,
        stdin: null,
        mode: "quick_run",
        runtimeVersion: "Python 3.14",
        entrypoint: "main.py",
        submissionType: "server_run",
        limits: PRACTICE_LIMITS,
      }),
      limits: PRACTICE_LIMITS,
      now: BASE_TIME,
    });
    const request = buildPracticeRunnerRequest({
      admission,
      language: "python",
      runtimeVersion: "Python 3.14",
      entrypoint: "main.py",
      sourceCode,
      mode: "quick_run",
    });
    await expect(beginRunnerDispatch({ admission, dispatchRequest: request, now: BASE_TIME }))
      .resolves.toMatchObject({ replayed: false, remoteJobId: null });

    const persisted = await pool.query<{
      submission_status: string;
      job_status: string;
      dispatch_request: Record<string, unknown>;
    }>(
      `select s.status submission_status,j.status job_status,j.dispatch_request
         from code_submission s join runner_job j on j.submission_id = s.id
        where s.id = $1`,
      [admission.submissionId],
    );
    expect(persisted.rows[0]).toMatchObject({
      submission_status: "leased",
      job_status: "leased",
      dispatch_request: expect.objectContaining({ submissionId: admission.submissionId }),
    });
    expect(serializeRunnerRequest(persisted.rows[0]!.dispatch_request as never))
      .toBe(serializeRunnerRequest(request));
    await expect(pool.query(
      `update runner_job set dispatch_request = jsonb_set(dispatch_request,'{runtimeVersion}','"tampered"')
        where id = $1`,
      [admission.runnerJobId],
    )).rejects.toMatchObject({ code: "23514", constraint: "runner_job_dispatch_request_immutable" });

    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "91000000-0000-4000-8000-000000000002",
      reason: "Prove an indeterminate practice dispatch blocks deletion until its isolated runner truth is reconciled.",
      now: new Date(BASE_TIME.getTime() + 1_000),
    })).rejects.toMatchObject({ code: "RUNNER_OPERATION_IN_PROGRESS" });

    let releaseRemote!: () => void;
    const remoteGate = new Promise<void>((resolve) => { releaseRemote = resolve; });
    const submittedIds: string[] = [];
    const runner = {
      submit: vi.fn(async (submittedRequest: typeof request, idempotencyKey: string) => {
        submittedIds.push(idempotencyKey);
        await remoteGate;
        const raw = serializeRunnerRequest(submittedRequest);
        return {
          jobId: "remote-practice-recovery-job",
          submissionId: admission.submissionId,
          correlationId: submittedRequest.correlationId,
          requestHash: createHash("sha256").update(raw).digest("hex"),
          state: "COMPLETED" as const,
          queuePosition: null,
          result: {
            status: "ACCEPTED",
            imageDigest: `sha256:${"b".repeat(64)}`,
            runtimeVersion: "Python 3.14",
            compile: { status: "OK", stdout: "", stderr: "", exitCode: 0 },
            run: { stdout: "recovered after app crash\n", stderr: "", exitCode: 0, wallTimeMs: 2 },
            tests: [],
            totals: { passed: 0, failed: 0, total: 0 },
          },
        };
      }),
      waitForJob: vi.fn(),
      waitFrom: vi.fn(),
    };
    const recoveryNow = new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 1);
    const first = processPracticeRunnerRecoveryBatch({
      runner,
      now: recoveryNow,
      clock: () => new Date(recoveryNow.getTime() + 1_000),
    });
    await vi.waitFor(() => expect(runner.submit).toHaveBeenCalledOnce());
    const concurrent = await processPracticeRunnerRecoveryBatch({ runner, now: recoveryNow });
    expect(concurrent).toMatchObject({ processed: 1, skipped: 1, reconciled: 0 });
    releaseRemote();
    await expect(first).resolves.toMatchObject({ processed: 1, reconciled: 1, indeterminate: 0 });
    expect(submittedIds).toEqual([REQUEST_ID]);

    const terminal = await pool.query<{
      submission_status: string;
      job_status: string;
      remote_job_id: string;
      submissions: string;
    }>(
      `select s.status submission_status,j.status job_status,j.lease_owner remote_job_id,
              (select count(*)::text from code_submission where user_id = $2) submissions
         from code_submission s join runner_job j on j.submission_id = s.id
        where s.id = $1`,
      [admission.submissionId, LEARNER_ID],
    );
    expect(terminal.rows[0]).toEqual({
      submission_status: "succeeded",
      job_status: "succeeded",
      remote_job_id: "remote-practice-recovery-job",
      submissions: "1",
    });

    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "91000000-0000-4000-8000-000000000003",
      reason: "Delete the learner only after the same durable practice runner admission reached terminal truth.",
      now: new Date(recoveryNow.getTime() + 2_000),
    })).resolves.toMatchObject({
      primaryStoreDeletionComplete: true,
      deletedRows: expect.objectContaining({ codeSubmissions: 1 }),
    });
    const deleted = await pool.query<{ status: string; tombstones: string }>(
      `select (select status from "user" where id = $1) status,
              (select count(*)::text from account_deletion_tombstone where user_id = $1) tombstones`,
      [LEARNER_ID],
    );
    expect(deleted.rows[0]).toEqual({ status: "deleted", tombstones: "1" });
  });

  it("safely fails an admitted practice job that crashed before its dispatch snapshot was committed", async () => {
    const { admission } = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000101",
      now: BASE_TIME,
      begin: false,
    });
    const runner = successfulRunner();
    const recoveryNow = new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 1);

    await expect(processPracticeRunnerRecoveryBatch({ runner, now: recoveryNow })).resolves.toMatchObject({
      cancelledUndispatched: 1,
      processed: 0,
    });
    expect(runner.submit).not.toHaveBeenCalled();
    const terminal = await pool.query<{
      submission_status: string;
      job_status: string;
      result: Record<string, unknown>;
      recovery_error: string;
    }>(
      `select s.status submission_status,j.status job_status,j.result,
              j.recovery_last_error_code recovery_error
         from code_submission s join runner_job j on j.submission_id=s.id
        where j.id=$1`,
      [admission.runnerJobId],
    );
    expect(terminal.rows[0]).toEqual({
      submission_status: "failed",
      job_status: "failed",
      result: {
        error: "PRACTICE_PRE_DISPATCH_STALE",
        retryable: true,
        officialEvidenceChanged: false,
      },
      recovery_error: "PRACTICE_PRE_DISPATCH_STALE",
    });
  });

  it("quarantines bad first-write snapshots and lets a later healthy admission escape head-of-line starvation", async () => {
    const corruptOne = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000111",
      now: BASE_TIME,
      admittedStdin: "expected-one",
      dispatchedStdin: "changed-one",
    });
    const corruptTwo = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000112",
      now: new Date(BASE_TIME.getTime() + 1),
      admittedStdin: "expected-two",
      dispatchedStdin: "changed-two",
    });
    const healthy = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000113",
      now: new Date(BASE_TIME.getTime() + 2),
    });
    const runner = successfulRunner();
    const recoveryNow = new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 100);

    await expect(processPracticeRunnerRecoveryBatch({ runner, now: recoveryNow, limit: 2 })).resolves.toMatchObject({
      processed: 2,
      corrupt: 2,
      reconciled: 0,
    });
    expect(runner.submit).not.toHaveBeenCalled();
    const quarantined = await pool.query<{ id: string; recovery_state: string; code: string }>(
      `select id,recovery_state,recovery_last_error_code code from runner_job
        where id=any($1::uuid[]) order by id`,
      [[corruptOne.admission.runnerJobId, corruptTwo.admission.runnerJobId]],
    );
    expect(quarantined.rows).toHaveLength(2);
    expect(quarantined.rows.every((entry) => entry.recovery_state === "quarantined" && entry.code === "PRACTICE_DISPATCH_SNAPSHOT_INVALID")).toBe(true);

    await expect(processPracticeRunnerRecoveryBatch({ runner, now: recoveryNow, limit: 2 })).resolves.toMatchObject({
      processed: 1,
      reconciled: 1,
      corrupt: 0,
    });
    expect(runner.submit).toHaveBeenCalledOnce();
    expect(runner.submit).toHaveBeenCalledWith(healthy.request, healthy.admission.requestId);
  });

  it("backs off two indeterminate oldest jobs, progresses a healthy third job, then retries exact requests when due", async () => {
    const first = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000121",
      now: BASE_TIME,
    });
    const second = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000122",
      now: new Date(BASE_TIME.getTime() + 1),
    });
    const third = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000123",
      now: new Date(BASE_TIME.getTime() + 2),
    });
    const successful = successfulRunner();
    const submittedRequestIds: string[] = [];
    let failuresRemaining = 2;
    const runner = {
      ...successful,
      submit: vi.fn(async (request: ReturnType<typeof buildPracticeRunnerRequest>, idempotencyKey: string) => {
        submittedRequestIds.push(idempotencyKey);
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new RunnerIndeterminateError("RUNNER_REQUEST_INDETERMINATE", null);
        }
        return successful.submit(request, idempotencyKey);
      }),
    };
    const recoveryNow = new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 100);

    await expect(processPracticeRunnerRecoveryBatch({ runner, now: recoveryNow, clock: () => recoveryNow, limit: 2 }))
      .resolves.toMatchObject({ processed: 2, indeterminate: 2, reconciled: 0 });
    const waiting = await pool.query<{
      id: string;
      recovery_state: string;
      recovery_attempt_count: number;
      recovery_next_attempt_at: Date;
    }>(
      `select id,recovery_state,recovery_attempt_count,recovery_next_attempt_at
         from runner_job where id=any($1::uuid[]) order by id`,
      [[first.admission.runnerJobId, second.admission.runnerJobId]],
    );
    expect(waiting.rows).toHaveLength(2);
    expect(waiting.rows.every((entry) => entry.recovery_state === "retry_wait" && entry.recovery_attempt_count === 1)).toBe(true);
    expect(waiting.rows.every((entry) => entry.recovery_next_attempt_at.getTime() === recoveryNow.getTime() + 5_000)).toBe(true);

    await expect(processPracticeRunnerRecoveryBatch({ runner, now: new Date(recoveryNow.getTime() + 4_999), limit: 2 }))
      .resolves.toMatchObject({ processed: 1, reconciled: 1 });
    expect(submittedRequestIds).toEqual([
      first.admission.requestId,
      second.admission.requestId,
      third.admission.requestId,
    ]);

    const due = new Date(recoveryNow.getTime() + 5_000);
    await expect(processPracticeRunnerRecoveryBatch({ runner, now: due, clock: () => due, limit: 2 }))
      .resolves.toMatchObject({ processed: 2, reconciled: 2 });
    expect(submittedRequestIds.slice(0, 3)).toEqual([
      first.admission.requestId,
      second.admission.requestId,
      third.admission.requestId,
    ]);
    expect(submittedRequestIds.slice(3).sort()).toEqual([
      first.admission.requestId,
      second.admission.requestId,
    ].sort());
  });

  it("backfills an active pre-migration snapshot into ready recovery state", async () => {
    const dispatch = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000131",
      now: BASE_TIME,
    });
    await pool.query("update runner_job set recovery_state=null where id=$1", [dispatch.admission.runnerJobId]);
    await pool.query(
      `update runner_job as j
          set recovery_state='ready'
         from code_submission as s
        where s.id=j.submission_id
          and s.submission_type in ('server_compile','server_run')
          and s.status in ('queued','leased','running')
          and j.status in ('queued','leased','running')
          and j.dispatch_request is not null
          and j.recovery_state is null`,
    );
    const backfilled = await pool.query<{ recovery_state: string }>(
      "select recovery_state from runner_job where id=$1",
      [dispatch.admission.runnerJobId],
    );
    expect(backfilled.rows[0]?.recovery_state).toBe("ready");

    const runner = successfulRunner();
    await expect(processPracticeRunnerRecoveryBatch({
      runner,
      now: new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 1),
    })).resolves.toMatchObject({ reconciled: 1 });
    expect(runner.submit).toHaveBeenCalledWith(dispatch.request, dispatch.admission.requestId);
  });

  it("quarantines a legacy leased row with no snapshot and lets an admin resolve it while the learner is suspended", async () => {
    const legacy = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000133",
      now: BASE_TIME,
      begin: false,
    });
    await pool.query("update code_submission set status='leased' where id=$1", [legacy.admission.submissionId]);
    await pool.query("update runner_job set status='leased',started_at=$2 where id=$1", [legacy.admission.runnerJobId, BASE_TIME]);
    await pool.query(
      `update runner_job as j
          set recovery_state='quarantined',
              recovery_attempt_count=greatest(j.recovery_attempt_count,1),
              recovery_next_attempt_at=null,
              recovery_last_error_code='PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING'
         from code_submission as s
        where s.id=j.submission_id
          and s.submission_type in ('server_compile','server_run')
          and (s.status in ('queued','leased','running') or j.status in ('queued','leased','running'))
          and (s.status in ('leased','running') or j.status in ('leased','running'))
          and j.dispatch_request is null
          and j.recovery_state is null`,
    );
    const quarantined = await pool.query<{
      recovery_state: string;
      recovery_last_error_code: string;
      dispatch_request: unknown;
    }>(
      "select recovery_state,recovery_last_error_code,dispatch_request from runner_job where id=$1",
      [legacy.admission.runnerJobId],
    );
    expect(quarantined.rows[0]).toEqual({
      recovery_state: "quarantined",
      recovery_last_error_code: "PRACTICE_LEGACY_DISPATCH_SNAPSHOT_MISSING",
      dispatch_request: null,
    });
    await pool.query("update \"user\" set status='suspended' where id=$1", [LEARNER_ID]);
    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: legacy.admission.runnerJobId,
      requestId: "91000000-0000-4000-8000-000000000134",
      reason: "Runner VM restarted and the legacy no-snapshot dispatch was reconciled safely.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    })).resolves.toMatchObject({ status: "cancelled", officialEvidenceChanged: false });
    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "91000000-0000-4000-8000-000000000135",
      reason: "Delete the suspended learner after resolving the legacy quarantined runner row.",
    })).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
  });

  it("quarantines a persisted submission/job status mismatch without contacting or settling the runner", async () => {
    const dispatch = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000136",
      now: BASE_TIME,
    });
    await pool.query("update runner_job set status='running' where id=$1", [dispatch.admission.runnerJobId]);
    const runner = successfulRunner();

    await expect(processPracticeRunnerRecoveryBatch({
      runner,
      now: new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 1),
    })).resolves.toMatchObject({ processed: 1, corrupt: 1, reconciled: 0 });
    expect(runner.submit).not.toHaveBeenCalled();
    const state = await pool.query<{ recovery_state: string; code: string; submission_status: string; job_status: string }>(
      `select j.recovery_state,j.recovery_last_error_code code,
              s.status submission_status,j.status job_status
         from runner_job j join code_submission s on s.id=j.submission_id where j.id=$1`,
      [dispatch.admission.runnerJobId],
    );
    expect(state.rows[0]).toEqual({
      recovery_state: "quarantined",
      code: "PRACTICE_DISPATCH_SNAPSHOT_INVALID",
      submission_status: "leased",
      job_status: "running",
    });
    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: dispatch.admission.runnerJobId,
      requestId: "91000000-0000-4000-8000-000000000137",
      reason: "Restarted the runner VM and reconciled the mismatched durable journal binding.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    })).resolves.toMatchObject({ status: "cancelled", officialEvidenceChanged: false });
    const resolved = await pool.query<{ submission_status: string; job_status: string }>(
      `select s.status submission_status,j.status job_status
         from runner_job j join code_submission s on s.id=j.submission_id where j.id=$1`,
      [dispatch.admission.runnerJobId],
    );
    expect(resolved.rows[0]).toEqual({ submission_status: "cancelled", job_status: "cancelled" });
    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "91000000-0000-4000-8000-000000000138",
      reason: "Delete only after the mismatched quarantined practice rows were safely reconciled.",
    })).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
  });

  it("quarantines and resolves both active-terminal status-divergence directions before deletion", async () => {
    const activeRunner = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000161",
      now: BASE_TIME,
    });
    const activeSubmission = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000162",
      now: new Date(BASE_TIME.getTime() + 1),
    });
    await pool.query("update code_submission set status='failed' where id=$1", [activeRunner.admission.submissionId]);
    await pool.query(
      `update runner_job set status='failed',result=$2::jsonb,completed_at=$3 where id=$1`,
      [activeSubmission.admission.runnerJobId, JSON.stringify({ error: "SYNTHETIC_DIVERGENCE" }), BASE_TIME],
    );
    const runner = successfulRunner();
    const recoveryNow = new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 1);

    await expect(processPracticeRunnerRecoveryBatch({ runner, now: recoveryNow, limit: 2 }))
      .resolves.toMatchObject({ processed: 2, corrupt: 2, reconciled: 0 });
    expect(runner.submit).not.toHaveBeenCalled();
    const quarantined = await pool.query<{ id: string; recovery_state: string }>(
      "select id,recovery_state from runner_job where id=any($1::uuid[]) order by id",
      [[activeRunner.admission.runnerJobId, activeSubmission.admission.runnerJobId]],
    );
    expect(quarantined.rows).toHaveLength(2);
    expect(quarantined.rows.every((row) => row.recovery_state === "quarantined")).toBe(true);

    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "91000000-0000-4000-8000-000000000163",
      reason: "Either active runner-side status must block deletion until quarantine reconciliation.",
    })).rejects.toMatchObject({ code: "RUNNER_OPERATION_IN_PROGRESS" });

    for (const [jobId, requestId] of [
      [activeRunner.admission.runnerJobId, "91000000-0000-4000-8000-000000000164"],
      [activeSubmission.admission.runnerJobId, "91000000-0000-4000-8000-000000000165"],
    ] as const) {
      await expect(resolveQuarantinedPracticeRunnerJob({
        actorUserId: ADMIN_ID,
        runnerJobId: jobId,
        requestId,
        reason: "Dedicated runner VM restarted and the divergent durable binding was reconciled.",
        isolatedRunnerRestarted: true,
        journalReconciled: true,
      })).resolves.toMatchObject({ status: "cancelled", officialEvidenceChanged: false });
    }
    const resolved = await pool.query<{ submission_status: string; job_status: string }>(
      `select s.status submission_status,j.status job_status
         from runner_job j join code_submission s on s.id=j.submission_id
        where j.id=any($1::uuid[])`,
      [[activeRunner.admission.runnerJobId, activeSubmission.admission.runnerJobId]],
    );
    expect(resolved.rows).toHaveLength(2);
    expect(resolved.rows.every((row) => row.submission_status === "cancelled" && row.job_status === "cancelled")).toBe(true);
    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "91000000-0000-4000-8000-000000000166",
      reason: "Delete only after both active-terminal divergence directions were reconciled.",
    })).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
  });

  it.each([
    ["terminal submission with active runner", "submission", "91000000-0000-4000-8000-000000000171"],
    ["active submission with terminal runner", "runner", "91000000-0000-4000-8000-000000000172"],
  ] as const)("independently blocks deletion for %s", async (_label, terminalSide, requestId) => {
    const dispatch = await createPracticeDispatch({ requestId, now: BASE_TIME });
    if (terminalSide === "submission") {
      await pool.query("update code_submission set status='failed' where id=$1", [dispatch.admission.submissionId]);
    } else {
      await pool.query(
        `update runner_job set status='failed',result=$2::jsonb,completed_at=$3 where id=$1`,
        [dispatch.admission.runnerJobId, JSON.stringify({ error: "SYNTHETIC_ONE_SIDED_DIVERGENCE" }), BASE_TIME],
      );
    }
    const runner = successfulRunner();
    await expect(processPracticeRunnerRecoveryBatch({
      runner,
      now: new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 1),
    })).resolves.toMatchObject({ processed: 1, corrupt: 1 });
    expect(runner.submit).not.toHaveBeenCalled();
    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: terminalSide === "submission"
        ? "91000000-0000-4000-8000-000000000173"
        : "91000000-0000-4000-8000-000000000174",
      reason: "A one-sided active runner state must independently block account deletion.",
    })).rejects.toMatchObject({ code: "RUNNER_OPERATION_IN_PROGRESS" });
    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: dispatch.admission.runnerJobId,
      requestId: terminalSide === "submission"
        ? "91000000-0000-4000-8000-000000000175"
        : "91000000-0000-4000-8000-000000000176",
      reason: "Dedicated runner VM restarted and the one-sided status divergence was reconciled.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    })).resolves.toMatchObject({ status: "cancelled" });
    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: terminalSide === "submission"
        ? "91000000-0000-4000-8000-000000000177"
        : "91000000-0000-4000-8000-000000000178",
      reason: "Delete only after independently resolving the one-sided status divergence.",
    })).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
  });

  it("requires an audited operator attestation to resolve quarantine, preserves official evidence, and unwedges deletion", async () => {
    const corrupt = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000141",
      now: BASE_TIME,
      admittedStdin: "expected",
      dispatchedStdin: "changed",
    });
    const runner = successfulRunner();
    const recoveryNow = new Date(BASE_TIME.getTime() + PRACTICE_RECOVERY_STALE_MS + 1);
    await expect(processPracticeRunnerRecoveryBatch({ runner, now: recoveryNow })).resolves.toMatchObject({ corrupt: 1 });
    expect(runner.submit).not.toHaveBeenCalled();
    await expect(beginRunnerDispatch({
      admission: corrupt.admission,
      dispatchRequest: corrupt.request,
      now: new Date(recoveryNow.getTime() + 1),
    })).rejects.toMatchObject({ code: "RECOVERY_QUARANTINED" });
    await expect(recordRunnerDispatch({
      admission: corrupt.admission,
      remoteJobId: "must-not-cross-quarantine",
      status: "running",
      now: new Date(recoveryNow.getTime() + 1),
    })).rejects.toMatchObject({ code: "RECOVERY_QUARANTINED" });
    await expect(settleRunnerJob({
      admission: corrupt.admission,
      status: "failed",
      runtimeImageDigest: "must-not-settle-quarantine",
      result: { error: "MUST_NOT_COMMIT" },
      completedAt: new Date(recoveryNow.getTime() + 1),
    })).rejects.toMatchObject({ code: "RECOVERY_QUARANTINED" });

    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "91000000-0000-4000-8000-000000000142",
      reason: "Verify quarantined runner ambiguity blocks erasure before operator reconciliation.",
      now: new Date(recoveryNow.getTime() + 1),
    })).rejects.toMatchObject({ code: "RUNNER_OPERATION_IN_PROGRESS" });

    const resolutionRequestId = "91000000-0000-4000-8000-000000000143";
    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: corrupt.admission.runnerJobId,
      requestId: resolutionRequestId,
      reason: "Isolated runner restarted and its durable journal confirms no active copy remains.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
      now: new Date(recoveryNow.getTime() + 2),
    })).resolves.toMatchObject({
      status: "cancelled",
      officialEvidenceChanged: false,
      replayed: false,
    });
    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: corrupt.admission.runnerJobId,
      requestId: resolutionRequestId,
      reason: "Isolated runner restarted and its durable journal confirms no active copy remains.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    })).resolves.toMatchObject({ replayed: true });
    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: corrupt.admission.runnerJobId,
      requestId: resolutionRequestId,
      reason: "Changed reason must not replay a previously audited quarantine resolution.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: corrupt.admission.runnerJobId,
      requestId: "91000000-0000-4000-8000-000000000144",
      reason: "A different operation must not replay the already committed resolution.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const evidence = await pool.query<{
      submission_status: string;
      job_status: string;
      official_changed: boolean;
      notifications: string;
      audits: string;
    }>(
      `select s.status submission_status,j.status job_status,
              coalesce((j.result->>'officialEvidenceChanged')::boolean,true) official_changed,
              (select count(*)::text from notification where user_id=$2 and type='practice-runner-recovery-resolved') notifications,
              (select count(*)::text from audit_event where subject_user_id=$2 and action='runner.practice.quarantine.resolve' and correlation_id=$3) audits
         from code_submission s join runner_job j on j.submission_id=s.id
        where j.id=$1`,
      [corrupt.admission.runnerJobId, LEARNER_ID, resolutionRequestId],
    );
    expect(evidence.rows[0]).toEqual({
      submission_status: "cancelled",
      job_status: "cancelled",
      official_changed: false,
      notifications: "1",
      audits: "1",
    });

    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "91000000-0000-4000-8000-000000000145",
      reason: "Erase the learner only after audited quarantine resolution removed runner ambiguity.",
      now: new Date(recoveryNow.getTime() + 3),
    })).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
  });

  it("never permits the practice quarantine resolver to terminalize an official exam job", async () => {
    const official = await createPracticeDispatch({
      requestId: "91000000-0000-4000-8000-000000000151",
      now: BASE_TIME,
      submissionType: "exam_final_test",
    });
    await pool.query("update runner_job set recovery_state='quarantined' where id=$1", [official.admission.runnerJobId]);

    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: official.admission.runnerJobId,
      requestId: "91000000-0000-4000-8000-000000000152",
      reason: "Official runner evidence must never use the practice quarantine escape hatch.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    })).rejects.toBeInstanceOf(PracticeRecoveryAdminError);
    await expect(resolveQuarantinedPracticeRunnerJob({
      actorUserId: ADMIN_ID,
      runnerJobId: official.admission.runnerJobId,
      requestId: "91000000-0000-4000-8000-000000000152",
      reason: "Official runner evidence must never use the practice quarantine escape hatch.",
      isolatedRunnerRestarted: true,
      journalReconciled: true,
    })).rejects.toMatchObject({ code: "NOT_PRACTICE_JOB" });
    const state = await pool.query<{ submission_status: string; job_status: string }>(
      `select s.status submission_status,j.status job_status
         from code_submission s join runner_job j on j.submission_id=s.id where j.id=$1`,
      [official.admission.runnerJobId],
    );
    expect(state.rows[0]).toEqual({ submission_status: "leased", job_status: "leased" });
  });
});
