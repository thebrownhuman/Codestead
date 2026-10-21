import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteLearnerAccount } from "@/lib/data-lifecycle/deletion";
import { db, pool } from "@/lib/db/client";
import { accessRequest, invitation } from "@/lib/db/schema";
import { accountMailEventIdempotencyKey } from "@/lib/notifications/idempotency-authority";
import { enqueueEmail, enqueueEmailInTransaction } from "@/lib/notifications/outbox";
import { accessRequestAuthorityLockKey, lockAccessRequestAuthority, lockAccessRequestSourceAuthority } from "@/lib/security/user-authority-lock";
import { changeLearnerStorageQuota } from "@/lib/storage/admin-quota";
import { DEFAULT_STORAGE_QUOTA_BYTES } from "@/lib/storage/policy";
import {
  ACCESS_INVITATION_TOKEN_HASH,
  ACCESS_INVITATION_URL,
  ACCESS_REQUEST_ID,
  ADMIN_ID,
  CLAIM_TOKENS,
  FinalDeletionCommitFault,
  INVITATION_ID,
  LEARNER_EMAIL,
  LEARNER_ID,
  LEARNER_PUBLIC_ID,
  POST_DELETE_ACCESS_REQUEST_ID,
  QueryPause,
  applicationTransactionPid,
  beginProviderCall,
  deferred,
  deletionDependenciesWithHooks,
  deletionInput,
  deletionPersistenceState,
  expectSingleDurableDeletionNotice,
  expiredPermit,
  faultInjectableDeletionDependencies,
  holdFinalizerUserAuthorityGate,
  isBlockingAdvisoryLock,
  objectStorageRoot,
  outboxState,
  persistApprovedAccessSystemMail,
  requireClaim,
  requireSingleSuccessfulFinalizer,
  runDeletionFinalizerRace,
  store,
  registerMailDeliveryRaceHarness,
  waitForAdvisoryWaiters,
  waitForBlockedBackendBy,
  within,
  workerPool,
  zeroErasureDependencies,
} from "./fixtures/mail-delivery-races-harness";

registerMailDeliveryRaceHarness();

describe("real PostgreSQL mail delivery races", () => {

  it("finalizes a definite rejection from the released sweeper successor without another provider call", async () => {
    const { claim, permit } = await expiredPermit();

    await expect((await store()).quarantineAbandoned({ limit: 10 }).catch(error => {
      console.error(JSON.stringify({ event: "mail.integration.sweep_failed",
        total: workerPool.totalCount, idle: workerPool.idleCount, waiting: workerPool.waitingCount }));
      throw error;
    })).resolves.toBe(1);
    await expect((await store()).finishAfterProvider(permit, {
      kind: "failed",
      code: "PROVIDER_DEFINITELY_REJECTED",
    })).resolves.toEqual({ kind: "applied" });

    expect((await outboxState())[0]).toMatchObject({
      status: "failed",
      claim_version: claim.claimVersion + 1,
      claim_token: null,
      claim_owner: null,
      lease_expires_at: null,
      provider_message_id: null,
      sent_at: null,
      quarantined_at: null,
      last_error_code: "PROVIDER_DEFINITELY_REJECTED",
    });
  }, 180_000);

  it("rejects an access decision after deletion status commits and before phase-two cleanup", async () => {
    await db.insert(accessRequest).values({
      id: ACCESS_REQUEST_ID,
      email: LEARNER_EMAIL,
      name: "Mail Race Learner",
      reason: "Pending before the deletion status transition.",
      adultConfirmedAt: new Date(),
    });
    const beforeFirstAccessLock = new QueryPause();
    let accessLockAttempts = 0;
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000029"),
      deletionDependenciesWithHooks({
        before: async (event) => {
          if (
            isBlockingAdvisoryLock(event.sql)
            && event.values[0] === accessRequestAuthorityLockKey(LEARNER_EMAIL)
          ) {
            accessLockAttempts += 1;
            if (accessLockAttempts === 1) {
              await beforeFirstAccessLock.hold(event.pid);
            }
          }
        },
      }),
    );
    await within(
      beforeFirstAccessLock.reached,
      "phase-two access-request lock attempt",
      10_000,
    );
    expect((await pool.query<{ status: string }>(
      `select status::text from "user" where id = $1`,
      [LEARNER_ID],
    )).rows[0]?.status).toBe("deletion_pending");

    const sourceAuthorized = await db.transaction(async (tx) => {
      const allowed = await lockAccessRequestSourceAuthority(
        tx,
        LEARNER_EMAIL,
      );
      if (!allowed) return false;
      const decidedAt = new Date();
      await tx
        .update(accessRequest)
        .set({
          status: "approved",
          decidedBy: ADMIN_ID,
          decisionReason: "This branch must be unreachable during deletion.",
          decidedAt,
        })
        .where(sql`${accessRequest.id} = ${ACCESS_REQUEST_ID}::uuid`);
      await tx.insert(invitation).values({
        id: INVITATION_ID,
        accessRequestId: ACCESS_REQUEST_ID,
        email: LEARNER_EMAIL,
        tokenHash: ACCESS_INVITATION_TOKEN_HASH,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        createdBy: ADMIN_ID,
      });
      await enqueueEmailInTransaction(tx, {
        to: LEARNER_EMAIL,
        template: "invitation",
        variables: {
          name: "Mail Race Learner",
          url: ACCESS_INVITATION_URL,
        },
        systemProducer: "access-request-approved",
        audienceId: ACCESS_REQUEST_ID,
        sourceId: INVITATION_ID,
        idempotencySeed: INVITATION_ID,
      });
      return true;
    });
    const prematureClaim = await (await store()).claimNext({
      owner: "status-window-system-worker",
      token: CLAIM_TOKENS[0],
      leaseMs: 60_000,
    });
    const prematureBoundary = prematureClaim
      ? await beginProviderCall(prematureClaim)
      : null;

    let assertionError: unknown = null;
    try {
      expect(sourceAuthorized).toBe(false);
      expect(prematureClaim).toBeNull();
      expect(prematureBoundary).toBeNull();
    } catch (error) {
      assertionError = error;
    } finally {
      beforeFirstAccessLock.release();
    }
    const deletionOutcome = await Promise.allSettled([deletion]);
    if (assertionError) throw assertionError;
    expect(deletionOutcome[0]?.status).toBe("fulfilled");
    expect((await pool.query(
      `select id from access_request where id = $1::uuid
       union all select id from invitation where id = $2::uuid
       union all select id from email_outbox
         where variables ->> '_mailSourceId' = $2::text`,
      [ACCESS_REQUEST_ID, INVITATION_ID],
    )).rows).toHaveLength(0);
  }, 30_000);

  it("makes a committed access approval lose to deletion cleanup without an orphan mail source", async () => {
    const producerReady = deferred();
    const releaseProducer = deferred();
    let producerPid: number | null = null;
    const producer = db.transaction(async (tx) => {
      const sourceAuthorized =
        await lockAccessRequestSourceAuthority(tx, LEARNER_EMAIL);
      if (!sourceAuthorized) {
        throw new Error("Expected pre-deletion source authority.");
      }
      producerPid = await applicationTransactionPid(tx);
      await persistApprovedAccessSystemMail(
        tx,
        `  ${LEARNER_EMAIL.toUpperCase()}  `,
      );
      producerReady.resolve();
      await releaseProducer.promise;
    });
    const readyOrFailure = Promise.race([
      producerReady.promise,
      producer.then(() => {
        throw new Error("Access producer committed before its test gate opened.");
      }),
    ]);
    await within(readyOrFailure, "approved access producer", 10_000);

    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000030"),
      zeroErasureDependencies(),
    );
    let waitError: unknown = null;
    try {
      const blocked = await waitForBlockedBackendBy(producerPid!, 10_000);
      expect(blocked).toEqual([
        expect.objectContaining({
          wait_event_type: "Lock",
          wait_event: "transactionid",
          query: expect.stringContaining(`from "user" where id = $1 for update`),
        }),
      ]);
      const exactLockProbe = await pool.query<{ acquired: boolean }>(
        `select pg_catalog.pg_try_advisory_xact_lock(
           pg_catalog.hashtext($1)::pg_catalog.int8
         ) as acquired`,
        [accessRequestAuthorityLockKey(LEARNER_EMAIL)],
      );
      expect(exactLockProbe.rows[0]?.acquired).toBe(false);
    } catch (error) {
      waitError = error;
    } finally {
      releaseProducer.resolve();
    }
    const [producerOutcome, deletionOutcome] = await Promise.allSettled([
      producer,
      deletion,
    ]);
    if (waitError) throw waitError;
    expect(producerOutcome.status).toBe("fulfilled");
    expect(deletionOutcome.status).toBe("fulfilled");
    if (deletionOutcome.status !== "fulfilled") throw deletionOutcome.reason;

    expect(deletionOutcome.value.deletedRows.accessRequests).toBeGreaterThanOrEqual(1);
    expect(deletionOutcome.value.deletedRows.invitations).toBeGreaterThanOrEqual(1);
    const residue = (await pool.query<{
      access_requests: number;
      invitations: number;
      outbox_rows: number;
    }>(`
      select
        (select count(*)::int from access_request where id = $1::uuid) access_requests,
        (select count(*)::int from invitation where id = $2::uuid) invitations,
        (select count(*)::int from email_outbox
          where variables ->> '_mailSourceId' = $2::text) outbox_rows
    `, [ACCESS_REQUEST_ID, INVITATION_ID])).rows[0];
    expect(residue).toEqual({
      access_requests: 0,
      invitations: 0,
      outbox_rows: 0,
    });
  }, 30_000);

  it("lets a same-email access request begin only after final pseudonymization", async () => {
    const finalAccessLock = new QueryPause();
    let accessLockCount = 0;
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000031"),
      deletionDependenciesWithHooks({
        after: async (event) => {
          if (
            isBlockingAdvisoryLock(event.sql)
            && event.values[0] === accessRequestAuthorityLockKey(LEARNER_EMAIL)
          ) {
            accessLockCount += 1;
            if (accessLockCount === 2) {
              await finalAccessLock.hold(event.pid);
            }
          }
        },
      }),
    );
    await within(finalAccessLock.reached, "final access-request authority lock", 10_000);

    const producerAttempted = deferred();
    const producer = db.transaction(async (tx) => {
      const pid = await applicationTransactionPid(tx);
      producerAttempted.resolve();
      const sourceAuthorized =
        await lockAccessRequestSourceAuthority(tx, LEARNER_EMAIL);
      if (!sourceAuthorized) {
        throw new Error("Expected post-deletion source authority.");
      }
      await tx.insert(accessRequest).values({
        id: POST_DELETE_ACCESS_REQUEST_ID,
        email: LEARNER_EMAIL,
        name: "New Mailbox Owner",
        reason: "A genuinely new request after the prior account was erased.",
        adultConfirmedAt: new Date(),
      });
      return pid;
    });
    await within(producerAttempted.promise, "post-deletion access producer", 10_000);

    let waitError: unknown = null;
    try {
      await waitForAdvisoryWaiters(finalAccessLock.pid!, 1, 10_000);
    } catch (error) {
      waitError = error;
    } finally {
      finalAccessLock.release();
    }
    const [deletionOutcome, producerOutcome] = await Promise.allSettled([
      deletion,
      producer,
    ]);
    if (waitError) throw waitError;
    expect(deletionOutcome.status).toBe("fulfilled");
    expect(producerOutcome.status).toBe("fulfilled");

    const postCommit = (await pool.query<{
      user_status: string;
      user_email: string;
      request_status: string;
      request_email: string;
    }>(`
      select deleted_user.status::text user_status,
             deleted_user.email user_email,
             fresh_request.status::text request_status,
             fresh_request.email request_email
        from "user" deleted_user
        join access_request fresh_request on fresh_request.id = $2::uuid
       where deleted_user.id = $1
    `, [LEARNER_ID, POST_DELETE_ACCESS_REQUEST_ID])).rows[0];
    expect(postCommit).toEqual({
      user_status: "deleted",
      user_email: expect.stringMatching(/^deleted\+.*@invalid[.]local$/u),
      request_status: "pending",
      request_email: LEARNER_EMAIL,
    });
  }, 30_000);

  it("rejects delayed account mail while the final deletion transaction owns user authority", async () => {
    const finalOutboxDelete = new QueryPause();
    let outboxDeleteCount = 0;
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000032"),
      deletionDependenciesWithHooks({
        after: async (event) => {
          if (
            event.sql.startsWith(
              "delete from email_outbox where user_id = $1 or pg_catalog.lower(pg_catalog.btrim(to_email)) = pg_catalog.lower(pg_catalog.btrim($2))",
            )
          ) {
            outboxDeleteCount += 1;
            if (outboxDeleteCount === 2) {
              await finalOutboxDelete.hold(event.pid);
            }
          }
        },
      }),
    );
    // Attach rejection handling before waiting at the barrier, and always
    // release it on timeout so a failed race cannot poison the next reset.
    const deletionOutcome = deletion.then(
      value => ({ value }), reason => ({ reason }),
    );
    let observed: unknown;
    let attemptError: unknown = null;
    try {
      await within(finalOutboxDelete.reached, "final outbox deletion", 10_000);
      observed = await within(
        enqueueEmail({
          to: LEARNER_EMAIL,
          template: "credential-changed",
          variables: { name: "Mail Race Learner" },
          userId: LEARNER_ID,
          idempotencySeed: "delayed-after-final-outbox-delete",
        }).catch((error: unknown) => error),
        "delayed account-mail rejection",
        5_000,
      );
    } catch (error) {
      attemptError = error;
    } finally {
      finalOutboxDelete.release();
    }
    const completed = await deletionOutcome;
    if (attemptError) throw attemptError;
    if ("reason" in completed) throw completed.reason;
    expect(observed).toMatchObject({
      name: "EmailOutboxPersistenceError",
      code: "EMAIL_OUTBOX_PERSISTENCE_FAILED",
    });
    expect((await pool.query(
      `select id from email_outbox
        where user_id = $1 and template = 'credential-changed'`,
      [LEARNER_ID],
    )).rows).toHaveLength(0);
  }, 30_000);

  it("rejects a stale quota mutation after deletion wins user authority", async () => {
    const blocker = await holdFinalizerUserAuthorityGate();
    const deletion = deleteLearnerAccount(
      deletionInput(objectStorageRoot, "95000000-0000-4000-8000-000000000034"),
      zeroErasureDependencies(),
    );
    let quota: ReturnType<typeof changeLearnerStorageQuota> | null = null;
    let waitError: unknown = null;
    try {
      await waitForAdvisoryWaiters(blocker.pid, 1, 10_000);
      quota = changeLearnerStorageQuota({
        learnerPublicId: LEARNER_PUBLIC_ID,
        requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES + 256 * 1024 ** 2,
        expectedRowVersion: 0,
        requestId: "95000000-0000-4000-8000-000000000035",
        actorUserId: ADMIN_ID,
        reason: "Prove quota authority cannot survive account deletion.",
      });
      await waitForAdvisoryWaiters(blocker.pid, 2, 10_000);
    } catch (error) {
      waitError = error;
    } finally {
      await blocker.release();
    }
    const [deletionOutcome, quotaOutcome] = await Promise.allSettled([
      deletion,
      quota ?? Promise.reject(waitError),
    ]);
    if (waitError) throw waitError;
    expect(deletionOutcome.status).toBe("fulfilled");
    expect(quotaOutcome.status).toBe("rejected");
    if (quotaOutcome.status === "rejected") {
      expect(quotaOutcome.reason).toMatchObject({ code: "LEARNER_NOT_FOUND" });
    }
    expect((await pool.query(`
      select
        (select count(*)::int from learner_profile where user_id = $1) profiles,
        (select count(*)::int from notification
          where user_id = $1 and type = 'storage-quota-changed') notices,
        (select count(*)::int from storage_quota_change
          where learner_user_id = $1) changes
    `, [LEARNER_ID])).rows[0]).toEqual({
      profiles: 0,
      notices: 0,
      changes: 0,
    });
  }, 30_000);

  it("suppresses a released system row whose authoritative request source was removed", async () => {
    await db.transaction(async (tx) => {
      const sourceAuthorized =
        await lockAccessRequestSourceAuthority(tx, LEARNER_EMAIL);
      if (!sourceAuthorized) throw new Error("Expected source authority.");
      await persistApprovedAccessSystemMail(tx);
    });
    await db.transaction(async (tx) => {
      await lockAccessRequestAuthority(tx, LEARNER_EMAIL);
      await tx.execute(sql`delete from invitation where id = ${INVITATION_ID}::uuid`);
      await tx.execute(sql`delete from access_request where id = ${ACCESS_REQUEST_ID}::uuid`);
    });

    const claim = await requireClaim(
      CLAIM_TOKENS[0],
      "orphan-system-source-worker",
    );
    await expect(beginProviderCall(claim)).resolves.toEqual({
      kind: "suppressed",
      code: "SYSTEM_EMAIL_AUTHORITY_INVALID",
    });
    expect((await outboxState())[0]).toMatchObject({
      status: "suppressed",
      provider_call_started: null,
      last_error_code: "SYSTEM_EMAIL_AUTHORITY_INVALID",
    });
  }, 30_000);

  it("commits one notice when two same-request finalizers queue on the user-authority lock", async () => {
    const requestId = "95000000-0000-4000-8000-000000000020";
    const report = requireSingleSuccessfulFinalizer(
      await runDeletionFinalizerRace([requestId, requestId]),
    );
    const state = await deletionPersistenceState(report);

    expectSingleDurableDeletionNotice(report, state);
    expect(state.runs).toEqual([{
      id: report.runId,
      status: "succeeded",
      idempotency_key: `account-deletion:${LEARNER_ID}:${requestId}`,
      error_code: null,
    }]);
  });

  it("commits one notice but records the losing distinct request as a failed lifecycle run", async () => {
    const requestIds = [
      "95000000-0000-4000-8000-000000000021",
      "95000000-0000-4000-8000-000000000022",
    ] as const;
    const report = requireSingleSuccessfulFinalizer(
      await runDeletionFinalizerRace(requestIds),
    );
    const state = await deletionPersistenceState(report);

    expectSingleDurableDeletionNotice(report, state);
    expect(state.runs).toHaveLength(2);
    expect(state.runs.map((run) => run.idempotency_key).sort()).toEqual(
      requestIds
        .map((requestId) => `account-deletion:${LEARNER_ID}:${requestId}`)
        .sort(),
    );
    expect(state.runs.filter((run) => run.status === "succeeded")).toEqual([
      expect.objectContaining({
        id: report.runId,
        error_code: null,
      }),
    ]);
    expect(state.runs.filter((run) => run.status === "failed")).toEqual([
      expect.objectContaining({
        error_code: "LEARNER_NOT_FOUND",
      }),
    ]);
  });

  it("rolls the final transaction back and lets the same request retry to one notice", async () => {
    const requestId = "95000000-0000-4000-8000-000000000023";
    const fault = new FinalDeletionCommitFault(
      "rollback-before-final-commit-ack",
    );

    await expect(deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      faultInjectableDeletionDependencies(fault),
    )).rejects.toThrow("forced account-deletion final commit rollback");
    expect(fault.wasConsumed).toBe(true);

    const [failedRun] = (await pool.query<{
      id: string;
      status: string;
      error_code: string | null;
    }>(
      `select id::text, status, error_code
         from data_lifecycle_run
        where operation = 'account_deletion' and target_user_id = $1`,
      [LEARNER_ID],
    )).rows;
    expect(failedRun).toMatchObject({
      status: "failed",
      error_code: "ACCOUNT_DELETION_FAILED",
    });
    const failedEventKey = accountMailEventIdempotencyKey({
      eventId: failedRun!.id,
      template: "account-deleted",
      userId: LEARNER_ID,
    });
    expect((await pool.query(
      `select id from account_deletion_tombstone where user_id = $1`,
      [LEARNER_ID],
    )).rows).toHaveLength(0);
    expect((await pool.query(
      `select id from email_outbox
        where template = 'account-deleted' and user_id = $1`,
      [LEARNER_ID],
    )).rows).toHaveLength(0);

    const retry = await deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      zeroErasureDependencies(),
    );
    expect(retry.runId).toBe(failedRun!.id);
    expect(retry.replayed).toBe(false);
    const state = await deletionPersistenceState(retry);
    expect(state.eventKey).toBe(failedEventKey);
    expectSingleDurableDeletionNotice(retry, state);
    expect(state.runs).toEqual([{
      id: retry.runId,
      status: "succeeded",
      idempotency_key: `account-deletion:${LEARNER_ID}:${requestId}`,
      error_code: null,
    }]);
  });

  it("replays the committed tombstone after final-commit acknowledgement loss without another notice", async () => {
    const requestId = "95000000-0000-4000-8000-000000000024";
    const fault = new FinalDeletionCommitFault("final-commit-ack-lost");

    await expect(deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      faultInjectableDeletionDependencies(fault),
    )).rejects.toThrow(
      "forced account-deletion final commit acknowledgement loss",
    );
    expect(fault.wasConsumed).toBe(true);

    const replay = await deleteLearnerAccount(
      deletionInput(objectStorageRoot, requestId),
      zeroErasureDependencies(),
    );
    expect(replay.replayed).toBe(true);
    const state = await deletionPersistenceState(replay);
    expectSingleDurableDeletionNotice(replay, state);
    expect(state.runs).toEqual([{
      id: replay.runId,
      status: "succeeded",
      idempotency_key: `account-deletion:${LEARNER_ID}:${requestId}`,
      error_code: null,
    }]);
  });
});
