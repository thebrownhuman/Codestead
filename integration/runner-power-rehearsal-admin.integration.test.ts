import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { pool } from "@/lib/db/client";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";
import {
  admitRunnerJob,
  beginRunnerDispatch,
  hashRunnerAdmissionRequest,
} from "@/lib/runner/admission";
import {
  abortRunnerPowerRehearsal,
  armRunnerPowerRehearsal,
  getRunnerPowerRehearsalStatus,
  releaseRunnerPowerRehearsal,
} from "@/lib/runner/power-rehearsal-admin";
import { holdRunnerDispatchForPowerRehearsal } from "@/lib/runner/power-rehearsal-hold";
import { buildPracticeRunnerRequest, PRACTICE_LIMITS } from "@/lib/runner/practice-dispatch";

const ADMIN = "rehearsal-admin";
const LEARNER_ONE = "rehearsal-learner-one";
const LEARNER_TWO = "rehearsal-learner-two";
const EVENT = "a0000000-0000-4000-8000-000000000001";
const COMMAND = "a0000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-20T10:00:00.000Z");
const REASON = "Supervised physical power-loss recovery rehearsal for the pilot release.";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Power-rehearsal tests require the disposable learncoding_integration database.");
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

async function createHeldDispatch(input: {
  learnerId: string;
  requestId: string;
  source: string;
  now: Date;
}) {
  const sourceHash = createHash("sha256").update(input.source).digest("hex");
  const admission = await admitRunnerJob({
    userId: input.learnerId,
    language: "python",
    sourceCode: input.source,
    sourceHash,
    submissionType: "server_run",
    requestId: input.requestId,
    requestHash: hashRunnerAdmissionRequest({
      schemaVersion: 1,
      userId: input.learnerId,
      requestId: input.requestId,
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
    now: input.now,
  });
  const request = buildPracticeRunnerRequest({
    admission,
    language: "python",
    runtimeVersion: "Python 3.14",
    entrypoint: "main.py",
    sourceCode: input.source,
    mode: "quick_run",
  });
  await beginRunnerDispatch({ admission, dispatchRequest: request, now: input.now });
  const hold = await holdRunnerDispatchForPowerRehearsal({
    userId: input.learnerId,
    requestId: input.requestId,
    submissionId: admission.submissionId,
    runnerJobId: admission.runnerJobId,
    now: input.now,
  });
  expect(hold).toMatchObject({ held: true, eventId: EVENT, replayed: false });
  return admission;
}

beforeEach(async () => {
  await truncateApplicationTables();
  await pool.query(
    `insert into "user" (id,public_id,name,email,role,status,email_verified,two_factor_enabled)
     values ($1,'a0000000-0000-4000-8000-000000000010','Rehearsal Admin','rehearsal-admin@integration.invalid','admin','active',true,true),
            ($2,'a0000000-0000-4000-8000-000000000011','Rehearsal Learner One','rehearsal-one@integration.invalid','learner','active',true,true),
            ($3,'a0000000-0000-4000-8000-000000000012','Rehearsal Learner Two','rehearsal-two@integration.invalid','learner','active',true,true)`,
    [ADMIN, LEARNER_ONE, LEARNER_TWO],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("root-operated runner power rehearsal in PostgreSQL", () => {
  it("holds exactly two real admissions then atomically releases their existing rows to recovery", async () => {
    await armRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId: EVENT,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    });
    const first = await createHeldDispatch({
      learnerId: LEARNER_ONE,
      requestId: "a0000000-0000-4000-8000-000000000101",
      source: "print('one')\n",
      now: new Date(NOW.getTime() + 1_000),
    });
    const second = await createHeldDispatch({
      learnerId: LEARNER_TWO,
      requestId: "a0000000-0000-4000-8000-000000000102",
      source: "print('two')\n",
      now: new Date(NOW.getTime() + 2_000),
    });
    await expect(getRunnerPowerRehearsalStatus({ actorUserId: ADMIN, eventId: EVENT, now: NOW }))
      .resolves.toMatchObject({
        state: "filled",
        slotOne: { bound: true, runnerJobId: first.runnerJobId },
        slotTwo: { bound: true, runnerJobId: second.runnerJobId },
      });

    const beforeRows = await pool.query<{ submissions: string; jobs: string }>(
      `select (select count(*)::text from code_submission) submissions,
              (select count(*)::text from runner_job) jobs`,
    );
    const released = await releaseRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId: EVENT,
      commandId: COMMAND,
      reason: REASON,
      now: new Date(NOW.getTime() + 3_000),
    });
    expect(released).toMatchObject({ state: "released", recoveryJobsMadeDue: 2, replayed: false });
    const afterRows = await pool.query<{
      id: string;
      status: string;
      recovery_state: string;
      recovery_next_attempt_at: Date;
      recovery_last_error_code: string;
    }>(`select id,status,recovery_state,recovery_next_attempt_at,recovery_last_error_code
          from runner_job order by id`);
    expect(afterRows.rows).toHaveLength(2);
    expect(afterRows.rows.every((row) =>
      row.status === "leased"
      && row.recovery_state === "retry_wait"
      && row.recovery_next_attempt_at.getTime() === NOW.getTime() + 3_000
      && row.recovery_last_error_code === "POWER_REHEARSAL_RELEASED"
    )).toBe(true);
    expect(await pool.query(`select count(*)::text count from code_submission`)).toMatchObject({
      rows: [{ count: beforeRows.rows[0]?.submissions }],
    });
    expect(await pool.query(`select count(*)::text count from runner_job`)).toMatchObject({
      rows: [{ count: beforeRows.rows[0]?.jobs }],
    });
    const audits = await pool.query<{ action: string; correlation_id: string }>(
      `select action,correlation_id from audit_event order by occurred_at,id`,
    );
    expect(audits.rows).toEqual([
      { action: "runner.power_rehearsal.arm", correlation_id: EVENT },
      { action: "runner.power_rehearsal.release", correlation_id: COMMAND },
    ]);

    await expect(releaseRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId: EVENT,
      commandId: COMMAND,
      reason: REASON,
      now: new Date(NOW.getTime() + 4_000),
    })).resolves.toMatchObject({ replayed: true, recoveryJobsMadeDue: 2 });
    expect((await pool.query(`select count(*)::text count from audit_event`)).rows[0]?.count).toBe("2");
  });
  it("waits for the recovery advisory lock then rejects a dispatch that crossed the remote boundary", async () => {
    await armRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId: EVENT,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    });
    const source = "print('race')\n";
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const requestId = "a0000000-0000-4000-8000-000000000121";
    const admission = await admitRunnerJob({
      userId: LEARNER_ONE,
      language: "python",
      sourceCode: source,
      sourceHash,
      submissionType: "server_run",
      requestId,
      requestHash: hashRunnerAdmissionRequest({
        schemaVersion: 1,
        userId: LEARNER_ONE,
        requestId,
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
      now: NOW,
    });
    const dispatch = buildPracticeRunnerRequest({
      admission,
      language: "python",
      runtimeVersion: "Python 3.14",
      entrypoint: "main.py",
      sourceCode: source,
      mode: "quick_run",
    });
    await beginRunnerDispatch({ admission, dispatchRequest: dispatch, now: NOW });

    const recoveryGuard = await pool.connect();
    const lockName = `practice-runner-recovery:${admission.runnerJobId}`;
    await recoveryGuard.query("select pg_advisory_lock(hashtext($1))", [lockName]);
    try {
      const holdResult = holdRunnerDispatchForPowerRehearsal({
        userId: LEARNER_ONE,
        requestId,
        submissionId: admission.submissionId,
        runnerJobId: admission.runnerJobId,
        now: new Date(NOW.getTime() + 1_000),
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );

      const deadline = Date.now() + 2_000;
      let advisoryWaitObserved = false;
      while (Date.now() < deadline) {
        const waiting = await recoveryGuard.query<{ count: string }>(
          "select count(*)::text count from pg_locks where locktype='advisory' and not granted",
        );
        if (waiting.rows[0]?.count !== "0") {
          advisoryWaitObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(advisoryWaitObserved).toBe(true);

      await recoveryGuard.query(
        "update runner_job set lease_owner='remote-race-proof' where id=$1",
        [admission.runnerJobId],
      );
      await recoveryGuard.query("select pg_advisory_unlock(hashtext($1))", [lockName]);
      const result = await holdResult;
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "HOLD_BINDING_INDETERMINATE", indeterminate: true },
      });
      expect((await pool.query(
        "select slot_one_runner_job_id from runner_power_rehearsal_event where id=$1",
        [EVENT],
      )).rows).toEqual([{ slot_one_runner_job_id: null }]);
    } finally {
      await recoveryGuard.query("select pg_advisory_unlock(hashtext($1))", [lockName]).catch(() => undefined);
      recoveryGuard.release();
    }
  });


  it("aborts a partial hold, makes only its existing job due, and never marks success", async () => {
    await armRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId: EVENT,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 5,
      now: NOW,
    });
    const first = await createHeldDispatch({
      learnerId: LEARNER_ONE,
      requestId: "a0000000-0000-4000-8000-000000000111",
      source: "print('partial')\n",
      now: new Date(NOW.getTime() + 1_000),
    });
    const aborted = await abortRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId: EVENT,
      commandId: COMMAND,
      reason: "Abort because the second supervised rehearsal browser is unavailable.",
      now: new Date(NOW.getTime() + 2_000),
    });
    expect(aborted).toMatchObject({
      state: "aborted",
      recoveryJobsMadeDue: 1,
      successfulRehearsal: false,
    });
    const job = await pool.query<{ id: string; recovery_state: string }>(
      `select id,recovery_state from runner_job where id=$1`, [first.runnerJobId],
    );
    expect(job.rows).toEqual([{ id: first.runnerJobId, recovery_state: "retry_wait" }]);
  });

  it("serializes competing arm commands so exactly one active event exists", async () => {
    const secondEvent = "a0000000-0000-4000-8000-000000000099";
    const inputs = [EVENT, secondEvent].map((eventId) => armRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    }));
    const results = await Promise.allSettled(inputs);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason)
      .toMatchObject({ code: "ACTIVE_EVENT_EXISTS" });
    expect((await pool.query(
      `select count(*)::text count from runner_power_rehearsal_event where state in ('armed','filled')`,
    )).rows[0]?.count).toBe("1");
  });

  it("serializes arm behind account deletion and rejects the now-inactive learner", async () => {
    const deletionClient = await pool.connect();
    let transactionOpen = false;
    try {
      await deletionClient.query("begin");
      transactionOpen = true;
      await deletionClient.query("select pg_advisory_xact_lock(hashtext($1))", [
        userAuthorityLockKey(LEARNER_ONE),
      ]);
      await deletionClient.query(`update "user" set status='deletion_pending' where id=$1`, [
        LEARNER_ONE,
      ]);

      const armResult = armRunnerPowerRehearsal({
        actorUserId: ADMIN,
        eventId: EVENT,
        learnerOneId: LEARNER_ONE,
        learnerTwoId: LEARNER_TWO,
        reason: REASON,
        expiresInMinutes: 30,
        now: NOW,
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );

      const deadline = Date.now() + 2_000;
      let authorityWaitObserved = false;
      while (Date.now() < deadline) {
        const waiting = await pool.query<{ count: string }>(
          "select count(*)::text count from pg_locks where locktype='advisory' and not granted",
        );
        if (waiting.rows[0]?.count !== "0") {
          authorityWaitObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(authorityWaitObserved).toBe(true);

      await deletionClient.query("commit");
      transactionOpen = false;
      await expect(armResult).resolves.toMatchObject({
        status: "rejected",
        reason: { code: "LEARNERS_REQUIRED" },
      });
      expect((await pool.query(
        "select count(*)::text count from runner_power_rehearsal_event",
      )).rows[0]?.count).toBe("0");
    } finally {
      if (transactionOpen) await deletionClient.query("rollback").catch(() => undefined);
      deletionClient.release();
      await pool.query(`update "user" set status='active' where id=$1`, [LEARNER_ONE]);
    }
  });

  it("rolls back arm if the immutable audit append fails", async () => {
    await pool.query(`
      create function integration_fail_rehearsal_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action = 'runner.power_rehearsal.arm' then
          raise exception 'integration audit failure' using errcode = 'P0001';
        end if;
        return new;
      end;
      $$;
      create trigger integration_fail_rehearsal_audit
      before insert on audit_event for each row execute function integration_fail_rehearsal_audit();
    `);
    try {
      await expect(armRunnerPowerRehearsal({
        actorUserId: ADMIN,
        eventId: EVENT,
        learnerOneId: LEARNER_ONE,
        learnerTwoId: LEARNER_TWO,
        reason: REASON,
        expiresInMinutes: 30,
        now: NOW,
      })).rejects.toBeInstanceOf(Error);
      expect((await pool.query(`select count(*)::text count from runner_power_rehearsal_event`)).rows[0]?.count)
        .toBe("0");
    } finally {
      await pool.query(`drop trigger if exists integration_fail_rehearsal_audit on audit_event`);
      await pool.query(`drop function if exists integration_fail_rehearsal_audit()`);
    }
  });

  it("rejects a learner actor and an inactive target before event insertion", async () => {
    await pool.query(`update "user" set role='learner' where id=$1`, [ADMIN]);
    await expect(armRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId: EVENT,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await pool.query(`update "user" set role='admin' where id=$1`, [ADMIN]);
    await pool.query(`update "user" set status='suspended' where id=$1`, [LEARNER_TWO]);
    await expect(armRunnerPowerRehearsal({
      actorUserId: ADMIN,
      eventId: EVENT,
      learnerOneId: LEARNER_ONE,
      learnerTwoId: LEARNER_TWO,
      reason: REASON,
      expiresInMinutes: 30,
      now: NOW,
    })).rejects.toMatchObject({ code: "LEARNERS_REQUIRED" });
    expect((await pool.query(`select count(*)::text count from runner_power_rehearsal_event`)).rows[0]?.count)
      .toBe("0");
  });
});
