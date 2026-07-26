import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const poolEnd = vi.fn(async () => undefined);
  const pool = {
    connect: vi.fn(),
    end: poolEnd,
    query: vi.fn(),
  };
  const requireMailDispatchPostgresRuntime = vi.fn();
  const requireMailDeliveryAuthorityRuntime = vi.fn();
  const store = {
    claimNext: vi.fn(),
    finalizeGmailReconciliation: vi.fn(),
    findGmailReconciliationFence: vi.fn(),
    quarantineAbandoned: vi.fn(),
  };
  const PostgresOutboxStore = vi.fn(function PostgresOutboxStore() {
    return store;
  });
  const processOutboxBatch = vi.fn();
  const scheduleInactivityReminders = vi.fn();
  const scheduleSmartReminders = vi.fn();
  const prepareEmail = vi.fn();
  const sendPreparedEmail = vi.fn();
  const materializeDeliveryVariables = vi.fn();
  const health = {
    retry: vi.fn(),
    success: vi.fn(),
    terminalFailure: vi.fn(),
  };
  const createWorkerHealthReporter = vi.fn(() => health);

  return {
    pool,
    poolEnd,
    requireMailDispatchPostgresRuntime,
    requireMailDeliveryAuthorityRuntime,
    store,
    PostgresOutboxStore,
    processOutboxBatch,
    scheduleInactivityReminders,
    scheduleSmartReminders,
    prepareEmail,
    sendPreparedEmail,
    materializeDeliveryVariables,
    health,
    createWorkerHealthReporter,
  };
});

vi.mock("../src/lib/db/client", () => ({ pool: mocks.pool }));
vi.mock(
  "../src/lib/notifications/mail-dispatch-runtime-startup",
  () => ({
    requireMailDispatchPostgresRuntime:
      mocks.requireMailDispatchPostgresRuntime,
    requireMailDeliveryAuthorityRuntime:
      mocks.requireMailDeliveryAuthorityRuntime,
  }),
);
vi.mock("../src/lib/notifications/postgres-outbox-store", () => ({
  PostgresOutboxStore: mocks.PostgresOutboxStore,
}));
vi.mock("../src/lib/notifications/outbox-worker", () => ({
  processOutboxBatch: mocks.processOutboxBatch,
}));
vi.mock("../src/lib/notifications/inactivity", () => ({
  scheduleInactivityReminders: mocks.scheduleInactivityReminders,
}));
vi.mock("../src/lib/notifications/smart-reminders", () => ({
  scheduleSmartReminders: mocks.scheduleSmartReminders,
}));
vi.mock("../src/lib/notifications/mailer", () => ({
  classifyMailDeliveryError: vi.fn(() => ({
    kind: "ambiguous",
    code: "PROVIDER_OUTCOME_AMBIGUOUS",
  })),
  prepareEmail: mocks.prepareEmail,
  sendPreparedEmail: mocks.sendPreparedEmail,
}));
vi.mock("../src/lib/notifications/delivery-variables", () => ({
  materializeDeliveryVariables: mocks.materializeDeliveryVariables,
}));
vi.mock("../src/lib/notifications/provider-correlation", () => ({
  outboxMessageId: vi.fn(() => "<test@mail.codestead.invalid>"),
}));
vi.mock("../src/lib/notifications/template-authority-policy", () => ({
  resolveEmailTemplateAuthorityPolicy: vi.fn(() => null),
}));
vi.mock("./lib/worker-health", () => ({
  createWorkerHealthReporter: mocks.createWorkerHealthReporter,
}));

const originalArgv = [...process.argv];
const QUERY_LOG_CANARY =
  "private.person@recipient.example/550e8400-e29b-41d4-a716-446655440000";
const QUERY_CODE_CANARY =
  "ZXlKamJHRnBiVWxrSWpvaVkyOWhhVzB0YzJWamNtVjBJaXdpYzJOdmNHVWlPaUp0WVdsc0luMA";

type RuntimeVerdict = {
  readonly holdCatalogExact: boolean;
  readonly deliveryReleaseCapabilityExact: boolean;
};

function runtimeVerdict(
  holdCatalogExact: boolean,
  deliveryReleaseCapabilityExact: boolean,
): RuntimeVerdict {
  return {
    holdCatalogExact,
    deliveryReleaseCapabilityExact,
  };
}

let sigintListenersBeforeImport = 0;
let sigtermListenersBeforeImport = 0;

function expectNoSignalListenerLeaks() {
  expect(process.listenerCount("SIGINT")).toBe(sigintListenersBeforeImport);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListenersBeforeImport);
}

async function loadWorkerOnce() {
  process.argv = [originalArgv[0]!, originalArgv[1]!, "--once"];
  await import("./process-outbox");
  await vi.waitFor(() => expect(mocks.poolEnd).toHaveBeenCalledTimes(1));
}

function expectNoMailWorkStarted() {
  expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
  expect(mocks.scheduleInactivityReminders).not.toHaveBeenCalled();
  expect(mocks.scheduleSmartReminders).not.toHaveBeenCalled();
  expect(mocks.processOutboxBatch).not.toHaveBeenCalled();
  expect(mocks.store.claimNext).not.toHaveBeenCalled();
  expect(mocks.store.findGmailReconciliationFence).not.toHaveBeenCalled();
  expect(mocks.store.finalizeGmailReconciliation).not.toHaveBeenCalled();
  expect(mocks.store.quarantineAbandoned).not.toHaveBeenCalled();
  expect(mocks.materializeDeliveryVariables).not.toHaveBeenCalled();
  expect(mocks.prepareEmail).not.toHaveBeenCalled();
  expect(mocks.sendPreparedEmail).not.toHaveBeenCalled();
  expect(mocks.createWorkerHealthReporter).not.toHaveBeenCalled();
}

function workerFailureEntries() {
  return vi.mocked(console.error).mock.calls
    .map(([entry]) => String(entry))
    .filter((entry) => entry.includes('"event":"email.worker_failed"'));
}

function expectAuthorityUnavailableFailure() {
  expect(process.exitCode).toBe(1);
  expectNoMailWorkStarted();
  expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  expectNoSignalListenerLeaks();
  const entries = workerFailureEntries();
  expect(entries).toHaveLength(1);
  expect(JSON.parse(entries[0]!)).toEqual({
    event: "email.worker_failed",
    code: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
  });
}

describe("mail worker delivery-authority startup gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("MAIL_ADAPTER", "console");
    vi.stubEnv("OUTBOX_WORKER_MODE", "fenced-postgres-v1");
    vi.stubEnv("OUTBOX_POLL_SECONDS", "10");
    vi.stubEnv("INACTIVITY_SCHEDULE_SECONDS", "60");
    process.exitCode = undefined;
    mocks.requireMailDispatchPostgresRuntime.mockReset();
    mocks.requireMailDeliveryAuthorityRuntime.mockReset();
    mocks.requireMailDispatchPostgresRuntime.mockResolvedValue(
      { major: 17, versionNum: 170_000 },
    );
    mocks.requireMailDeliveryAuthorityRuntime.mockResolvedValue(
      runtimeVerdict(false, false),
    );
    sigintListenersBeforeImport = process.listenerCount("SIGINT");
    sigtermListenersBeforeImport = process.listenerCount("SIGTERM");
    mocks.processOutboxBatch.mockResolvedValue({
      claimed: 0,
      swept: 0,
      outcomes: [],
    });
    mocks.scheduleInactivityReminders.mockResolvedValue({ scheduled: 0 });
    mocks.scheduleSmartReminders.mockResolvedValue({ scheduled: 0 });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("preserves pre-0067 startup when neither the hold nor release capability exists", async () => {
    await loadWorkerOnce();

    expect(mocks.requireMailDispatchPostgresRuntime).toHaveBeenCalledOnce();
    expect(mocks.requireMailDispatchPostgresRuntime)
      .toHaveBeenCalledWith(mocks.pool);
    expect(mocks.requireMailDeliveryAuthorityRuntime).toHaveBeenCalledOnce();
    expect(mocks.requireMailDeliveryAuthorityRuntime)
      .toHaveBeenCalledWith(mocks.pool);
    expect(mocks.PostgresOutboxStore).toHaveBeenCalledOnce();
    expect(mocks.scheduleInactivityReminders).toHaveBeenCalledOnce();
    expect(mocks.scheduleSmartReminders).toHaveBeenCalledOnce();
    expect(mocks.processOutboxBatch).toHaveBeenCalledOnce();
    expect(mocks.createWorkerHealthReporter).toHaveBeenCalledOnce();
    expect(mocks.health.success).toHaveBeenCalledOnce();
    expect(workerFailureEntries()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
    expectNoSignalListenerLeaks();
  });

  it("permits an exact Task7 release capability without naming its future objects", async () => {
    mocks.requireMailDeliveryAuthorityRuntime.mockResolvedValueOnce(
      runtimeVerdict(true, true),
    );

    await loadWorkerOnce();

    expect(mocks.requireMailDispatchPostgresRuntime).toHaveBeenCalledOnce();
    expect(mocks.requireMailDeliveryAuthorityRuntime).toHaveBeenCalledOnce();
    expect(mocks.PostgresOutboxStore).toHaveBeenCalledOnce();
    expect(mocks.scheduleInactivityReminders).toHaveBeenCalledOnce();
    expect(mocks.scheduleSmartReminders).toHaveBeenCalledOnce();
    expect(mocks.processOutboxBatch).toHaveBeenCalledOnce();
    expect(mocks.createWorkerHealthReporter).toHaveBeenCalledOnce();
    expect(workerFailureEntries()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(mocks.poolEnd).toHaveBeenCalledOnce();
    expectNoSignalListenerLeaks();
  });

  it("denies exact 0067 hold without Task7 release before adapter initialization or mail work", async () => {
    vi.stubEnv("MAIL_ADAPTER", "must-not-be-read-before-authority-gate");
    mocks.requireMailDeliveryAuthorityRuntime.mockResolvedValueOnce(
      runtimeVerdict(true, false),
    );

    await loadWorkerOnce();

    expect(mocks.requireMailDispatchPostgresRuntime).toHaveBeenCalledOnce();
    expect(mocks.requireMailDispatchPostgresRuntime)
      .toHaveBeenCalledWith(mocks.pool);
    expect(mocks.requireMailDeliveryAuthorityRuntime).toHaveBeenCalledOnce();
    expect(mocks.requireMailDeliveryAuthorityRuntime).toHaveBeenCalledWith(mocks.pool);
    expectAuthorityUnavailableFailure();
  });

  it.each([
    ["missing verdict", { major: 17, versionNum: 170_000 }],
    [
      "non-boolean hold verdict",
      {
        holdCatalogExact: "true",
        deliveryReleaseCapabilityExact: false,
      },
    ],
    [
      "non-boolean release verdict",
      {
        holdCatalogExact: true,
        deliveryReleaseCapabilityExact: 0,
      },
    ],
    [
      "release without its 0067 hold",
      runtimeVerdict(false, true),
    ],
  ])(
    "normalizes malformed catalog state (%s) before mail work",
    async (_label, verdict) => {
      mocks.requireMailDeliveryAuthorityRuntime.mockResolvedValueOnce(
        verdict as RuntimeVerdict,
      );

      await loadWorkerOnce();

      expect(mocks.requireMailDispatchPostgresRuntime).toHaveBeenCalledOnce();
      expect(mocks.requireMailDeliveryAuthorityRuntime).toHaveBeenCalledOnce();
      expectAuthorityUnavailableFailure();
    },
  );

  it("normalizes catalog query failures without logging query data or starting mail work", async () => {
    const queryFailure = Object.assign(
      new Error(`catalog query failed for ${QUERY_LOG_CANARY}`),
      {
        name: QUERY_CODE_CANARY,
        code: QUERY_CODE_CANARY,
        cause: new Error(`catalog cause ${QUERY_LOG_CANARY}`),
      },
    );
    mocks.requireMailDeliveryAuthorityRuntime
      .mockRejectedValueOnce(queryFailure);

    await loadWorkerOnce();

    expect(mocks.requireMailDispatchPostgresRuntime).toHaveBeenCalledOnce();
    expectAuthorityUnavailableFailure();
    const allErrorOutput = vi.mocked(console.error).mock.calls
      .flat()
      .map(String)
      .join("\n");
    const allInfoOutput = vi.mocked(console.info).mock.calls
      .flat()
      .map(String)
      .join("\n");
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.info).not.toHaveBeenCalled();
    expect(allErrorOutput).not.toContain(QUERY_LOG_CANARY);
    expect(allErrorOutput).not.toContain(QUERY_CODE_CANARY);
    expect(allInfoOutput).not.toContain(QUERY_LOG_CANARY);
    expect(allInfoOutput).not.toContain(QUERY_CODE_CANARY);
  });
});
