import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "@/lib/db/client";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import {
  admitRunnerJob,
  beginRunnerDispatch,
  hashRunnerAdmissionRequest,
  recordRunnerDispatch,
  RUNNER_STALE_DISPATCH_MS,
  settleRunnerJob,
} from "@/lib/runner/admission";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";

const ADMIN_ID = "runner-admission-admin";
const LEARNER_ID = "runner-admission-learner";
const SECOND_LEARNER_ID = "runner-admission-learner-2";
const BASE_TIME = new Date("2026-07-12T06:00:00.000Z");
const LIMITS = Object.freeze({
  wallTimeMs: 5_000,
  memoryMb: 128,
  cpuCount: 0.5,
  pids: 32,
  outputBytes: 65_536,
  fileBytes: 16_777_216,
});

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Runner admission integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  `);
  if (result.rows.length) {
    const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(",");
    await pool.query(`truncate table ${names} restart identity cascade`);
  }
}

async function waitForAdvisoryWaiter(blockerPid: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: boolean }>(`
      select exists (
        select 1 from pg_locks held join pg_locks waiter
          on waiter.locktype = held.locktype
         and waiter.database is not distinct from held.database
         and waiter.classid is not distinct from held.classid
         and waiter.objid is not distinct from held.objid
         and waiter.objsubid is not distinct from held.objsubid
       where held.pid = $1 and held.locktype = 'advisory' and held.granted
         and waiter.pid <> held.pid and not waiter.granted
      ) waiting
    `, [blockerPid]);
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected an operation to wait on the user-authority lock.");
}

function input(overrides: {
  userId?: string;
  requestId: string;
  submissionType: "exam_final_test" | "assessment_correction_regrade" | "server_run";
  sourceCode?: string;
  now?: Date;
}) {
  const userId = overrides.userId ?? LEARNER_ID;
  const sourceCode = overrides.sourceCode ?? "print('runner admission')\n";
  const sourceHash = createHash("sha256").update(sourceCode).digest("hex");
  return {
    userId,
    language: "python",
    sourceCode,
    sourceHash,
    submissionType: overrides.submissionType,
    requestId: overrides.requestId,
    requestHash: hashRunnerAdmissionRequest({
      schemaVersion: 1,
      userId,
      sourceHash,
      submissionType: overrides.submissionType,
      limits: LIMITS,
    }),
    limits: { ...LIMITS },
    now: overrides.now ?? BASE_TIME,
  };
}

beforeEach(async () => {
  await truncateApplicationTables();
  await pool.query(
    `insert into "user" (id,name,email,role,status,created_at,updated_at)
     values ($1,'Runner Learner','runner-admission@integration.invalid','learner','active',$3,$3),
            ($2,'Second Runner Learner','runner-admission-2@integration.invalid','learner','active',$3,$3),
            ($4,'Runner Admin','runner-admission-admin@integration.invalid','admin','active',$3,$3)`,
    [LEARNER_ID, SECOND_LEARNER_ID, BASE_TIME, ADMIN_ID],
  );
  process.env.DELETION_TOMBSTONE_KEY = "runner-admission-deletion-key-at-least-32-bytes";
});

afterAll(async () => {
  delete process.env.DELETION_TOMBSTONE_KEY;
  await pool.end();
});

describe("atomic runner admission", () => {
  it("admits only one concurrent official job per learner while preserving practice and other learners", async () => {
    const candidates = await Promise.allSettled([
      admitRunnerJob(input({ requestId: "official-exam-concurrent-1", submissionType: "exam_final_test" })),
      admitRunnerJob(input({ requestId: "official-regrade-concurrent-2", submissionType: "assessment_correction_regrade" })),
    ]);

    const admitted = candidates.filter((candidate) => candidate.status === "fulfilled");
    const rejected = candidates.filter((candidate) => candidate.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: { code: "OFFICIAL_CAPACITY_BUSY", retryable: true },
    });

    const practice = await admitRunnerJob(input({
      requestId: "practice-alongside-official",
      submissionType: "server_run",
    }));
    const otherLearner = await admitRunnerJob(input({
      userId: SECOND_LEARNER_ID,
      requestId: "other-learner-official",
      submissionType: "exam_final_test",
    }));
    expect(practice.status).toBe("queued");
    expect(otherLearner.status).toBe("queued");

    const active = await pool.query<{ user_id: string; official: number; practice: number }>(
      `select user_id,
              count(*) filter (where submission_type in ('exam_final_test','assessment_correction_regrade'))::int official,
              count(*) filter (where submission_type = 'server_run')::int practice
         from code_submission
        where status in ('queued','leased','running')
        group by user_id order by user_id`,
    );
    expect(active.rows).toEqual([
      { user_id: LEARNER_ID, official: 1, practice: 1 },
      { user_id: SECOND_LEARNER_ID, official: 1, practice: 0 },
    ]);
  });

  it("makes the first remote job identity immutable through dispatch and terminal settlement", async () => {
    const admitted = await admitRunnerJob(input({
      requestId: "official-immutable-remote-id",
      submissionType: "exam_final_test",
    }));
    await beginRunnerDispatch({ admission: admitted });
    await expect(recordRunnerDispatch({
      admission: admitted,
      remoteJobId: "remote-job-a",
      status: "running",
    })).resolves.toEqual({ replayed: false });

    await expect(recordRunnerDispatch({
      admission: admitted,
      remoteJobId: "remote-job-b",
      status: "running",
    })).rejects.toMatchObject({ code: "REMOTE_JOB_ID_MISMATCH" });
    await expect(settleRunnerJob({
      admission: admitted,
      status: "succeeded",
      remoteJobId: "remote-job-b",
      runtimeImageDigest: "sha256:wrong-remote",
      result: { truth: "wrong remote" },
    })).rejects.toMatchObject({ code: "REMOTE_JOB_ID_MISMATCH" });
    await expect(settleRunnerJob({
      admission: admitted,
      status: "succeeded",
      runtimeImageDigest: "sha256:missing-remote",
      result: { truth: "missing remote" },
    })).rejects.toMatchObject({ code: "REMOTE_JOB_ID_MISMATCH" });

    await expect(settleRunnerJob({
      admission: admitted,
      status: "succeeded",
      remoteJobId: "remote-job-a",
      runtimeImageDigest: "sha256:trusted-remote-a",
      result: { truth: "remote a" },
    })).resolves.toEqual({ replayed: false });
    await expect(settleRunnerJob({
      admission: admitted,
      status: "failed",
      remoteJobId: "remote-job-b",
      runtimeImageDigest: "sha256:late-remote-b",
      result: { truth: "late remote b" },
    })).rejects.toMatchObject({ code: "REMOTE_JOB_ID_MISMATCH" });

    const stored = await pool.query<{ lease_owner: string; status: string; digest: string; truth: string }>(
      `select j.lease_owner,j.status,s.runtime_image_digest digest,j.result ->> 'truth' truth
         from runner_job j join code_submission s on s.id = j.submission_id
        where j.id = $1`,
      [admitted.runnerJobId],
    );
    expect(stored.rows[0]).toEqual({
      lease_owner: "remote-job-a",
      status: "succeeded",
      digest: "sha256:trusted-remote-a",
      truth: "remote a",
    });
  });

  it("keeps an indeterminate dispatch on the same admission beyond the stale queued threshold", async () => {
    const originalInput = input({
      requestId: "official-indeterminate-same-generation",
      submissionType: "assessment_correction_regrade",
    });
    const admitted = await admitRunnerJob(originalInput);
    await beginRunnerDispatch({ admission: admitted, now: BASE_TIME });

    const replay = await admitRunnerJob({
      ...originalInput,
      now: new Date(BASE_TIME.getTime() + RUNNER_STALE_DISPATCH_MS * 2),
    });
    expect(replay).toMatchObject({
      duplicate: true,
      submissionId: admitted.submissionId,
      runnerJobId: admitted.runnerJobId,
      status: "leased",
      remoteJobId: null,
    });
    await expect(admitRunnerJob(input({
      requestId: "official-overlap-while-indeterminate",
      submissionType: "exam_final_test",
      now: new Date(BASE_TIME.getTime() + RUNNER_STALE_DISPATCH_MS * 2),
    }))).rejects.toMatchObject({ code: "OFFICIAL_CAPACITY_BUSY", activeSubmissionId: admitted.submissionId });

    await recordRunnerDispatch({
      admission: replay,
      remoteJobId: "remote-indeterminate-reconciled",
      status: "running",
    });
    await settleRunnerJob({
      admission: replay,
      status: "succeeded",
      remoteJobId: "remote-indeterminate-reconciled",
      runtimeImageDigest: "sha256:reconciled",
      result: { truth: "same generation reconciled" },
    });
    expect((await pool.query(
      `select id from code_submission where user_id = $1 and request_id = $2`,
      [LEARNER_ID, originalInput.requestId],
    )).rows).toHaveLength(1);
  });

  it("replays exact requests, rejects changed payloads, releases terminal slots, and fences late settlement", async () => {
    const firstInput = input({ requestId: "official-replay-request-1", submissionType: "exam_final_test" });
    const first = await admitRunnerJob(firstInput);
    const replay = await admitRunnerJob(firstInput);
    expect(replay).toMatchObject({
      duplicate: true,
      submissionId: first.submissionId,
      runnerJobId: first.runnerJobId,
      status: "queued",
    });

    await expect(admitRunnerJob({
      ...firstInput,
      sourceCode: "print('changed')\n",
      sourceHash: createHash("sha256").update("print('changed')\n").digest("hex"),
      requestHash: hashRunnerAdmissionRequest({ changed: true }),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH", retryable: false });

    await beginRunnerDispatch({ admission: first, now: new Date(BASE_TIME.getTime() + 500) });
    await recordRunnerDispatch({
      admission: first,
      remoteJobId: "remote-first",
      status: "running",
      now: new Date(BASE_TIME.getTime() + 600),
    });
    const settled = await settleRunnerJob({
      admission: first,
      status: "succeeded",
      remoteJobId: "remote-first",
      runtimeImageDigest: "sha256:trusted-first",
      result: { truth: "first-terminal-result" },
      completedAt: new Date(BASE_TIME.getTime() + 1_000),
    });
    expect(settled).toEqual({ replayed: false });
    const terminalReplay = await settleRunnerJob({
      admission: first,
      status: "failed",
      remoteJobId: "remote-first",
      runtimeImageDigest: "sha256:late-overwrite",
      result: { truth: "late-result-must-not-win" },
      completedAt: new Date(BASE_TIME.getTime() + 2_000),
    });
    expect(terminalReplay).toEqual({ replayed: true });

    const second = await admitRunnerJob(input({
      requestId: "official-after-terminal-release",
      submissionType: "assessment_correction_regrade",
      now: new Date(BASE_TIME.getTime() + 3_000),
    }));
    expect(second.status).toBe("queued");
    await beginRunnerDispatch({ admission: second, now: new Date(BASE_TIME.getTime() + 3_100) });
    await recordRunnerDispatch({
      admission: second,
      remoteJobId: "remote-second",
      status: "running",
      now: new Date(BASE_TIME.getTime() + 3_200),
    });

    const cancellation = await pool.connect();
    try {
      await cancellation.query("begin");
      await cancellation.query("select pg_advisory_xact_lock(hashtext($1))", [`runner-learner:${LEARNER_ID}`]);
      await cancellation.query(
        `update runner_job set status = 'cancelled',result = $2::jsonb,completed_at = $3 where id = $1`,
        [second.runnerJobId, JSON.stringify({ truth: "cancelled-terminal-truth" }), new Date(BASE_TIME.getTime() + 4_000)],
      );
      await cancellation.query(
        `update code_submission set status = 'cancelled',runtime_image_digest = 'runner-cancelled' where id = $1`,
        [second.submissionId],
      );
      await cancellation.query("commit");
    } catch (error) {
      await cancellation.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      cancellation.release();
    }

    await expect(settleRunnerJob({
      admission: second,
      status: "succeeded",
      remoteJobId: "remote-second",
      runtimeImageDigest: "sha256:late-after-cancel",
      result: { truth: "late-after-cancel" },
      completedAt: new Date(BASE_TIME.getTime() + 5_000),
    })).resolves.toEqual({ replayed: true });

    const truth = await pool.query<{
      submission_status: string;
      digest: string;
      job_status: string;
      result: { truth: string };
      submissions: string;
      jobs: string;
      first_status: string;
      first_digest: string;
      first_result: { truth: string };
    }>(
      `select s.status submission_status,s.runtime_image_digest digest,
              j.status job_status,j.result,
              (select count(*)::text from code_submission where user_id = $2 and request_id = $3) submissions,
              (select count(*)::text from runner_job where submission_id = $4::uuid) jobs,
              (select status from code_submission where id = $4::uuid) first_status,
              (select runtime_image_digest from code_submission where id = $4::uuid) first_digest,
              (select result from runner_job where submission_id = $4::uuid) first_result
         from code_submission s join runner_job j on j.submission_id = s.id
        where s.id = $1`,
      [second.submissionId, LEARNER_ID, firstInput.requestId, first.submissionId],
    );
    expect(truth.rows[0]).toMatchObject({
      submission_status: "cancelled",
      digest: "runner-cancelled",
      job_status: "cancelled",
      result: { truth: "cancelled-terminal-truth" },
      submissions: "1",
      jobs: "1",
      first_status: "succeeded",
      first_digest: "sha256:trusted-first",
      first_result: { truth: "first-terminal-result" },
    });

    await expect(pool.query(
      `insert into runner_job (submission_id,status,limits,queued_at) values ($1,'queued','{}'::jsonb,$2)`,
      [first.submissionId, BASE_TIME],
    )).rejects.toMatchObject({ code: "23505", constraint: "runner_job_submission_unique" });
  });

  it("reconciles a crashed pre-dispatch admission and rejects its late remote result", async () => {
    const crashedInput = input({ requestId: "official-crashed-before-dispatch", submissionType: "exam_final_test" });
    const crashed = await admitRunnerJob(crashedInput);

    await expect(admitRunnerJob(input({
      requestId: "official-before-stale-threshold",
      submissionType: "assessment_correction_regrade",
      now: new Date(BASE_TIME.getTime() + RUNNER_STALE_DISPATCH_MS - 1),
    }))).rejects.toMatchObject({ code: "OFFICIAL_CAPACITY_BUSY" });

    const recovered = await admitRunnerJob(input({
      requestId: "official-after-stale-recovery",
      submissionType: "assessment_correction_regrade",
      now: new Date(BASE_TIME.getTime() + RUNNER_STALE_DISPATCH_MS + 1),
    }));
    expect(recovered.status).toBe("queued");

    await expect(recordRunnerDispatch({
      admission: crashed,
      remoteJobId: "late-remote-job",
      status: "running",
      now: new Date(BASE_TIME.getTime() + RUNNER_STALE_DISPATCH_MS + 2),
    })).resolves.toEqual({ replayed: true });
    await expect(settleRunnerJob({
      admission: crashed,
      status: "succeeded",
      remoteJobId: "late-remote-job",
      runtimeImageDigest: "sha256:late-stale-result",
      result: { truth: "late-stale-result" },
      completedAt: new Date(BASE_TIME.getTime() + RUNNER_STALE_DISPATCH_MS + 3),
    })).rejects.toMatchObject({ code: "REMOTE_JOB_ID_MISMATCH" });

    const replay = await admitRunnerJob({
      ...crashedInput,
      now: new Date(BASE_TIME.getTime() + RUNNER_STALE_DISPATCH_MS + 4),
    });
    expect(replay).toMatchObject({
      duplicate: true,
      submissionId: crashed.submissionId,
      status: "failed",
      runtimeImageDigest: "runner-dispatch-stale",
      result: {
        error: "OFFICIAL_DISPATCH_STALE",
        retryable: true,
        officialEvidenceChanged: false,
      },
    });

    const evidence = await pool.query<{
      attempts: string;
      mastery: string;
      evidence: string;
      active_official: string;
    }>(
      `select
        (select count(*)::text from attempt where user_id = $1) attempts,
        (select count(*)::text from concept_mastery where user_id = $1) mastery,
        (select count(*)::text from mastery_evidence where user_id = $1) evidence,
        (select count(*)::text from code_submission
          where user_id = $1 and submission_type in ('exam_final_test','assessment_correction_regrade')
            and status in ('queued','leased','running')) active_official`,
      [LEARNER_ID],
    );
    expect(evidence.rows[0]).toEqual({ attempts: "0", mastery: "0", evidence: "0", active_official: "1" });
  });

  it("serializes account deletion ahead of admission and never creates post-deletion runner rows", async () => {
    const blocker = await pool.connect();
    let deletion: Promise<unknown> | null = null;
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtext($1))", [userAuthorityLockKey(LEARNER_ID)]);
      const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!.pid;

      deletion = deleteLearnerAccount({
        actorUserId: ADMIN_ID,
        learnerId: LEARNER_ID,
        requestId: "de100000-0000-4000-8000-000000000001",
        reason: "Verified deletion and runner-admission serialization integration test.",
        now: new Date(BASE_TIME.getTime() + 10_000),
        objectStorageRoot: "C:/tmp/runner-admission-deletion-empty",
      });
      await waitForAdvisoryWaiter(pid);
      const admission = admitRunnerJob(input({
        requestId: "official-racing-account-deletion",
        submissionType: "exam_final_test",
        now: new Date(BASE_TIME.getTime() + 10_001),
      }));
      await blocker.query("commit");

      await expect(admission).rejects.toMatchObject({ code: "USER_NOT_ACTIVE", retryable: false });
      await expect(deletion).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
    } catch (error) {
      await blocker.query("rollback").catch(() => undefined);
      if (deletion) await deletion.catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }

    const state = await pool.query<{ status: string; submissions: string; jobs: string }>(
      `select u.status,
              (select count(*)::text from code_submission where user_id = u.id) submissions,
              (select count(*)::text from runner_job j join code_submission s on s.id = j.submission_id where s.user_id = u.id) jobs
         from "user" u where u.id = $1`,
      [LEARNER_ID],
    );
    expect(state.rows[0]).toEqual({ status: "deleted", submissions: "0", jobs: "0" });
  });

  it("lets deletion cancel an admitted pre-dispatch row and prevents dispatch afterward", async () => {
    const admitted = await admitRunnerJob(input({
      requestId: "official-admitted-before-deletion",
      submissionType: "exam_final_test",
    }));

    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "de100000-0000-4000-8000-000000000002",
      reason: "Cancel the safe pre-dispatch admission before completing account deletion.",
      now: new Date(BASE_TIME.getTime() + 20_000),
      objectStorageRoot: "C:/tmp/runner-admission-deletion-empty",
    })).resolves.toMatchObject({ primaryStoreDeletionComplete: true });
    await expect(beginRunnerDispatch({ admission: admitted }))
      .rejects.toMatchObject({ code: "USER_NOT_ACTIVE", retryable: false });
    expect((await pool.query(
      `select id from code_submission where user_id = $1`,
      [LEARNER_ID],
    )).rows).toHaveLength(0);
  });

  it("blocks deletion once the immutable dispatch boundary may represent remote work", async () => {
    const admitted = await admitRunnerJob(input({
      requestId: "official-dispatch-before-deletion",
      submissionType: "exam_final_test",
    }));
    await beginRunnerDispatch({ admission: admitted });

    await expect(deleteLearnerAccount({
      actorUserId: ADMIN_ID,
      learnerId: LEARNER_ID,
      requestId: "de100000-0000-4000-8000-000000000003",
      reason: "Prove account deletion refuses possibly dispatched runner work.",
      now: new Date(BASE_TIME.getTime() + 30_000),
      objectStorageRoot: "C:/tmp/runner-admission-deletion-empty",
    })).rejects.toMatchObject({ code: "RUNNER_OPERATION_IN_PROGRESS" });
    const state = await pool.query<{ status: string; submission_status: string }>(
      `select u.status,s.status submission_status from "user" u
        join code_submission s on s.user_id = u.id where u.id = $1`,
      [LEARNER_ID],
    );
    expect(state.rows[0]).toEqual({ status: "active", submission_status: "leased" });
  });
});
