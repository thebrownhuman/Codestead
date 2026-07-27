import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const poolEnd = vi.fn(async () => {
    calls.push("pool.end");
  });
  const pool = Object.freeze({
    connect: vi.fn(),
    end: poolEnd,
    query: vi.fn(),
  });
  const database = Object.freeze({ kind: "mail-dispatch-database" });
  const resources = Object.freeze({ pool, database });
  const createMailDispatchBootstrapResources = vi.fn(() => {
    calls.push("resources.create");
    return resources;
  });
  const inspection = Object.freeze({
    plan: Object.freeze({
      timeouts: Object.freeze({
        drainMs: 100_000,
        poolCloseMs: 5_000,
        shutdownMarginMs: 5_000,
        stopMs: 120_000,
        platformStopMs: 135_000,
      }),
    }),
    postgresMajor: 17,
  });
  const inspectMailDispatchRuntime = vi.fn(async () => {
    calls.push("runtime.inspect");
    return inspection;
  });
  const applicationOrigin = Object.freeze({});
  const captureMailDispatchApplicationOrigin = vi.fn(() => {
    calls.push("origin.capture");
    return applicationOrigin;
  });
  const mailDispatchApplicationUrl = vi.fn(() => {
    calls.push("origin.read");
    return "https://learn.test";
  });
  const store = Object.freeze({ kind: "postgres-outbox-store" });
  const PostgresOutboxStore = vi.fn(function StoreConstructor() {
    calls.push("store.create");
    return store;
  });
  const preparedRuntimePlan = Object.freeze({
    timeouts: Object.freeze({
      oauthDeadlineMs: 20_000,
      guardedSendDeadlineMs: 20_000,
      providerAbortSettlementMs: 5_000,
    }),
  });
  const mailDispatchPreparedRuntimePlan = vi.fn(() => {
    calls.push("store.runtime-plan");
    return preparedRuntimePlan;
  });
  const guarded = Object.freeze({ kind: "guarded-prepared-dispatch" });
  const authorizeCommittedPreparedDispatch = vi.fn(async () => guarded);
  const discardCommittedPreparedDispatchReceipt = vi.fn(() => true);
  const discardGuardedPreparedDispatch = vi.fn(() => true);

  const transportConfiguration = Object.freeze({});
  const captureMailTransportConfiguration = vi.fn(() => {
    calls.push("transport.capture");
    return transportConfiguration;
  });
  const materializedDispatch = Object.freeze({ kind: "materialized-dispatch" });
  const createMaterializedDispatch = vi.fn(() => materializedDispatch);
  const materializeDeliveryWithAuthorityEvidence = vi.fn();
  const materializeDeliveryVariables = vi.fn(async () => ({}));

  const watchdog = Object.freeze({
    arm: vi.fn(),
    close: vi.fn(async () => {
      calls.push("watchdog.close");
    }),
  });
  const startMailDispatchHardWatchdog = vi.fn(async () => {
    calls.push("watchdog.start");
    return watchdog;
  });

  const processOutboxBatch = vi.fn();
  const scheduleInactivityReminders = vi.fn(async () => {
    calls.push("scheduler.inactivity");
    return { scheduled: 0 };
  });
  const scheduleSmartRemindersWithDatabase = vi.fn(async () => {
    calls.push("scheduler.smart");
    return { candidates: 0, dispatched: 0, failed: 0 };
  });
  const scheduleSmartReminders = vi.fn(async () => ({ scheduled: 0 }));
  const resolvedPolicy: { template: string } | null = { template: "new-device" };
  const policyState: { value: { template: string } | null } = {
    value: resolvedPolicy,
  };
  const resolveEmailTemplateAuthorityPolicy = vi.fn(() => policyState.value);
  const outboxMessageId = vi.fn((operationId: string) =>
    `<${operationId}@mail.codestead.invalid>`
  );

  const health = {
    success: vi.fn(),
    retry: vi.fn(),
    terminalFailure: vi.fn(),
  };
  const createWorkerHealthReporter = vi.fn(() => {
    calls.push("health.create");
    return health;
  });

  const requireMailDispatchPostgresRuntime = vi.fn(async () => ({
    major: 17,
    versionNum: 170_000,
  }));
  const requireMailDeliveryAuthorityRuntime = vi.fn(async () => ({
    holdCatalogExact: true,
    deliveryReleaseCapabilityExact: true,
  }));
  const legacyPrepareEmail = vi.fn(() => ({}));
  const legacySendPreparedEmail = vi.fn(async () => ({ providerId: "legacy" }));
  const legacyClassifyMailDeliveryError = vi.fn(() => ({
    kind: "ambiguous",
    code: "PROVIDER_OUTCOME_AMBIGUOUS",
  }));

  return {
    calls,
    pool,
    poolEnd,
    database,
    resources,
    createMailDispatchBootstrapResources,
    inspection,
    inspectMailDispatchRuntime,
    applicationOrigin,
    captureMailDispatchApplicationOrigin,
    mailDispatchApplicationUrl,
    store,
    PostgresOutboxStore,
    preparedRuntimePlan,
    mailDispatchPreparedRuntimePlan,
    authorizeCommittedPreparedDispatch,
    discardCommittedPreparedDispatchReceipt,
    discardGuardedPreparedDispatch,
    guarded,
    transportConfiguration,
    captureMailTransportConfiguration,
    materializedDispatch,
    createMaterializedDispatch,
    materializeDeliveryWithAuthorityEvidence,
    materializeDeliveryVariables,
    watchdog,
    startMailDispatchHardWatchdog,
    processOutboxBatch,
    scheduleInactivityReminders,
    scheduleSmartRemindersWithDatabase,
    scheduleSmartReminders,
    policyState,
    resolveEmailTemplateAuthorityPolicy,
    outboxMessageId,
    health,
    createWorkerHealthReporter,
    requireMailDispatchPostgresRuntime,
    requireMailDeliveryAuthorityRuntime,
    legacyPrepareEmail,
    legacySendPreparedEmail,
    legacyClassifyMailDeliveryError,
  };
});

vi.mock("../src/lib/notifications/mail-dispatch-pool", () => ({
  createMailDispatchBootstrapResources:
    mocks.createMailDispatchBootstrapResources,
}));
vi.mock("../src/lib/notifications/mail-dispatch-runtime-startup", () => ({
  inspectMailDispatchRuntime: mocks.inspectMailDispatchRuntime,
  requireMailDispatchPostgresRuntime: mocks.requireMailDispatchPostgresRuntime,
  requireMailDeliveryAuthorityRuntime: mocks.requireMailDeliveryAuthorityRuntime,
}));
vi.mock("../src/lib/notifications/postgres-outbox-store", () => ({
  PostgresOutboxStore: mocks.PostgresOutboxStore,
  captureMailDispatchApplicationOrigin:
    mocks.captureMailDispatchApplicationOrigin,
  mailDispatchApplicationUrl: mocks.mailDispatchApplicationUrl,
  mailDispatchPreparedRuntimePlan: mocks.mailDispatchPreparedRuntimePlan,
  authorizeCommittedPreparedDispatch:
    mocks.authorizeCommittedPreparedDispatch,
  discardCommittedPreparedDispatchReceipt:
    mocks.discardCommittedPreparedDispatchReceipt,
  discardGuardedPreparedDispatch: mocks.discardGuardedPreparedDispatch,
}));
vi.mock("../src/lib/notifications/guarded-prepared-dispatch", () => ({
  createMaterializedDispatch: mocks.createMaterializedDispatch,
}));
vi.mock("../src/lib/notifications/mailer-transport-internal", () => ({
  captureMailTransportConfiguration:
    mocks.captureMailTransportConfiguration,
}));
vi.mock("../src/lib/notifications/mail-dispatch-hard-watchdog", () => ({
  startMailDispatchHardWatchdog: mocks.startMailDispatchHardWatchdog,
}));
vi.mock("../src/lib/notifications/delivery-variables", () => ({
  materializeDeliveryWithAuthorityEvidence:
    mocks.materializeDeliveryWithAuthorityEvidence,
  materializeDeliveryVariables: mocks.materializeDeliveryVariables,
}));
vi.mock("../src/lib/notifications/outbox-worker", () => ({
  processOutboxBatch: mocks.processOutboxBatch,
}));
vi.mock("../src/lib/notifications/inactivity", () => ({
  scheduleInactivityReminders: mocks.scheduleInactivityReminders,
}));
vi.mock("../src/lib/notifications/smart-reminders", () => ({
  scheduleSmartRemindersWithDatabase:
    mocks.scheduleSmartRemindersWithDatabase,
  scheduleSmartReminders: mocks.scheduleSmartReminders,
}));
vi.mock("../src/lib/notifications/template-authority-policy", () => ({
  resolveEmailTemplateAuthorityPolicy:
    mocks.resolveEmailTemplateAuthorityPolicy,
}));
vi.mock("../src/lib/notifications/provider-correlation", () => ({
  outboxMessageId: mocks.outboxMessageId,
}));
vi.mock("./lib/worker-health", () => ({
  createWorkerHealthReporter: mocks.createWorkerHealthReporter,
}));

// These compatibility mocks keep the pre-fix process importable so the new
// behavioral assertions fail on composition rather than unrelated I/O.
vi.mock("../src/lib/db/client", () => ({ pool: mocks.pool }));
vi.mock("../src/lib/notifications/mailer", () => ({
  prepareEmail: mocks.legacyPrepareEmail,
  sendPreparedEmail: mocks.legacySendPreparedEmail,
  classifyMailDeliveryError: mocks.legacyClassifyMailDeliveryError,
}));

const originalArgv = [...process.argv];
const RECIPIENT_CANARY = "private.person@recipient.example";
const TOKEN_CANARY =
  "ZXlKamJHRnBiVWxrSWpvaVkyOWhhVzB0YzJWamNtVjBJaXdpYzJOdmNHVWlPaUp0WVdsc0luMA";

type WorkerDependencies = Readonly<{
  store: unknown;
  adapter: string;
  watchdog: unknown;
  authorize(receipt: unknown): Promise<unknown>;
  discardReceipt(permit: unknown, receipt: unknown): boolean;
  discardGuard(permit: unknown, guard: unknown): boolean;
  materialize(claim: unknown): Promise<unknown>;
  shouldStop(): boolean;
  policy: Readonly<Record<string, number>>;
}>;

type BatchResult = Readonly<{
  claimed: number;
  swept: number;
  outcomes: readonly Readonly<{
    kind: string;
    code?: string;
    [key: string]: unknown;
  }>[];
}>;

function batchResult(overrides: Partial<BatchResult> = {}): BatchResult {
  return {
    claimed: 0,
    swept: 0,
    outcomes: [],
    ...overrides,
  };
}

async function flushWorkerMicrotasks() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function loadWorkerOnce() {
  process.argv = [originalArgv[0]!, originalArgv[1]!, "--once"];
  await import("./process-outbox");
  await vi.waitFor(() => expect(mocks.poolEnd).toHaveBeenCalledTimes(1));
}

function capturedDependencies(): WorkerDependencies {
  const dependencies = mocks.processOutboxBatch.mock.calls[0]?.[0];
  expect(dependencies).toBeDefined();
  return dependencies as WorkerDependencies;
}

function callPosition(event: string) {
  const position = mocks.calls.indexOf(event);
  expect(position, `missing call marker ${event}`).toBeGreaterThanOrEqual(0);
  return position;
}

describe("mail worker production composition", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.policyState.value = { template: "new-device" };
    mocks.inspectMailDispatchRuntime.mockImplementation(async () => {
      mocks.calls.push("runtime.inspect");
      return mocks.inspection;
    });
    mocks.mailDispatchApplicationUrl.mockImplementation(() => {
      mocks.calls.push("origin.read");
      return "https://learn.test";
    });
    mocks.materializeDeliveryWithAuthorityEvidence.mockResolvedValue(
      Object.freeze({
        authorityEvidence: null,
        variables: Object.freeze({ name: "Learner" }),
      }),
    );
    mocks.processOutboxBatch.mockResolvedValue(batchResult());
    vi.stubEnv("APP_URL", "https://learn.test");
    vi.stubEnv("MAIL_ADAPTER", "console");
    vi.stubEnv("MAIL_FROM", "Codestead <mail@learn.test>");
    vi.stubEnv("OUTBOX_WORKER_MODE", "fenced-postgres-v1");
    vi.stubEnv("OUTBOX_POLL_SECONDS", "10");
    vi.stubEnv("INACTIVITY_SCHEDULE_SECONDS", "60");
    process.exitCode = undefined;
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

  it("uses one opaque-inspected pool for store, schedulers, worker, and cleanup", async () => {
    await loadWorkerOnce();

    expect(mocks.createMailDispatchBootstrapResources).toHaveBeenCalledOnce();
    expect(mocks.inspectMailDispatchRuntime).toHaveBeenCalledWith(mocks.pool);
    expect(mocks.captureMailDispatchApplicationOrigin)
      .toHaveBeenCalledWith(mocks.inspection);
    expect(mocks.mailDispatchApplicationUrl)
      .toHaveBeenCalledWith(mocks.applicationOrigin);
    expect(mocks.PostgresOutboxStore).toHaveBeenCalledWith(
      mocks.pool,
      mocks.inspection,
      mocks.applicationOrigin,
    );
    expect(mocks.mailDispatchPreparedRuntimePlan)
      .toHaveBeenCalledWith(mocks.store);
    expect(mocks.captureMailTransportConfiguration)
      .toHaveBeenCalledWith("console");
    expect(mocks.startMailDispatchHardWatchdog).toHaveBeenCalledOnce();
    expect(mocks.scheduleInactivityReminders).toHaveBeenCalledWith(
      expect.any(Date),
      mocks.pool,
    );
    expect(mocks.scheduleSmartRemindersWithDatabase).toHaveBeenCalledWith(
      mocks.database,
      expect.any(Date),
    );
    expect(mocks.scheduleSmartReminders).not.toHaveBeenCalled();

    const dependencies = capturedDependencies();
    expect(dependencies.store).toBe(mocks.store);
    expect(dependencies.watchdog).toBe(mocks.watchdog);
    expect(dependencies.adapter).toBe("console");
    expect(dependencies).not.toHaveProperty("provider");
    expect(dependencies.policy).not.toHaveProperty("providerLeaseMs");

    const receipt = Object.freeze({});
    const permit = Object.freeze({});
    await expect(dependencies.authorize(receipt)).resolves.toBe(mocks.guarded);
    expect(mocks.authorizeCommittedPreparedDispatch)
      .toHaveBeenCalledWith(mocks.store, receipt);
    expect(dependencies.discardReceipt(permit, receipt)).toBe(true);
    expect(mocks.discardCommittedPreparedDispatchReceipt)
      .toHaveBeenCalledWith(mocks.store, permit, receipt);
    expect(dependencies.discardGuard(permit, mocks.guarded)).toBe(true);
    expect(mocks.discardGuardedPreparedDispatch)
      .toHaveBeenCalledWith(mocks.store, permit, mocks.guarded);

    expect(callPosition("resources.create")).toBeLessThan(
      callPosition("runtime.inspect"),
    );
    expect(callPosition("runtime.inspect")).toBeLessThan(
      callPosition("origin.capture"),
    );
    expect(callPosition("runtime.inspect")).toBeLessThan(
      callPosition("transport.capture"),
    );
    expect(callPosition("store.create")).toBeLessThan(
      callPosition("watchdog.start"),
    );
    expect(callPosition("watchdog.close")).toBeLessThan(
      callPosition("pool.end"),
    );
  });

  it("materializes exact bytes from captured configuration and stored authority", async () => {
    await loadWorkerOnce();
    const authorityEvidence = Object.freeze({
      kind: "lost-device-proof",
      sourceId: "10000000-0000-4000-8000-000000000001",
      proofHash: "a".repeat(64),
    });
    const deliveryVariables = Object.freeze({
      name: "Learner",
      url: "https://learn.test/lost-device#proof=ephemeral",
    });
    mocks.policyState.value = { template: "lost-device-proof" };
    mocks.materializeDeliveryWithAuthorityEvidence.mockResolvedValueOnce(
      Object.freeze({ authorityEvidence, variables: deliveryVariables }),
    );
    vi.stubEnv("APP_URL", "https://changed-after-startup.invalid");

    const claim = Object.freeze({
      phase: "pre-provider",
      id: "10000000-0000-4000-8000-000000000010",
      operationId: "10000000-0000-4000-8000-000000000011",
      claimToken: "10000000-0000-4000-8000-000000000012",
      claimOwner: "mail-worker:test",
      claimVersion: 3,
      deliveryScopeKey: "a:10000000-0000-4000-8000-000000000013",
      userId: "10000000-0000-4000-8000-000000000013",
      attempt: 1,
      leaseExpiresAt: new Date("2026-07-27T12:00:00.000Z"),
      payload: Object.freeze({
        userId: "10000000-0000-4000-8000-000000000013",
        to: "learner@example.test",
        template: "lost-device-proof",
        templateVersion: "1",
        variables: Object.freeze({
          name: "Learner",
          recoveryRequestId: "10000000-0000-4000-8000-000000000001",
        }),
      }),
    });

    await expect(capturedDependencies().materialize(claim)).resolves.toEqual({
      kind: "ready",
      materialized: mocks.materializedDispatch,
    });
    expect(mocks.materializeDeliveryWithAuthorityEvidence).toHaveBeenCalledWith({
      applicationUrl: "https://learn.test",
      template: "lost-device-proof",
      templateVersion: "1",
      variables: { ...claim.payload.variables },
      now: expect.any(Date),
    });
    expect(mocks.createMaterializedDispatch).toHaveBeenCalledWith({
      source: {
        applicationUrl: "https://learn.test",
        outboxId: claim.id,
        operationId: claim.operationId,
        claimToken: claim.claimToken,
        claimOwner: claim.claimOwner,
        claimVersion: claim.claimVersion,
        deliveryScopeKey: claim.deliveryScopeKey,
        recipient: claim.payload.to,
        template: "lost-device-proof",
        templateVersion: "1",
        variables: { ...claim.payload.variables },
      },
      adapter: "console",
      from: "Codestead <mail@learn.test>",
      messageId: `<${claim.operationId}@mail.codestead.invalid>`,
      runtimePlan: mocks.preparedRuntimePlan,
      transportConfiguration: mocks.transportConfiguration,
      delivery: {
        authorityEvidence,
        variables: deliveryVariables,
      },
    });
  });

  it("fails closed at inspection before configuration capture or mail work", async () => {
    mocks.inspectMailDispatchRuntime.mockRejectedValueOnce(
      new Error(`database failed ${RECIPIENT_CANARY}/${TOKEN_CANARY}`),
    );

    await loadWorkerOnce();

    expect(process.exitCode).toBe(1);
    expect(mocks.captureMailDispatchApplicationOrigin).not.toHaveBeenCalled();
    expect(mocks.captureMailTransportConfiguration).not.toHaveBeenCalled();
    expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
    expect(mocks.startMailDispatchHardWatchdog).not.toHaveBeenCalled();
    expect(mocks.scheduleInactivityReminders).not.toHaveBeenCalled();
    expect(mocks.scheduleSmartRemindersWithDatabase).not.toHaveBeenCalled();
    expect(mocks.processOutboxBatch).not.toHaveBeenCalled();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
    const output = vi.mocked(console.error).mock.calls.flat().map(String).join("\n");
    expect(output).toContain('"event":"email.worker_failed"');
    expect(output).not.toContain(RECIPIENT_CANARY);
    expect(output).not.toContain(TOKEN_CANARY);
  });

  it("rejects invalid worker mode before creating any resource", async () => {
    vi.stubEnv("OUTBOX_WORKER_MODE", "legacy-direct-v1");
    process.argv = [originalArgv[0]!, originalArgv[1]!, "--once"];

    await import("./process-outbox");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());

    expect(process.exitCode).toBe(1);
    expect(mocks.createMailDispatchBootstrapResources).not.toHaveBeenCalled();
    expect(mocks.inspectMailDispatchRuntime).not.toHaveBeenCalled();
    expect(mocks.poolEnd).not.toHaveBeenCalled();
  });

  it("drains an in-flight batch before watchdog and pool shutdown", async () => {
    process.argv = [originalArgv[0]!, originalArgv[1]!];
    const listenersBefore = process.listeners("SIGTERM");
    let finishBatch: ((result: BatchResult) => void) | undefined;
    const inFlight = new Promise<BatchResult>((resolve) => {
      finishBatch = resolve;
    });
    mocks.processOutboxBatch.mockImplementationOnce(async () => inFlight);

    await import("./process-outbox");
    await flushWorkerMicrotasks();
    const signalHandler = process.listeners("SIGTERM")
      .find((listener) => !listenersBefore.includes(listener));
    expect(signalHandler).toBeTypeOf("function");
    expect(capturedDependencies().shouldStop()).toBe(false);

    signalHandler!("SIGTERM");
    expect(capturedDependencies().shouldStop()).toBe(true);
    expect(mocks.watchdog.close).not.toHaveBeenCalled();
    expect(mocks.poolEnd).not.toHaveBeenCalled();

    finishBatch?.(batchResult({ claimed: 1 }));
    await vi.waitFor(() => expect(mocks.poolEnd).toHaveBeenCalledOnce());

    expect(mocks.processOutboxBatch).toHaveBeenCalledOnce();
    expect(mocks.watchdog.close).toHaveBeenCalledOnce();
    expect(callPosition("watchdog.close")).toBeLessThan(
      callPosition("pool.end"),
    );
  });

  it("bounds a never-settling batch by drain and application-stop deadlines", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as unknown as typeof process.exit,
    );
    process.argv = [originalArgv[0]!, originalArgv[1]!];
    const rawListenersBefore = process.rawListeners("SIGTERM");
    let finishBatch: ((result: BatchResult) => void) | undefined;
    const inFlight = new Promise<BatchResult>((resolve) => {
      finishBatch = resolve;
    });
    mocks.processOutboxBatch.mockImplementationOnce(async () => inFlight);

    await import("./process-outbox");
    await flushWorkerMicrotasks();
    const signalHandler = process.rawListeners("SIGTERM")
      .find((listener) => !rawListenersBefore.includes(listener));
    expect(signalHandler).toBeTypeOf("function");

    try {
      signalHandler!.call(process, "SIGTERM");
      expect(capturedDependencies().shouldStop()).toBe(true);
      expect(process.rawListeners("SIGTERM")).toContain(signalHandler);

      await vi.advanceTimersByTimeAsync(
        mocks.inspection.plan.timeouts.drainMs - 1,
      );
      expect(mocks.watchdog.close).not.toHaveBeenCalled();
      expect(mocks.poolEnd).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();

      signalHandler!.call(process, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1);
      await flushWorkerMicrotasks();
      expect(mocks.watchdog.close).toHaveBeenCalledOnce();
      expect(mocks.poolEnd).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(
        mocks.inspection.plan.timeouts.stopMs
          - mocks.inspection.plan.timeouts.drainMs
          - 1,
      );
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await flushWorkerMicrotasks();
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
      const output = vi.mocked(console.error).mock.calls
        .flat()
        .map(String)
        .join("\n");
      expect(output).toContain('"event":"email.worker_stop_timeout"');
      expect(output).toContain('"code":"APPLICATION_STOP_TIMEOUT"');
      expect(output).not.toContain(RECIPIENT_CANARY);
      expect(output).not.toContain(TOKEN_CANARY);
    } finally {
      finishBatch?.(batchResult());
      await flushWorkerMicrotasks();
    }
  });
  it("keeps a drain timeout fatal when the batch settles before application stop", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as unknown as typeof process.exit,
    );
    process.argv = [originalArgv[0]!, originalArgv[1]!];
    const listenersBefore = process.listeners("SIGTERM");
    let finishBatch: ((result: BatchResult) => void) | undefined;
    const inFlight = new Promise<BatchResult>((resolve) => {
      finishBatch = resolve;
    });
    mocks.processOutboxBatch.mockImplementationOnce(async () => inFlight);

    await import("./process-outbox");
    await flushWorkerMicrotasks();
    const signalHandler = process.listeners("SIGTERM")
      .find((listener) => !listenersBefore.includes(listener));
    expect(signalHandler).toBeTypeOf("function");

    signalHandler!("SIGTERM");
    await vi.advanceTimersByTimeAsync(
      mocks.inspection.plan.timeouts.drainMs,
    );
    await flushWorkerMicrotasks();

    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({
      event: "email.worker_drain_timeout",
      code: "APPLICATION_DRAIN_TIMEOUT",
    }));
    expect(mocks.watchdog.close).toHaveBeenCalledOnce();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    finishBatch?.(batchResult());
    await flushWorkerMicrotasks();
    await vi.advanceTimersByTimeAsync(
      mocks.inspection.plan.timeouts.stopMs
        - mocks.inspection.plan.timeouts.drainMs
        - 1,
    );
    await flushWorkerMicrotasks();

    expect(process.exitCode).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    const output = vi.mocked(console.error).mock.calls
      .flat()
      .map(String)
      .join("\n");
    expect(output.match(/APPLICATION_DRAIN_TIMEOUT/g)).toHaveLength(1);
    expect(output).not.toContain(RECIPIENT_CANARY);
    expect(output).not.toContain(TOKEN_CANARY);
  });
  it("logs only aggregate outcomes and never row or payload identifiers", async () => {
    mocks.processOutboxBatch.mockResolvedValueOnce(batchResult({
      claimed: 7,
      swept: 2,
      outcomes: [
        { kind: "sent", recipient: RECIPIENT_CANARY },
        { kind: "retry", token: TOKEN_CANARY },
        { kind: "failed" },
        { kind: "suppressed" },
        { kind: "quarantined" },
        { kind: "claim-lost" },
        { kind: "persistence-unknown" },
      ],
    }));

    await loadWorkerOnce();

    const entries = vi.mocked(console.info).mock.calls
      .map(([entry]) => String(entry));
    const batchEntry = entries.find((entry) =>
      entry.includes('"event":"email.outbox_batch"')
    );
    expect(JSON.parse(batchEntry!)).toEqual({
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
    expect(entries.join("\n")).not.toContain(RECIPIENT_CANARY);
    expect(entries.join("\n")).not.toContain(TOKEN_CANARY);
  });

  it("bounds pool shutdown with the inspected runtime plan", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as unknown as typeof process.exit,
    );
    mocks.poolEnd.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    process.argv = [originalArgv[0]!, originalArgv[1]!, "--once"];

    await import("./process-outbox");
    await flushWorkerMicrotasks();
    expect(mocks.watchdog.close).toHaveBeenCalledOnce();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(4_999);
    await flushWorkerMicrotasks();
    expect(process.exitCode).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await flushWorkerMicrotasks();
    expect(process.exitCode).toBe(1);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({
      event: "email.worker_cleanup_failed",
      code: "POOL_SHUTDOWN_TIMEOUT",
    }));
  });

  it("contains no legacy direct-send or application-global pool import", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts", "process-outbox.ts"),
      "utf8",
    );
    expect(source).not.toContain("../src/lib/db/client");
    expect(source).not.toContain('from "../src/lib/notifications/mailer";');
    expect(source).not.toContain("prepareEmail");
    expect(source).not.toContain("sendPreparedEmail");
    expect(source).not.toContain("createStoreBoundPreparedDispatchChannel");
    expect(source).not.toContain("createMailDispatchDatabaseResources");
  });
});
