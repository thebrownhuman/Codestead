import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  db: {
    transaction: dbMocks.transaction,
    select: dbMocks.select,
    update: dbMocks.update,
  },
}));

import {
  canonicalProviderOperationHash,
  PostgresProviderOperationReceiptStore,
} from "../provider-operation-idempotency";

const key = {
  ownerUserId: "learner-1",
  action: "tutor.post" as const,
  requestId: "10000000-0000-4000-8000-000000000001",
  inputHash: canonicalProviderOperationHash({ message: "Explain arrays." }),
};
const lease = {
  leaseId: "90000000-0000-4000-8000-000000000001",
  leaseVersion: 1,
} as const;

function insertBuilder(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  return { builder: { values }, values, onConflictDoNothing, returning };
}

function selectBuilder(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { builder: { from }, from, where, limit };
}

function acquireSelectBuilder(receiptRows?: unknown[]) {
  const owner = selectBuilder([{ status: "active" }]);
  const receipt = selectBuilder(receiptRows ?? []);
  const select = vi.fn()
    .mockImplementationOnce(() => owner.builder);
  if (receiptRows !== undefined) select.mockImplementationOnce(() => receipt.builder);
  return { select, owner, receipt };
}

function lockedSelectBuilder(rows: unknown[]) {
  const lock = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn(() => ({ for: lock }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { builder: { from }, from, where, limit, lock };
}

function updateBuilder(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  return { builder: { set }, set, where, returning };
}

function completedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    inputHash: key.inputHash,
    status: "completed",
    responseStatus: 200,
    responseBody: { ok: true },
    ...lease,
    leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("Postgres provider-operation receipt store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims a newly inserted receipt without reading it back", async () => {
    const inserted = insertBuilder([{ id: "receipt-1" }]);
    const selected = acquireSelectBuilder();
    const tx = {
      execute: vi.fn(),
      insert: vi.fn(() => inserted.builder),
      select: selected.select,
    };
    dbMocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(new PostgresProviderOperationReceiptStore().acquire(key)).resolves.toEqual({
      kind: "claimed",
      lease: { leaseId: expect.any(String), leaseVersion: 1 },
    });
    expect(inserted.values).toHaveBeenCalledWith(expect.objectContaining(key));
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.select).toHaveBeenCalledOnce();
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(tx.select.mock.invocationCallOrder[0]!);
  });

  it("rejects an unavailable owner before inserting or resolving a receipt", async () => {
    const owner = selectBuilder([{ status: "deletion_pending" }]);
    const tx = {
      execute: vi.fn(),
      insert: vi.fn(),
      select: vi.fn(() => owner.builder),
    };
    dbMocks.transaction.mockImplementationOnce(async (callback) => callback(tx));

    await expect(new PostgresProviderOperationReceiptStore().acquire(key)).rejects.toMatchObject({
      code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
    });
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.execute.mock.invocationCallOrder[0]).toBeLessThan(tx.select.mock.invocationCallOrder[0]!);
  });

  it.each([
    {
      name: "processing",
      receipt: {
        inputHash: key.inputHash,
        status: "processing",
        responseStatus: null,
        responseBody: null,
        ...lease,
        leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
      expected: { kind: "processing" },
    },
    {
      name: "completed",
      receipt: completedReceipt(),
      expected: { kind: "completed", response: { status: 200, body: { ok: true } } },
    },
  ])("resolves an existing $name receipt", async ({ receipt, expected }) => {
    const inserted = insertBuilder([]);
    const selected = acquireSelectBuilder([receipt]);
    const tx = {
      execute: vi.fn(),
      insert: vi.fn(() => inserted.builder),
      select: selected.select,
    };
    dbMocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(new PostgresProviderOperationReceiptStore().acquire(key)).resolves.toEqual(expected);
  });

  it("fails closed when a conflicting insert cannot be resolved", async () => {
    const inserted = insertBuilder([]);
    const selected = acquireSelectBuilder([]);
    const tx = {
      execute: vi.fn(),
      insert: vi.fn(() => inserted.builder),
      select: selected.select,
    };
    dbMocks.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(new PostgresProviderOperationReceiptStore().acquire(key)).rejects.toMatchObject({
      code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
    });
  });

  it("detects input mismatch and incomplete completed rows during acquire", async () => {
    const store = new PostgresProviderOperationReceiptStore();
    for (const [receipt, code] of [
      [completedReceipt({ inputHash: "b".repeat(64) }), "IDEMPOTENCY_KEY_REUSED"],
      [completedReceipt({ responseBody: null }), "IDEMPOTENCY_RECEIPT_UNAVAILABLE"],
    ] as const) {
      const inserted = insertBuilder([]);
      const selected = acquireSelectBuilder([receipt]);
      const tx = {
        execute: vi.fn(),
        insert: vi.fn(() => inserted.builder),
        select: selected.select,
      };
      dbMocks.transaction.mockImplementationOnce(async (callback) => callback(tx));
      await expect(store.acquire(key)).rejects.toMatchObject({ code });
    }
  });

  it("reads missing, processing, and completed receipts and rejects invalid persisted state", async () => {
    const store = new PostgresProviderOperationReceiptStore();
    for (const [rows, expected] of [
      [[], null],
      [[{
        inputHash: key.inputHash,
        status: "processing",
        responseStatus: null,
        responseBody: null,
        ...lease,
        leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }], {
        inputHash: key.inputHash,
        status: "processing",
        responseStatus: null,
        responseBody: null,
        ...lease,
        leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      }],
      [[completedReceipt()], completedReceipt()],
    ] as const) {
      const selected = selectBuilder([...rows] as unknown[]);
      dbMocks.select.mockImplementationOnce(() => selected.builder);
      await expect(store.read(key)).resolves.toEqual(expected);
    }

    const invalid = selectBuilder([{
      inputHash: key.inputHash,
      status: "corrupt",
      responseStatus: null,
      responseBody: null,
    }]);
    dbMocks.select.mockImplementationOnce(() => invalid.builder);
    await expect(store.read(key)).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
  });

  it("completes a processing row atomically and stores the normalized response", async () => {
    const updated = updateBuilder([{ id: "receipt-1" }]);
    dbMocks.update.mockImplementationOnce(() => updated.builder);

    await expect(new PostgresProviderOperationReceiptStore().complete(key, {
      status: 201,
      body: { nested: { saved: true }, omitted: undefined },
    }, lease)).resolves.toBeUndefined();
    expect(updated.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      responseStatus: 201,
      responseBody: { nested: { saved: true } },
      completedAt: expect.any(Date),
      updatedAt: expect.any(Date),
    }));
    expect(dbMocks.select).not.toHaveBeenCalled();
  });

  it("accepts a compare-and-set race when the stored response is canonically identical", async () => {
    dbMocks.update.mockImplementationOnce(() => updateBuilder([]).builder);
    dbMocks.select.mockImplementationOnce(() => selectBuilder([
      completedReceipt({ responseStatus: 201, responseBody: { b: 2, a: 1 } }),
    ]).builder);

    await expect(new PostgresProviderOperationReceiptStore().complete(key, {
      status: 201,
      body: { a: 1, b: 2 },
    }, lease)).resolves.toBeUndefined();
  });

  it.each([
    [completedReceipt({ responseStatus: 202 }), { status: 201, body: { ok: true } }],
    [completedReceipt({ responseStatus: 201, responseBody: { ok: false } }), { status: 201, body: { ok: true } }],
  ])("rejects a compare-and-set race with a different stored response", async (receipt, response) => {
    dbMocks.update.mockImplementationOnce(() => updateBuilder([]).builder);
    dbMocks.select.mockImplementationOnce(() => selectBuilder([receipt]).builder);

    await expect(new PostgresProviderOperationReceiptStore().complete(key, response, lease)).rejects.toMatchObject({
      code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
    });
  });

  it("fails closed when a receipt disappears before compare-and-set completion", async () => {
    dbMocks.update.mockImplementationOnce(() => updateBuilder([]).builder);
    dbMocks.select.mockImplementationOnce(() => selectBuilder([]).builder);

    await expect(new PostgresProviderOperationReceiptStore().complete(key, {
      status: 200,
      body: { ok: true },
    }, lease)).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
  });

  it("detects a changed input hash and a still-processing row after compare-and-set loss", async () => {
    const store = new PostgresProviderOperationReceiptStore();
    for (const [receipt, code] of [
      [completedReceipt({ inputHash: "b".repeat(64) }), "IDEMPOTENCY_KEY_REUSED"],
      [{ inputHash: key.inputHash, status: "processing", responseStatus: null, responseBody: null }, "IDEMPOTENCY_RECEIPT_UNAVAILABLE"],
    ] as const) {
      dbMocks.update.mockImplementationOnce(() => updateBuilder([]).builder);
      dbMocks.select.mockImplementationOnce(() => selectBuilder([receipt]).builder);
      await expect(store.complete(key, { status: 200, body: { ok: true } }, lease)).rejects.toMatchObject({ code });
    }
  });

  it("leaves a live processing lease untouched", async () => {
    const selected = lockedSelectBuilder([{
      inputHash: key.inputHash,
      status: "processing",
      responseStatus: null,
      responseBody: null,
      ...lease,
      leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }]);
    const tx = { select: vi.fn(() => selected.builder), update: vi.fn() };
    dbMocks.transaction.mockImplementationOnce(async (callback) => callback(tx));

    await expect(new PostgresProviderOperationReceiptStore().recoverExpired(
      key,
      new Date("2026-07-12T00:00:00.000Z"),
    )).resolves.toEqual({ kind: "processing" });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("terminalizes an expired tutor lease with a fenced indeterminate response", async () => {
    const selected = lockedSelectBuilder([{
      inputHash: key.inputHash,
      status: "processing",
      responseStatus: null,
      responseBody: null,
      ...lease,
      leaseExpiresAt: new Date("2026-07-11T23:59:00.000Z"),
    }]);
    const updated = updateBuilder([{ id: "receipt-1" }]);
    const tx = {
      select: vi.fn(() => selected.builder),
      update: vi.fn(() => updated.builder),
    };
    dbMocks.transaction.mockImplementationOnce(async (callback) => callback(tx));

    const recovered = await new PostgresProviderOperationReceiptStore().recoverExpired(
      key,
      new Date("2026-07-12T00:00:00.000Z"),
    );
    expect(recovered).toEqual({
      kind: "completed",
      response: {
        status: 503,
        body: expect.objectContaining({
          code: "PROVIDER_OPERATION_INDETERMINATE",
          degraded: true,
        }),
      },
    });
    expect(updated.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      responseStatus: 503,
      completedAt: new Date("2026-07-12T00:00:00.000Z"),
      leaseId: expect.any(String),
      leaseVersion: expect.anything(),
    }));
    const recoveredUpdate = (updated.set.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];
    expect(recoveredUpdate?.leaseId).not.toBe(lease.leaseId);
  });

  it("rejects completion by the stale lease after recovery fenced the receipt", async () => {
    const recoveryResponse = {
      error: "Codestead is unavailable right now. Your authored lesson and deterministic practice are still available. You can keep learning while AI recovers.",
      code: "PROVIDER_OPERATION_INDETERMINATE",
      degraded: true,
    };
    dbMocks.update.mockImplementationOnce(() => updateBuilder([]).builder);
    dbMocks.select.mockImplementationOnce(() => selectBuilder([
      completedReceipt({
        responseStatus: 503,
        responseBody: recoveryResponse,
        leaseId: "90000000-0000-4000-8000-000000000002",
        leaseVersion: 2,
      }),
    ]).builder);

    await expect(new PostgresProviderOperationReceiptStore().complete(key, {
      status: 200,
      body: { content: "late provider response" },
    }, lease)).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
  });

  it("validates keys at every public store boundary", async () => {
    const store = new PostgresProviderOperationReceiptStore();
    const invalid = { ...key, requestId: "invalid" };

    await expect(store.acquire(invalid)).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
    await expect(store.read(invalid)).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
    await expect(store.complete(invalid, { status: 200, body: { ok: true } }, lease)).rejects.toMatchObject({
      code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
    });
    await expect(store.recoverExpired(invalid)).rejects.toMatchObject({
      code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE",
    });
    expect(dbMocks.transaction).not.toHaveBeenCalled();
    expect(dbMocks.select).not.toHaveBeenCalled();
    expect(dbMocks.update).not.toHaveBeenCalled();
  });
});
