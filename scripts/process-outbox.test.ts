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

  const poolEnd = vi.fn(async () => undefined);
  const pool = { connect: vi.fn(), end: poolEnd };
  const store = { kind: "postgres-outbox-store" };
  const PostgresOutboxStore = vi.fn(function PostgresOutboxStore() {
    return store;
  });
  const processOutboxBatch = vi.fn();
  const materializeDeliveryVariables = vi.fn();
  const sendEmail = vi.fn();
  const scheduleInactivityReminders = vi.fn();
  const scheduleSmartReminders = vi.fn();
  const health = {
    success: vi.fn(),
    retry: vi.fn(),
    terminalFailure: vi.fn(),
  };
  const createWorkerHealthReporter = vi.fn(() => health);

  return {
    db: { update, select },
    pool,
    poolEnd,
    store,
    PostgresOutboxStore,
    processOutboxBatch,
    materializeDeliveryVariables,
    sendEmail,
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
vi.mock("../src/lib/db/client", () => ({ db: mocks.db, pool: mocks.pool }));
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
  PostgresOutboxStore: mocks.PostgresOutboxStore,
}));
vi.mock("../src/lib/notifications/outbox-worker", () => ({
  processOutboxBatch: mocks.processOutboxBatch,
}));
vi.mock("../src/lib/notifications/mailer", () => ({
  sendEmail: mocks.sendEmail,
}));
vi.mock("../src/lib/notifications/delivery-variables", () => ({
  materializeDeliveryVariables: mocks.materializeDeliveryVariables,
}));
vi.mock("../src/lib/notifications/inactivity", () => ({
  scheduleInactivityReminders: mocks.scheduleInactivityReminders,
}));
vi.mock("../src/lib/notifications/smart-reminders", () => ({
  scheduleSmartReminders: mocks.scheduleSmartReminders,
}));
vi.mock("./lib/worker-health", () => ({
  createWorkerHealthReporter: mocks.createWorkerHealthReporter,
}));

const originalArgv = [...process.argv];

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
  await vi.waitFor(() => expect(mocks.poolEnd).toHaveBeenCalledTimes(1));
}

async function flushWorkerMicrotasks() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

describe("mail worker production composition", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("MAIL_ADAPTER", "console");
    vi.stubEnv("OUTBOX_POLL_SECONDS", "10");
    vi.stubEnv("INACTIVITY_SCHEDULE_SECONDS", "60");
    process.exitCode = undefined;
    mocks.processOutboxBatch.mockResolvedValue({
      claimed: 0,
      swept: 0,
      outcomes: [],
    } satisfies BatchResult);
    mocks.materializeDeliveryVariables.mockResolvedValue({});
    mocks.sendEmail.mockResolvedValue({ providerId: "console-provider-1" });
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

  it("runs the fenced state machine with a PostgreSQL store and stable process authority", async () => {
    await loadWorkerOnce();

    expect(mocks.PostgresOutboxStore).toHaveBeenCalledWith(mocks.pool);
    expect(mocks.processOutboxBatch).toHaveBeenCalledTimes(1);
    const dependencies = mocks.processOutboxBatch.mock.calls[0]![0] as {
      store: unknown;
      claimOwner: string;
      newClaimToken(): string;
      shouldStop(): boolean;
      provider: { adapter: string };
      policy: Record<string, number>;
    };
    expect(dependencies.store).toBe(mocks.store);
    expect(dependencies.claimOwner).toMatch(/^mail-worker:/);
    expect(dependencies.newClaimToken()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(dependencies.shouldStop()).toBe(false);
    expect(dependencies.provider.adapter).toBe("console");
    expect(dependencies.policy).toEqual({
      batchSize: 10,
      materializeLeaseMs: 60_000,
      providerLeaseMs: 300_000,
      maxMaterializeAttempts: 8,
      maxRetryDelayMs: 6 * 60 * 60_000,
      terminalPersistenceAttempts: 3,
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("materializes delivery-only variables and converts a provider receipt for the state machine", async () => {
    const materialized = {
      name: "Learner",
      url: "https://example.test/reset?token=delivery-only",
    };
    mocks.materializeDeliveryVariables.mockResolvedValue(materialized);
    mocks.sendEmail.mockResolvedValue({ providerId: "gmail-message-1" });
    let materializeResult: unknown;
    let providerResult: unknown;
    mocks.processOutboxBatch.mockImplementation(async (dependencies: {
      materialize(claim: unknown): Promise<unknown>;
      provider: {
        send(message: unknown, context: unknown): Promise<unknown>;
      };
    }) => {
      const claim = {
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
          template: "reset-password",
          templateVersion: "1",
          variables: { recoveryRequestId: "not-persisted-in-the-message" },
        },
      };
      materializeResult = await dependencies.materialize(claim);
      const message = (materializeResult as { message: unknown }).message;
      providerResult = await dependencies.provider.send(message, {
        operationId: claim.operationId,
        permit: { phase: "post-provider" },
      });
      return { claimed: 1, swept: 0, outcomes: [] };
    });

    await loadWorkerOnce();

    expect(mocks.materializeDeliveryVariables).toHaveBeenCalledWith({
      template: "reset-password",
      variables: { recoveryRequestId: "not-persisted-in-the-message" },
      now: expect.any(Date),
    });
    expect(materializeResult).toEqual({
      kind: "ready",
      message: {
        to: "learner@example.test",
        template: "reset-password",
        variables: materialized,
      },
    });
    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: "learner@example.test",
      template: "reset-password",
      variables: materialized,
    });
    expect(providerResult).toEqual({
      kind: "accepted",
      providerMessageId: "gmail-message-1",
    });
  });

  it("suppresses a row before provider delivery when delivery proof cannot be materialized", async () => {
    mocks.materializeDeliveryVariables.mockResolvedValue(null);
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
    expect(mocks.sendEmail).not.toHaveBeenCalled();
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

  it("preserves one-shot scheduling, health reporting, and pool cleanup", async () => {
    await loadWorkerOnce();

    expect(mocks.scheduleInactivityReminders).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleSmartReminders).toHaveBeenCalledTimes(1);
    expect(mocks.health.success).toHaveBeenCalledTimes(1);
    expect(mocks.health.retry).not.toHaveBeenCalled();
    expect(mocks.health.terminalFailure).not.toHaveBeenCalled();
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
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
