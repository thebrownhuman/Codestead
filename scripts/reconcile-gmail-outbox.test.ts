import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => {
  const pool = { connect: vi.fn(), end: vi.fn(async () => undefined) };
  const store = { kind: "gmail-reconciliation-store" };
  const PostgresOutboxStore = vi.fn(function PostgresOutboxStore() {
    return store;
  });
  const findGmailMessageByMessageId = vi.fn();
  const reconcileGmailDelivery = vi.fn(async () => ({ kind: "applied" }));
  return {
    pool,
    store,
    PostgresOutboxStore,
    findGmailMessageByMessageId,
    reconcileGmailDelivery,
  };
});

vi.mock("../src/lib/db/client", () => ({ pool: mocks.pool }));
vi.mock("../src/lib/notifications/postgres-outbox-store", () => ({
  PostgresOutboxStore: mocks.PostgresOutboxStore,
}));
vi.mock("../src/lib/notifications/mailer", () => ({
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
    process.exitCode = undefined;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

    expect(mocks.PostgresOutboxStore).toHaveBeenCalledWith(mocks.pool);
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
