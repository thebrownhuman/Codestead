import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    connect: vi.fn(),
    end: vi.fn(async (): Promise<void> => undefined),
    query: vi.fn(),
    options: Object.freeze({
      max: 3,
    }),
  };
  const database = { kind: "gmail-reconciliation-database" };
  const resources = Object.freeze({ pool, database });
  const runtimePlan: Readonly<{
    pool: Readonly<{
      serverCapacity: Readonly<{
        gmailReconciliationReserveConnections: number;
      }>;
    }>;
    timeouts: Readonly<{ poolCloseMs: number }>;
  }> = Object.freeze({
    pool: Object.freeze({
      serverCapacity: Object.freeze({
        gmailReconciliationReserveConnections: 3,
      }),
    }),
    timeouts: Object.freeze({ poolCloseMs: 50 }),
  });
  const startupInspection = Object.freeze({
    plan: runtimePlan,
    postgresMajor: 17,
  });
  const applicationOrigin = Object.freeze({});
  const createMailDispatchBootstrapResources = vi.fn(() => resources);
  const inspectMailDispatchRuntime = vi.fn(async () => startupInspection);
  const assertGmailReconciliationOAuthScopes = vi.fn();
  const captureMailDispatchApplicationOrigin = vi.fn(
    () => applicationOrigin,
  );
  const mailDispatchApplicationUrl = vi.fn(
    () => "https://codestead.test",
  );
  const store = { kind: "gmail-reconciliation-store" };
  const PostgresOutboxStore = vi.fn(function PostgresOutboxStore() {
    return store;
  });
  const findGmailMessageByMessageId = vi.fn();
  const reconcileGmailDelivery = vi.fn(async () => ({ kind: "applied" }));
  return {
    pool,
    database,
    resources,
    runtimePlan,
    startupInspection,
    applicationOrigin,
    createMailDispatchBootstrapResources,
    inspectMailDispatchRuntime,
    assertGmailReconciliationOAuthScopes,
    captureMailDispatchApplicationOrigin,
    mailDispatchApplicationUrl,
    store,
    PostgresOutboxStore,
    findGmailMessageByMessageId,
    reconcileGmailDelivery,
  };
});

vi.mock("../src/lib/db/client", () => ({ pool: mocks.pool }));
vi.mock("../src/lib/notifications/mail-dispatch-pool", () => ({
  createMailDispatchBootstrapResources:
    mocks.createMailDispatchBootstrapResources,
}));
vi.mock("../src/lib/notifications/mail-dispatch-runtime-startup", () => ({
  inspectMailDispatchRuntime: mocks.inspectMailDispatchRuntime,
}));
vi.mock(
  "../src/lib/notifications/gmail-oauth-scopes",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../src/lib/notifications/gmail-oauth-scopes")
    >();
    mocks.assertGmailReconciliationOAuthScopes.mockImplementation(
      actual.assertGmailReconciliationOAuthScopes,
    );
    return {
      assertGmailReconciliationOAuthScopes:
        mocks.assertGmailReconciliationOAuthScopes,
    };
  },
);
vi.mock("../src/lib/notifications/postgres-outbox-store", () => ({
  PostgresOutboxStore: mocks.PostgresOutboxStore,
  captureMailDispatchApplicationOrigin:
    mocks.captureMailDispatchApplicationOrigin,
  mailDispatchApplicationUrl: mocks.mailDispatchApplicationUrl,
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
    "fails closed after database authority but before Gmail access for a $label scope declaration",
    async ({ scopes }) => {
      vi.stubEnv("GMAIL_OAUTH_SCOPES", scopes);
      process.argv = [
        originalArgv[0]!,
        originalArgv[1]!,
        "--operation-id",
        OPERATION_ID,
      ];

      await import("./reconcile-gmail-outbox");
      await vi.waitFor(() => expect(mocks.pool.end).toHaveBeenCalledOnce());

      expect(mocks.inspectMailDispatchRuntime).toHaveBeenCalledWith(mocks.pool);
      expect(mocks.PostgresOutboxStore).toHaveBeenCalledWith(
        mocks.pool,
        mocks.startupInspection,
        mocks.applicationOrigin,
      );
      expect(mocks.assertGmailReconciliationOAuthScopes)
        .toHaveBeenCalledWith(scopes);
      expect(mocks.PostgresOutboxStore.mock.invocationCallOrder[0])
        .toBeLessThan(
          mocks.assertGmailReconciliationOAuthScopes
            .mock.invocationCallOrder[0]!,
        );
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

  it("fails closed when the dedicated pool cannot issue a startup capability", async () => {
    mocks.inspectMailDispatchRuntime.mockRejectedValueOnce(new Error(
      `recipient=${RECIPIENT_LOG_CANARY}; operation=${UUID_LOG_CANARY}`,
    ));
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
    ];

    await import("./reconcile-gmail-outbox");
    await vi.waitFor(() => expect(mocks.pool.end).toHaveBeenCalledOnce());

    expect(mocks.createMailDispatchBootstrapResources).toHaveBeenCalledOnce();
    expect(mocks.inspectMailDispatchRuntime).toHaveBeenCalledWith(mocks.pool);
    expect(mocks.captureMailDispatchApplicationOrigin).not.toHaveBeenCalled();
    expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
    expect(mocks.reconcileGmailDelivery).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({
      event: "email.gmail_reconciliation_failed",
      code: "GMAIL_RECONCILIATION_FAILED",
    }));
    expect(vi.mocked(console.error).mock.calls.flat().join("\n"))
      .not.toContain(RECIPIENT_LOG_CANARY);
  });

  it("fails closed when server capacity does not match the physical pool maximum", async () => {
    const mismatchedInspection = Object.freeze({
      plan: Object.freeze({
        pool: Object.freeze({
          serverCapacity: Object.freeze({
            gmailReconciliationReserveConnections: 2,
          }),
        }),
        timeouts: mocks.runtimePlan.timeouts,
      }),
      postgresMajor: 17,
    });
    mocks.inspectMailDispatchRuntime.mockResolvedValueOnce(
      mismatchedInspection,
    );
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
    ];

    await import("./reconcile-gmail-outbox");
    await vi.waitFor(() => expect(mocks.pool.end).toHaveBeenCalledOnce());

    expect(mocks.createMailDispatchBootstrapResources).toHaveBeenCalledOnce();
    expect(mocks.captureMailDispatchApplicationOrigin).not.toHaveBeenCalled();
    expect(mocks.PostgresOutboxStore).not.toHaveBeenCalled();
    expect(mocks.reconcileGmailDelivery).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({
      event: "email.gmail_reconciliation_failed",
      code: "GMAIL_RECONCILIATION_FAILED",
    }));
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

    expect(mocks.createMailDispatchBootstrapResources).toHaveBeenCalledOnce();
    expect(mocks.inspectMailDispatchRuntime).toHaveBeenCalledWith(mocks.pool);
    expect(mocks.captureMailDispatchApplicationOrigin)
      .toHaveBeenCalledWith(mocks.startupInspection);
    expect(mocks.mailDispatchApplicationUrl)
      .toHaveBeenCalledWith(mocks.applicationOrigin);
    expect(mocks.PostgresOutboxStore).toHaveBeenCalledWith(
      mocks.pool,
      mocks.startupInspection,
      mocks.applicationOrigin,
    );
    expect(mocks.inspectMailDispatchRuntime.mock.invocationCallOrder[0])
      .toBeLessThan(
        mocks.captureMailDispatchApplicationOrigin.mock.invocationCallOrder[0]!,
      );
    expect(
      mocks.captureMailDispatchApplicationOrigin.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.PostgresOutboxStore.mock.invocationCallOrder[0]!);
    expect(mocks.assertGmailReconciliationOAuthScopes)
      .toHaveBeenCalledWith(`${SEND_SCOPE} ${VALID_READ_SCOPE}`);
    expect(mocks.PostgresOutboxStore.mock.invocationCallOrder[0])
      .toBeLessThan(
        mocks.assertGmailReconciliationOAuthScopes.mock.invocationCallOrder[0]!,
      );
    expect(
      mocks.assertGmailReconciliationOAuthScopes.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.reconcileGmailDelivery.mock.invocationCallOrder[0]!);
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

  it("cleans up before non-returning hard exit for a fatal reconciliation transport", async () => {
    vi.useFakeTimers();
    const { FatalProviderTransportError } = await import(
      "../src/lib/notifications/provider-dispatch-contract"
    );
    const oauthSecretCanary = "oauth-private-client-secret";
    const fatalFailure = Object.assign(
      new FatalProviderTransportError("PROVIDER_TRANSPORT_FATAL"),
      {
        cause: {
          recipient: RECIPIENT_LOG_CANARY,
          oauthSecret: oauthSecretCanary,
        },
        providerPayload: RAW_MIME_LOG_CANARY,
        stack: `operation=${UUID_LOG_CANARY}; token=${BASE64URL_LOG_CANARY}`,
      },
    );
    mocks.reconcileGmailDelivery.mockRejectedValueOnce(fatalFailure);
    let closeResolved = false;
    let resolveClose!: () => void;
    mocks.pool.end.mockImplementationOnce(
      () => new Promise<void>((resolveClosePromise) => {
        resolveClose = () => {
          closeResolved = true;
          resolveClosePromise();
        };
      }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as never,
    );
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
    ];

    const { gmailReconciliationCommand } =
      await import("./reconcile-gmail-outbox");
    let commandSettled = false;
    void gmailReconciliationCommand.then(
      () => { commandSettled = true; },
      () => { commandSettled = true; },
    );
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    expect(mocks.pool.end).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(commandSettled).toBe(false);

    resolveClose();
    await vi.advanceTimersByTimeAsync(0);

    expect(closeResolved).toBe(true);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(commandSettled).toBe(false);
    expect(process.exitCode).toBe(1);
    const logs = vi.mocked(console.error).mock.calls.map(([entry]) =>
      String(entry)
    );
    expect(logs).toEqual([
      JSON.stringify({
        event: "email.gmail_reconciliation_failed",
        code: "GMAIL_RECONCILIATION_TRANSPORT_FATAL",
      }),
    ]);
    for (const canary of [
      UUID_LOG_CANARY,
      BASE64URL_LOG_CANARY,
      RECIPIENT_LOG_CANARY,
      RAW_MIME_LOG_CANARY,
      oauthSecretCanary,
    ]) {
      expect(logs.join("\n")).not.toContain(canary);
    }
  });

  it("forces non-returning termination when dedicated-pool shutdown times out", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation(
      (() => undefined) as never,
    );
    let failClose: ((error: Error) => void) | undefined;
    mocks.pool.end.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => {
        failClose = reject;
      }),
    );
    process.argv = [
      originalArgv[0]!,
      originalArgv[1]!,
      "--operation-id",
      OPERATION_ID,
    ];

    const commandModule = await import("./reconcile-gmail-outbox");
    const commandCompletion = (
      commandModule as typeof commandModule & {
        gmailReconciliationCommand: Promise<void>;
      }
    ).gmailReconciliationCommand;
    expect(commandCompletion).toBeInstanceOf(Promise);
    let commandSettled = false;
    void commandCompletion.then(
      () => { commandSettled = true; },
      () => { commandSettled = true; },
    );
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(mocks.pool.end).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(
      mocks.startupInspection.plan.timeouts.poolCloseMs,
    );
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    expect(console.error).toHaveBeenCalledWith(JSON.stringify({
      event: "email.gmail_reconciliation_cleanup_failed",
      code: "GMAIL_RECONCILIATION_POOL_CLOSE_FAILED",
    }));
    expect(process.exitCode).toBe(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(commandSettled).toBe(false);

    failClose?.(new Error(`late close ${RECIPIENT_LOG_CANARY}`));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(commandSettled).toBe(false);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("never imports the application-wide database pool", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/reconcile-gmail-outbox.ts"),
      "utf8",
    );
    expect(source).not.toContain("../src/lib/db/client");
  });
});
