import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const VALID_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const UUID_LOG_CANARY = "0f4f18c1-2fb5-45ec-9fb4-f8a856922a12";
const BASE64URL_LOG_CANARY = "ZXlKdmNHVnlZWFJwYjI1SlpDSTZJakJtTkdZeE9HTXhMVEptWWpVdE5EVmxZeTA1Wm1JMExXWTRZVGcxTmpreU1tRXhNaUo5";
const RECIPIENT_LOG_CANARY = "reconcile-private@recipient.example";
const RAW_MIME_LOG_CANARY =
  "TWVzc2FnZS1JRDogPHByaXZhdGVAZXhhbXBsZS50ZXN0Pg0KVG86IHJlY29uY2lsZS1wcml2YXRlQHJlY2lwaWVudC5leGFtcGxl";


const mocks = vi.hoisted(() => {
  const pool = {
    options: {
      max: 3,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
    },
    connect: vi.fn(),
    end: vi.fn(async () => undefined),
  };
  const database = { kind: "dedicated-mail-database" };
  const inspection = { kind: "live-mail-startup-inspection" };
  const createMailDispatchDatabaseResources = vi.fn(async () => ({
    pool,
    database,
    inspection,
  }));
  const store = { kind: "gmail-reconciliation-store" };
  const PostgresOutboxStore = vi.fn(function PostgresOutboxStore() {
    return store;
  });
  const findGmailMessageByMessageId = vi.fn();
  const reconcileGmailDelivery = vi.fn(async () => ({ kind: "applied" }));
  return {
    pool,
    database,
    inspection,
    createMailDispatchDatabaseResources,
    store,
    PostgresOutboxStore,
    findGmailMessageByMessageId,
    reconcileGmailDelivery,
  };
});

vi.mock("../src/lib/db/client", () => {
  throw new Error("Gmail reconciler imported the application database client.");
});
vi.mock("../src/lib/notifications/mail-dispatch-pool", () => ({
  createMailDispatchDatabaseResources:
    mocks.createMailDispatchDatabaseResources,
}));
vi.mock("../src/lib/notifications/postgres-outbox-store", () => ({
  PostgresOutboxStore: mocks.PostgresOutboxStore,
}));
vi.mock("../src/lib/notifications/gmail-correlation-lookup", () => ({
  findGmailMessageByMessageId: mocks.findGmailMessageByMessageId,
}));
vi.mock("../src/lib/notifications/gmail-reconciliation", () => ({
  reconcileGmailDelivery: mocks.reconcileGmailDelivery,
}));

const originalArgv = [...process.argv];

describe("Gmail reconciliation operator command", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.assign(mocks.pool.options, {
      max: 3,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
    });
    vi.stubEnv("MAIL_ADAPTER", "gmail");
    vi.stubEnv("GMAIL_RECONCILIATION_ENABLED", "true");
    vi.stubEnv("GMAIL_OAUTH_SCOPES", `${SEND_SCOPE} ${VALID_READ_SCOPE}`);
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
  it.each([
    { label: "missing", scopes: "" },
    { label: "send-only", scopes: SEND_SCOPE },
    { label: "metadata-only", scopes: METADATA_SCOPE },
    { label: "unrecognized", scopes: "not-a-scope-secret-marker" },
  ])(
    "fails closed before database or Gmail access for a $label scope declaration",
    async ({ scopes }) => {
      vi.stubEnv("GMAIL_OAUTH_SCOPES", scopes);
      process.argv = [
        originalArgv[0]!,
        originalArgv[1]!,
        "--operation-id",
        OPERATION_ID,
      ];

      await import("./reconcile-gmail-outbox");
      await vi.waitFor(() => expect(console.error).toHaveBeenCalled());

      expect(mocks.createMailDispatchDatabaseResources).not.toHaveBeenCalled();
      expect(mocks.pool.end).not.toHaveBeenCalled();
      expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
      expect(mocks.reconcileGmailDelivery).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      const logs = vi.mocked(console.error).mock.calls.map(([entry]) => String(entry));
      expect(logs).toEqual([
        JSON.stringify({
          event: "email.gmail_reconciliation_failed",
          code: "GMAIL_RECONCILIATION_OAUTH_SCOPE_INVALID",
        }),
      ]);
      if (scopes) expect(logs.join(" ")).not.toContain(scopes);
    },
  );

  it("fails closed when dedicated resource startup rejects pool authority", async () => {
    const failure = Object.assign(
      new Error("private startup detail"),
      { code: "GMAIL_RECONCILIATION_POOL_INVALID" },
    );
    mocks.createMailDispatchDatabaseResources.mockImplementationOnce(
      async () => {
        await mocks.pool.end();
        throw failure;
      },
    );
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
    ];

    await import("./reconcile-gmail-outbox");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());

    expect(mocks.createMailDispatchDatabaseResources).toHaveBeenCalledWith();
    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
    expect(mocks.reconcileGmailDelivery).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.map(([entry]) => String(entry))).toEqual([
      JSON.stringify({
        event: "email.gmail_reconciliation_failed",
        code: "GMAIL_RECONCILIATION_POOL_INVALID",
      }),
    ]);
  });

  it("never logs UUID, base64url, provider, recipient, or MIME fields from a failure", async () => {
    const failure = Object.assign(new Error(
      `recipient=${RECIPIENT_LOG_CANARY}; raw=${RAW_MIME_LOG_CANARY}`,
      { cause: { claimId: UUID_LOG_CANARY } },
    ), {
      name: UUID_LOG_CANARY,
      code: BASE64URL_LOG_CANARY,
      stack: `provider=${BASE64URL_LOG_CANARY}; operation=${UUID_LOG_CANARY}`,
    });
    mocks.reconcileGmailDelivery.mockRejectedValueOnce(failure);
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
    ];

    await import("./reconcile-gmail-outbox");
    await vi.waitFor(() => expect(mocks.pool.end).toHaveBeenCalledOnce());

    const logs = vi.mocked(console.error).mock.calls.map(([entry]) => String(entry));
    expect(logs).toEqual([
      JSON.stringify({
        event: "email.gmail_reconciliation_failed",
        code: "GMAIL_RECONCILIATION_FAILED",
      }),
    ]);
    for (const canary of [
      UUID_LOG_CANARY,
      BASE64URL_LOG_CANARY,
      RECIPIENT_LOG_CANARY,
      RAW_MIME_LOG_CANARY,
    ]) {
      expect(logs.join("\n")).not.toContain(canary);
    }
  });

  it("contains pool-close failures without serializing their error fields", async () => {
    const failure = Object.assign(new Error(
      `recipient=${RECIPIENT_LOG_CANARY}; raw=${RAW_MIME_LOG_CANARY}`,
      { cause: { scopeId: UUID_LOG_CANARY } },
    ), {
      name: UUID_LOG_CANARY,
      code: BASE64URL_LOG_CANARY,
      stack: `provider=${BASE64URL_LOG_CANARY}; claim=${UUID_LOG_CANARY}`,
    });
    mocks.pool.end.mockRejectedValueOnce(failure);
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
    ];

    await import("./reconcile-gmail-outbox");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "email.gmail_reconciliation_cleanup_failed",
        code: "GMAIL_RECONCILIATION_POOL_CLOSE_FAILED",
      }),
    ));

    const logs = vi.mocked(console.error).mock.calls.map(([entry]) => String(entry));
    for (const canary of [
      UUID_LOG_CANARY,
      BASE64URL_LOG_CANARY,
      RECIPIENT_LOG_CANARY,
      RAW_MIME_LOG_CANARY,
    ]) {
      expect(logs.join("\n")).not.toContain(canary);
    }
    expect(process.exitCode).toBe(1);
  });

  it("bounds dedicated pool cleanup to five seconds", async () => {
    vi.useFakeTimers();
    mocks.pool.end.mockImplementationOnce(
      () => new Promise<undefined>(() => undefined),
    );
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
    ];

    await import("./reconcile-gmail-outbox");
    for (let index = 0; index < 12; index += 1) {
      await Promise.resolve();
    }

    expect(mocks.pool.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(console.error).not.toHaveBeenCalledWith(
      JSON.stringify({
        event: "email.gmail_reconciliation_cleanup_failed",
        code: "GMAIL_RECONCILIATION_POOL_CLOSE_FAILED",
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "email.gmail_reconciliation_cleanup_failed",
        code: "GMAIL_RECONCILIATION_POOL_CLOSE_FAILED",
      }),
    );
    expect(process.exitCode).toBe(1);
  });

  it("requires explicit apply confirmation and logs no operation, correlation, or provider identity", async () => {
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
      "--apply",
      "--confirm-operation-id",
      OPERATION_ID,
    ];

    await import("./reconcile-gmail-outbox");
    await vi.waitFor(() => expect(mocks.pool.end).toHaveBeenCalledOnce());

    expect(mocks.createMailDispatchDatabaseResources).toHaveBeenCalledWith();
    expect(mocks.PostgresOutboxStore).toHaveBeenCalledWith(
      mocks.pool,
      mocks.inspection,
    );
    expect(mocks.reconcileGmailDelivery).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      apply: true,
      confirmOperationId: OPERATION_ID,
    }, {
      store: mocks.store,
      gmail: { findByMessageId: mocks.findGmailMessageByMessageId },
    });
    const logs = vi.mocked(console.info).mock.calls.map(([entry]) => String(entry));
    expect(logs).toEqual([
      JSON.stringify({
        event: "email.gmail_reconciliation",
        outcome: "applied",
        applied: true,
      }),
    ]);
    expect(logs.join(" ")).not.toContain(OPERATION_ID);
    expect(logs.join(" ")).not.toMatch(/codestead\.outbox|gmail-message/i);
  });
});
