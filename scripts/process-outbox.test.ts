import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const updateReturning = vi.fn(async () => []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const selectLimit = vi.fn(async () => []);
  const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
  const selectWhere = vi.fn(() => ({ orderBy: selectOrderBy }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const database = { update, select };
  const poolEnd = vi.fn(async () => undefined);
  const poolQuery = vi.fn();
  const pool = {
    options: {
      max: 3,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
    },
    connect: vi.fn(),
    end: poolEnd,
    query: poolQuery,
  };
  const createMailDispatchDatabaseResources = vi.fn();
  const store = Object.freeze({ kind: "postgres-outbox-store" });
  const PostgresOutboxStore = vi.fn(function PostgresOutboxStore() {
    return store;
  });
  const runtimePlan = Object.freeze({
    timeouts: Object.freeze({
      oauthDeadlineMs: 20_000,
      guardedSendDeadlineMs: 20_000,
      providerAbortSettlementMs: 5_000,
    }),
  });
  const mailDispatchPreparedRuntimePlan = vi.fn(() => runtimePlan);
  const authorizeCommittedPreparedDispatch = vi.fn(async () => Object.freeze({}));
  const discardCommittedPreparedDispatchReceipt = vi.fn(() => true);
  const discardGuardedPreparedDispatch = vi.fn(() => true);
  const processOutboxBatch = vi.fn();
  const materializedDispatch = Object.freeze({});
  const createConfiguredMaterializedDispatch = vi.fn((input: object) => {
    void input;
    return materializedDispatch;
  });
  const materializeDelivery = vi.fn();
  const watchdog = Object.freeze({
    arm: vi.fn(async () => Object.freeze({})),
    close: vi.fn(async () => undefined),
  });
  const startMailDispatchHardWatchdog = vi.fn(async () => watchdog);
  const scheduleInactivityReminders = vi.fn();
  const scheduleSmartReminders = vi.fn();
  const health = {
    success: vi.fn(),
    retry: vi.fn(),
    terminalFailure: vi.fn(),
  };
  const createWorkerHealthReporter = vi.fn(() => health);

  return {
    db: database,
    createMailDispatchDatabaseResources,
    pool,
    poolEnd,
    poolQuery,
    store,
    PostgresOutboxStore,
    runtimePlan,
    mailDispatchPreparedRuntimePlan,
    authorizeCommittedPreparedDispatch,
    discardCommittedPreparedDispatchReceipt,
    discardGuardedPreparedDispatch,
    processOutboxBatch,
    materializedDispatch,
    createConfiguredMaterializedDispatch,
    materializeDelivery,
    watchdog,
    startMailDispatchHardWatchdog,
    scheduleInactivityReminders,
    scheduleSmartReminders,
    health,
    createWorkerHealthReporter,
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  lt: vi.fn(),
  lte: vi.fn(),
}));
vi.mock("../src/lib/db/client", () => {
  throw new Error("Mail worker imported the application database client.");
});
vi.mock("../src/lib/notifications/mail-dispatch-pool", () => ({
  createMailDispatchDatabaseResources:
    mocks.createMailDispatchDatabaseResources,
}));
vi.mock("../src/lib/db/schema", () => ({
  emailOutbox: {
    id: "id",
    status: "status",
    updatedAt: "updated_at",
    nextAttemptAt: "next_attempt_at",
    createdAt: "created_at",
  },
}));
vi.mock("../src/lib/notifications/postgres-outbox-store", () => ({
  authorizeCommittedPreparedDispatch: mocks.authorizeCommittedPreparedDispatch,
  discardCommittedPreparedDispatchReceipt:
    mocks.discardCommittedPreparedDispatchReceipt,
  discardGuardedPreparedDispatch: mocks.discardGuardedPreparedDispatch,
  mailDispatchPreparedRuntimePlan: mocks.mailDispatchPreparedRuntimePlan,
  PostgresOutboxStore: mocks.PostgresOutboxStore,
}));
vi.mock("../src/lib/notifications/outbox-worker", () => ({
  processOutboxBatch: mocks.processOutboxBatch,
}));
vi.mock("../src/lib/notifications/guarded-prepared-dispatch", () => ({
  createConfiguredMaterializedDispatch:
    mocks.createConfiguredMaterializedDispatch,
}));
vi.mock("../src/lib/notifications/delivery-variables", () => ({
  materializeDeliveryWithAuthorityEvidenceWithDatabase:
    mocks.materializeDelivery,
}));
vi.mock("../src/lib/notifications/mail-dispatch-hard-watchdog", () => ({
  startMailDispatchHardWatchdog: mocks.startMailDispatchHardWatchdog,
}));
vi.mock("../src/lib/notifications/inactivity", () => ({
  scheduleInactivityReminders: mocks.scheduleInactivityReminders,
}));
vi.mock("../src/lib/notifications/smart-reminders", () => ({
  scheduleSmartRemindersWithDatabase: mocks.scheduleSmartReminders,
}));
vi.mock("./lib/worker-health", () => ({
  createWorkerHealthReporter: mocks.createWorkerHealthReporter,
}));

const originalArgv = [...process.argv];
const UUID_LOG_CANARY = "550e8400-e29b-41d4-a716-446655440000";
const BASE64URL_LOG_CANARY = "ZXlKamJHRnBiVWxrSWpvaVkyOWhhVzB0YzJWamNtVjBJaXdpYzJOdmNHVWlPaUp0WVdsc0luMA";
const RECIPIENT_LOG_CANARY = "private.person@recipient.example";
const RAW_MIME_LOG_CANARY =
  "RnJvbTogcHJpdmF0ZUBleGFtcGxlLnRlc3QNCkF1dGhvcml6YXRpb246IEJlYXJlciBwcml2YXRl";

type BatchResult = {
  claimed: number;
  swept: number;
  outcomes: Array<{
    id: string;
    operationId: string;
    kind: string;
    code?: string;
  }>;
};

async function loadWorkerOnce() {
  process.argv = [originalArgv[0]!, originalArgv[1]!, "--once"];
  await import("./process-outbox");
  await vi.waitFor(() => {
    expect(
      process.exitCode === 1 || mocks.poolEnd.mock.calls.length === 1,
    ).toBe(true);
  });
}

async function flushWorkerMicrotasks() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

describe("mail worker production composition", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const startup = await vi.importActual(
      "../src/lib/notifications/mail-dispatch-runtime-startup",
    ) as {
      inspectMailDispatchRuntime(candidatePool: unknown): Promise<unknown>;
    };
    mocks.createMailDispatchDatabaseResources.mockImplementation(async () => {
      try {
        const inspection = await startup.inspectMailDispatchRuntime(
          mocks.pool,
        );
        return { pool: mocks.pool, database: mocks.db, inspection };
      } catch (error) {
        await mocks.poolEnd();
        throw error;
      }
    });
    Object.assign(mocks.pool.options, {
      max: 3,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
    });
    vi.stubEnv("MAIL_ADAPTER", "console");
    vi.stubEnv("OUTBOX_WORKER_MODE", "fenced-postgres-v1");
    vi.stubEnv("OUTBOX_POLL_SECONDS", "10");
    vi.stubEnv("INACTIVITY_SCHEDULE_SECONDS", "60");
    process.exitCode = undefined;
    mocks.processOutboxBatch.mockResolvedValue({
      claimed: 0,
      swept: 0,
      outcomes: [],
    } satisfies BatchResult);
    mocks.poolQuery.mockResolvedValue({
      rows: [{
        max_connections: "87",
        admin_reserved_connections: "3",
        server_version_num: "170005",
      }],
    });
    mocks.materializeDelivery.mockResolvedValue({
      authorityEvidence: null,
      variables: {},
    });
    mocks.scheduleInactivityReminders.mockResolvedValue({ scheduled: 0 });
    mocks.scheduleSmartReminders.mockResolvedValue({ scheduled: 0 });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.argv = [...originalArgv];
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["", "legacy-direct-v1", "fenced-postgres-v1 "])(
    "fails closed before scheduling or claiming for worker mode %j",
    async (mode) => {
      vi.stubEnv("OUTBOX_WORKER_MODE", mode);

      await loadWorkerOnce();

      expect(process.exitCode).toBe(1);
      expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
      expect(mocks.processOutboxBatch).not.toHaveBeenCalled();
      expect(mocks.scheduleInactivityReminders).not.toHaveBeenCalled();
      expect(mocks.scheduleSmartReminders).not.toHaveBeenCalled();
      expect(mocks.createWorkerHealthReporter).not.toHaveBeenCalled();
      expect(mocks.createMailDispatchDatabaseResources).not.toHaveBeenCalled();
      expect(mocks.poolEnd).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        JSON.stringify({
          event: "email.worker_failed",
          code: "OUTBOX_WORKER_MODE_INVALID",
        }),
      );
    },
  );

  it("refuses pool drift before the startup query, scheduling, or claims", async () => {
    mocks.pool.options.max = 10;

    await loadWorkerOnce();

    expect(process.exitCode).toBe(1);
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
    expect(mocks.processOutboxBatch).not.toHaveBeenCalled();
    expect(mocks.scheduleInactivityReminders).not.toHaveBeenCalled();
    expect(mocks.scheduleSmartReminders).not.toHaveBeenCalled();
    expect(mocks.createWorkerHealthReporter).not.toHaveBeenCalled();
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });

  it("fails closed before constructing the store on PostgreSQL 16", async () => {
    mocks.poolQuery.mockResolvedValueOnce({
      rows: [{
        max_connections: "87",
        admin_reserved_connections: "3",
        server_version_num: "160011",
      }],
    });

    await loadWorkerOnce();

    expect(process.exitCode).toBe(1);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
    expect(mocks.processOutboxBatch).not.toHaveBeenCalled();
    expect(mocks.scheduleInactivityReminders).not.toHaveBeenCalled();
    expect(mocks.scheduleSmartReminders).not.toHaveBeenCalled();
    expect(mocks.createWorkerHealthReporter).not.toHaveBeenCalled();
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "email.worker_failed",
        code: "POSTGRES_RUNTIME_UNSUPPORTED",
      }),
    );
  });

  it("runs only the guarded state machine with exact startup authority", async () => {
    await loadWorkerOnce();

    expect(mocks.createMailDispatchDatabaseResources).toHaveBeenCalledOnce();
    expect(mocks.createMailDispatchDatabaseResources).toHaveBeenCalledWith();
    expect(mocks.poolQuery).toHaveBeenCalledOnce();
    const startupSql = String(
      (mocks.poolQuery.mock.calls[0]?.[0] as { text?: unknown })?.text,
    );
    expect(startupSql).toContain("current_setting('max_connections')");
    expect(startupSql).toContain(
      "current_setting('superuser_reserved_connections')",
    );
    expect(startupSql).toContain(
      "current_setting('reserved_connections', true)",
    );
    expect(startupSql).toContain("current_setting('server_version_num')");
    expect(mocks.PostgresOutboxStore).toHaveBeenCalledWith(
      mocks.pool,
      expect.objectContaining({ postgresMajor: 17 }),
    );
    expect(mocks.poolQuery.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.PostgresOutboxStore.mock.invocationCallOrder[0]!,
    );
    expect(mocks.mailDispatchPreparedRuntimePlan).toHaveBeenCalledWith(
      mocks.store,
    );
    expect(mocks.startMailDispatchHardWatchdog).toHaveBeenCalledOnce();
    expect(mocks.processOutboxBatch).toHaveBeenCalledTimes(1);
    const dependencies = mocks.processOutboxBatch.mock.calls[0]![0] as {
      store: unknown;
      adapter: string;
      authorize(receipt: unknown): Promise<unknown>;
      discardReceipt(permit: unknown, receipt: unknown): boolean;
      discardGuard(permit: unknown, guarded: unknown): boolean;
      watchdog: unknown;
      claimOwner: string;
      newClaimToken(): string;
      shouldStop(): boolean;
      policy: Record<string, number>;
      provider?: unknown;
    };
    expect(dependencies.store).toBe(mocks.store);
    expect(dependencies.adapter).toBe("console");
    expect(dependencies.watchdog).toBe(mocks.watchdog);
    expect(dependencies.provider).toBeUndefined();
    expect(dependencies.claimOwner).toMatch(/^mail-worker:/);
    expect(dependencies.newClaimToken()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(dependencies.shouldStop()).toBe(false);
    expect(dependencies.policy).toEqual({
      batchSize: 10,
      materializeLeaseMs: 60_000,
      maxMaterializeAttempts: 8,
      maxRetryDelayMs: 6 * 60 * 60_000,
      terminalPersistenceAttempts: 3,
    });

    const receipt = Object.freeze({});
    const permit = Object.freeze({});
    const guarded = Object.freeze({});
    await dependencies.authorize(receipt);
    expect(dependencies.discardReceipt(permit, receipt)).toBe(true);
    expect(dependencies.discardGuard(permit, guarded)).toBe(true);
    expect(mocks.authorizeCommittedPreparedDispatch).toHaveBeenCalledWith(
      mocks.store,
      receipt,
    );
    expect(mocks.discardCommittedPreparedDispatchReceipt).toHaveBeenCalledWith(
      mocks.store,
      permit,
      receipt,
    );
    expect(mocks.discardGuardedPreparedDispatch).toHaveBeenCalledWith(
      mocks.store,
      permit,
      guarded,
    );
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("materializes an exact configured dispatch and omits ordinary delivery overrides", async () => {
    const variables = { name: "Learner", url: "https://example.test/invitation" };
    mocks.materializeDelivery.mockResolvedValue({
      authorityEvidence: null,
      variables,
    });
    let materializeResult: unknown;
    mocks.processOutboxBatch.mockImplementation(async (dependencies: {
      materialize(claim: unknown): Promise<unknown>;
    }) => {
      materializeResult = await dependencies.materialize({
        phase: "pre-provider",
        id: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        claimToken: "33333333-3333-4333-8333-333333333333",
        claimOwner: "worker",
        claimVersion: 1,
        userId: "learner-1",
        deliveryScopeKey: "a:learner-1",
        attempt: 1,
        leaseExpiresAt: new Date("2026-07-23T00:01:00.000Z"),
        payload: {
          userId: "learner-1",
          to: "learner@example.test",
          template: "invitation",
          templateVersion: "1",
          variables,
        },
      });
      return { claimed: 1, swept: 0, outcomes: [] };
    });

    await loadWorkerOnce();

    expect(mocks.materializeDelivery).toHaveBeenCalledWith(mocks.db, {
      template: "invitation",
      variables,
      now: expect.any(Date),
    });
    expect(materializeResult).toEqual({
      kind: "ready",
      materialized: mocks.materializedDispatch,
    });
    const input = mocks.createConfiguredMaterializedDispatch.mock.calls[0]![0];
    expect(input).toEqual({
      source: {
        applicationUrl: "http://localhost:3000",
        outboxId: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        claimToken: "33333333-3333-4333-8333-333333333333",
        claimOwner: "worker",
        claimVersion: 1,
        deliveryScopeKey: "a:learner-1",
        recipient: "learner@example.test",
        template: "invitation",
        templateVersion: "1",
        variables,
      },
      adapter: "console",
      from: "Codestead <noreply@example.com>",
      messageId: expect.stringMatching(
        /^<codestead\.outbox\.v1\.[A-Za-z0-9_-]{43}@mail\.codestead\.invalid>$/u,
      ),
      runtimePlan: mocks.runtimePlan,
    });
    expect(input).not.toHaveProperty("delivery");
  });

  it("passes issued lost-device authority evidence only as ephemeral delivery", async () => {
    const recoveryRequestId = "44444444-4444-4444-8444-444444444444";
    const sourceVariables = { name: "Learner", recoveryRequestId };
    const authorityEvidence = Object.freeze({
      kind: "lost-device-proof" as const,
      sourceId: recoveryRequestId,
      proofHash: "a".repeat(64),
    });
    const deliveryVariables = {
      name: "Learner",
      url: "http://localhost:3000/lost-device#proof=" + "A".repeat(43),
    };
    mocks.materializeDelivery.mockResolvedValue({
      authorityEvidence,
      variables: deliveryVariables,
    });
    mocks.processOutboxBatch.mockImplementation(async (dependencies: {
      materialize(claim: unknown): Promise<unknown>;
    }) => {
      await dependencies.materialize({
        phase: "pre-provider",
        id: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        claimToken: "33333333-3333-4333-8333-333333333333",
        claimOwner: "worker",
        claimVersion: 1,
        userId: "learner-1",
        deliveryScopeKey: "a:learner-1",
        attempt: 1,
        leaseExpiresAt: new Date("2026-07-23T00:01:00.000Z"),
        payload: {
          userId: "learner-1",
          to: "learner@example.test",
          template: "lost-device-proof",
          templateVersion: "1",
          variables: sourceVariables,
        },
      });
      return { claimed: 1, swept: 0, outcomes: [] };
    });

    await loadWorkerOnce();

    const input = mocks.createConfiguredMaterializedDispatch.mock.calls[0]![0] as {
      source: { variables: Record<string, string> };
      delivery?: unknown;
    };
    expect(input.source.variables).toEqual(sourceVariables);
    expect(input.source.variables).not.toHaveProperty("url");
    expect(input.delivery).toEqual({
      authorityEvidence,
      variables: deliveryVariables,
    });
  });

  it("suppresses an unknown stored template before materialization or provider work", async () => {
    let materializeResult: unknown;
    mocks.processOutboxBatch.mockImplementation(async (dependencies: {
      materialize(claim: unknown): Promise<unknown>;
    }) => {
      materializeResult = await dependencies.materialize({
        phase: "pre-provider",
        id: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        claimToken: "33333333-3333-4333-8333-333333333333",
        claimOwner: "worker",
        claimVersion: 1,
        attempt: 1,
        leaseExpiresAt: new Date("2026-07-23T00:01:00.000Z"),
        payload: {
          userId: "learner-1",
          to: "learner@example.test",
          template: "exam-result",
          templateVersion: "1",
          variables: {},
        },
      });
      return { claimed: 1, swept: 0, outcomes: [] };
    });

    await loadWorkerOnce();

    expect(materializeResult).toEqual({
      kind: "suppressed",
      code: "TEMPLATE_POLICY_INVALID",
    });
    expect(mocks.materializeDelivery).not.toHaveBeenCalled();
    expect(mocks.createConfiguredMaterializedDispatch).not.toHaveBeenCalled();
  });
  it("suppresses a row before provider delivery when delivery proof cannot be materialized", async () => {
    mocks.materializeDelivery.mockResolvedValue(null);
    let materializeResult: unknown;
    mocks.processOutboxBatch.mockImplementation(async (dependencies: {
      materialize(claim: unknown): Promise<unknown>;
    }) => {
      materializeResult = await dependencies.materialize({
        phase: "pre-provider",
        id: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        claimToken: "33333333-3333-4333-8333-333333333333",
        claimOwner: "worker",
        claimVersion: 1,
        attempt: 1,
        leaseExpiresAt: new Date("2026-07-23T00:01:00.000Z"),
        payload: {
          userId: "learner-1",
          to: "learner@example.test",
          template: "lost-device-proof",
          templateVersion: "1",
          variables: { recoveryRequestId: "expired" },
        },
      });
      return { claimed: 1, swept: 0, outcomes: [] };
    });

    await loadWorkerOnce();

    expect(materializeResult).toEqual({
      kind: "suppressed",
      code: "DELIVERY_PROOF_UNAVAILABLE",
    });
    expect(mocks.createConfiguredMaterializedDispatch).not.toHaveBeenCalled();
  });

  it("logs outcome counts without row, operation, recipient, or bearer data", async () => {
    mocks.processOutboxBatch.mockResolvedValue({
      claimed: 7,
      swept: 2,
      outcomes: [
        { id: "row-sent", operationId: "operation-secret-1", kind: "sent" },
        { id: "row-retry", operationId: "operation-secret-2", kind: "retry" },
        { id: "row-failed", operationId: "operation-secret-3", kind: "failed" },
        { id: "row-suppressed", operationId: "operation-secret-4", kind: "suppressed" },
        { id: "row-quarantined", operationId: "operation-secret-5", kind: "quarantined" },
        { id: "row-lost", operationId: "operation-secret-6", kind: "claim-lost" },
        {
          id: "row-unknown",
          operationId: "operation-secret-7",
          kind: "persistence-unknown",
        },
      ],
    } satisfies BatchResult);

    await loadWorkerOnce();

    const entries = vi.mocked(console.info).mock.calls
      .map(([entry]) => String(entry))
      .filter((entry) => entry.includes('"event":"email.outbox_batch"'));
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!)).toEqual({
      event: "email.outbox_batch",
      claimed: 7,
      swept: 2,
      sent: 1,
      retried: 1,
      failed: 1,
      suppressed: 1,
      quarantined: 1,
      claimLost: 1,
      persistenceUnknown: 1,
    });
    expect(entries[0]).not.toMatch(/row-|operation-secret|recipient|token/i);
  });

  it("rejects UUID and base64url-shaped identifiers from fatal worker logs", async () => {
    const failure = Object.assign(new Error(
      `claim=${UUID_LOG_CANARY}; recipient=${RECIPIENT_LOG_CANARY}; raw=${RAW_MIME_LOG_CANARY}`,
      {
        cause: new Error(`scope=${BASE64URL_LOG_CANARY}`),
      },
    ), {
      name: UUID_LOG_CANARY,
      code: BASE64URL_LOG_CANARY,
      stack: `provider=${BASE64URL_LOG_CANARY}; outbox=${UUID_LOG_CANARY}`,
    });
    mocks.scheduleInactivityReminders.mockRejectedValueOnce(failure);

    await loadWorkerOnce();

    const entries = vi.mocked(console.error).mock.calls
      .map(([entry]) => String(entry))
      .filter((entry) => entry.includes('"event":"email.worker_failed"'));
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!)).toEqual({
      event: "email.worker_failed",
      code: "MAIL_WORKER_FAILED",
    });
    for (const canary of [
      UUID_LOG_CANARY,
      BASE64URL_LOG_CANARY,
      RECIPIENT_LOG_CANARY,
      RAW_MIME_LOG_CANARY,
    ]) {
      expect(entries[0]).not.toContain(canary);
    }
    expect(mocks.health.retry).toHaveBeenCalledWith(failure);
    expect(mocks.health.terminalFailure).toHaveBeenCalledWith(failure);
  });

  it("preserves one-shot scheduling, health reporting, and pool cleanup", async () => {
    await loadWorkerOnce();

    expect(mocks.scheduleInactivityReminders).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleSmartReminders).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleInactivityReminders).toHaveBeenCalledWith(
      expect.any(Date),
      mocks.pool,
    );
    expect(mocks.scheduleSmartReminders).toHaveBeenCalledWith(
      mocks.db,
      expect.any(Date),
    );
    expect(mocks.health.success).toHaveBeenCalledTimes(1);
    expect(mocks.health.retry).not.toHaveBeenCalled();
    expect(mocks.health.terminalFailure).not.toHaveBeenCalled();
    expect(mocks.watchdog.close).toHaveBeenCalledTimes(1);
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
    expect(mocks.watchdog.close.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.poolEnd.mock.invocationCallOrder[0]!,
    );
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "interrupts the poll wait on %s and exits without claiming another batch",
    async (signal) => {
      vi.useFakeTimers();
      vi.stubEnv("OUTBOX_POLL_SECONDS", "1");
      process.argv = [originalArgv[0]!, originalArgv[1]!];
      const before = {
        SIGTERM: process.listeners("SIGTERM"),
        SIGINT: process.listeners("SIGINT"),
      };
      mocks.processOutboxBatch.mockImplementation(async () => {
        if (mocks.processOutboxBatch.mock.calls.length === 1) {
          return { claimed: 0, swept: 0, outcomes: [] } satisfies BatchResult;
        }
        throw new Error("LEGACY_CONTINUOUS_LOOP_TEST_CLEANUP");
      });

      await import("./process-outbox");
      await flushWorkerMicrotasks();
      expect(mocks.processOutboxBatch).toHaveBeenCalledTimes(1);

      const signalHandler = process.listeners(signal)
        .find((listener) => !before[signal].includes(listener));
      if (!signalHandler) {
        await vi.advanceTimersByTimeAsync(1_000);
        await flushWorkerMicrotasks();
        expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
        expect(signalHandler).toBeTypeOf("function");
        return;
      }

      signalHandler(signal);
      await flushWorkerMicrotasks();

      expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
      expect(mocks.processOutboxBatch).toHaveBeenCalledTimes(1);
      expect(mocks.health.success).toHaveBeenCalledTimes(1);
      expect(mocks.health.retry).not.toHaveBeenCalled();
      expect(mocks.health.terminalFailure).not.toHaveBeenCalled();
      expect(
        process.listeners("SIGTERM")
          .filter((listener) => !before.SIGTERM.includes(listener)),
      ).toEqual([]);
      expect(
        process.listeners("SIGINT")
          .filter((listener) => !before.SIGINT.includes(listener)),
      ).toEqual([]);
    },
  );

  it("exposes SIGTERM to an in-flight batch without aborting that batch", async () => {
    process.argv = [originalArgv[0]!, originalArgv[1]!];
    const before = process.listeners("SIGTERM");
    let shouldStop: (() => boolean) | undefined;
    let finishBatch: ((result: BatchResult) => void) | undefined;
    const inFlight = new Promise<BatchResult>((resolve) => {
      finishBatch = resolve;
    });
    mocks.processOutboxBatch.mockImplementation(async (dependencies: {
      shouldStop?: () => boolean;
    }) => {
      shouldStop = dependencies.shouldStop;
      return inFlight;
    });

    await import("./process-outbox");
    await flushWorkerMicrotasks();

    const signalHandler = process.listeners("SIGTERM")
      .find((listener) => !before.includes(listener));
    const wiredShouldStop = shouldStop;
    expect(signalHandler).toBeTypeOf("function");
    signalHandler!("SIGTERM");
    const stopObservedDuringBatch = wiredShouldStop?.();
    expect(mocks.poolEnd).not.toHaveBeenCalled();

    finishBatch?.({ claimed: 1, swept: 0, outcomes: [] });
    await flushWorkerMicrotasks();

    expect(wiredShouldStop).toBeTypeOf("function");
    expect(stopObservedDuringBatch).toBe(true);
    expect(mocks.processOutboxBatch).toHaveBeenCalledTimes(1);
    expect(mocks.health.success).toHaveBeenCalledTimes(1);
    expect(mocks.health.retry).not.toHaveBeenCalled();
    expect(mocks.health.terminalFailure).not.toHaveBeenCalled();
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });

  it("does not report a timeout when pool shutdown wins the deadline race", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as unknown as typeof process.exit,
    );
    let monotonicMilliseconds = 0;
    vi.spyOn(globalThis.performance, "now").mockImplementation(
      () => monotonicMilliseconds,
    );
    mocks.poolEnd.mockImplementationOnce(async () => {
      monotonicMilliseconds = 5_000;
    });
    process.argv = [originalArgv[0]!, originalArgv[1]!, "--once"];

    await import("./process-outbox");
    await flushWorkerMicrotasks();

    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
    const entries = vi.mocked(console.error).mock.calls
      .map(([entry]) => String(entry))
      .filter((entry) => entry.includes('"event":"email.worker_cleanup_failed"'));
    expect(entries).toEqual([]);
  });

  it("bounds pool cleanup to five seconds and reports timeout without PII", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as unknown as typeof process.exit,
    );
    mocks.poolEnd.mockImplementationOnce(
      () => new Promise<undefined>(() => undefined),
    );
    process.argv = [originalArgv[0]!, originalArgv[1]!, "--once"];

    await import("./process-outbox");
    await flushWorkerMicrotasks();

    expect(mocks.processOutboxBatch).toHaveBeenCalledTimes(1);
    expect(mocks.health.success).toHaveBeenCalledTimes(1);
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();

    await vi.advanceTimersByTimeAsync(4_999);
    await flushWorkerMicrotasks();
    expect(process.exitCode).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await flushWorkerMicrotasks();

    expect(process.exitCode).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    const entries = vi.mocked(console.error).mock.calls
      .map(([entry]) => String(entry))
      .filter((entry) => entry.includes('"event":"email.worker_cleanup_failed"'));
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!)).toEqual({
      event: "email.worker_cleanup_failed",
      code: "POOL_SHUTDOWN_TIMEOUT",
    });
    expect(entries[0]).not.toMatch(/row|operation|recipient|provider|token/i);
  });
});
