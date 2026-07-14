import { describe, expect, it, vi } from "vitest";

import {
  canonicalProviderOperationHash,
  executeProviderOperationIdempotently,
  ProviderOperationIdempotencyError,
  type ProviderOperationAction,
  type ProviderOperationReceiptStore,
  type ProviderOperationSafeResponse,
} from "../provider-operation-idempotency";

type Key = Readonly<{
  ownerUserId: string;
  action: ProviderOperationAction;
  requestId: string;
  inputHash: string;
}>;

type MemoryReceipt = {
  inputHash: string;
  status: "processing" | "completed";
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
  leaseId: string;
  leaseVersion: number;
  leaseExpiresAt: Date;
};

const memoryLease = {
  leaseId: "90000000-0000-4000-8000-000000000001",
  leaseVersion: 1,
} as const;

class MemoryStore implements ProviderOperationReceiptStore {
  readonly receipts = new Map<string, MemoryReceipt>();

  private key(input: Key) {
    return `${input.ownerUserId}:${input.action}:${input.requestId}`;
  }

  async acquire(input: Key) {
    const key = this.key(input);
    const receipt = this.receipts.get(key);
    if (!receipt) {
      this.receipts.set(key, {
        inputHash: input.inputHash,
        status: "processing",
        responseStatus: null,
        responseBody: null,
        ...memoryLease,
        leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      });
      return { kind: "claimed" as const, lease: memoryLease };
    }
    if (receipt.inputHash !== input.inputHash) {
      throw new ProviderOperationIdempotencyError(
        "IDEMPOTENCY_KEY_REUSED",
        "This request ID was already used for different input.",
      );
    }
    return receipt.status === "completed"
      ? {
          kind: "completed" as const,
          response: { status: receipt.responseStatus!, body: receipt.responseBody! },
        }
      : { kind: "processing" as const };
  }

  async read(input: Key) {
    return this.receipts.get(this.key(input)) ?? null;
  }

  async complete(
    input: Key,
    response: ProviderOperationSafeResponse,
    lease: typeof memoryLease,
  ) {
    const receipt = this.receipts.get(this.key(input));
    if (
      !receipt ||
      receipt.inputHash !== input.inputHash ||
      receipt.status !== "processing" ||
      lease.leaseId !== receipt.leaseId ||
      lease.leaseVersion !== receipt.leaseVersion
    ) {
      throw new Error("invalid synthetic completion");
    }
    this.receipts.set(this.key(input), {
      ...receipt,
      status: "completed",
      responseStatus: response.status,
      responseBody: response.body,
    });
  }
}

const base = {
  ownerUserId: "learner-1",
  action: "tutor.post" as const,
  requestId: "10000000-0000-4000-8000-000000000001",
  inputHash: canonicalProviderOperationHash({ message: "Explain arrays.", threadId: null }),
};

describe("durable provider-operation idempotency", () => {
  it("produces a deterministic canonical hash independent of object key order", () => {
    expect(canonicalProviderOperationHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalProviderOperationHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(canonicalProviderOperationHash({ values: [1, 2] })).not.toBe(
      canonicalProviderOperationHash({ values: [2, 1] }),
    );
  });

  it("canonicalizes every JSON scalar, arrays, and omitted undefined object fields", () => {
    for (const value of [null, "text", true, false, 0, -12.5, [null, "x", false, 3]]) {
      expect(canonicalProviderOperationHash(value)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(canonicalProviderOperationHash({ keep: true, omitted: undefined })).toBe(
      canonicalProviderOperationHash({ keep: true }),
    );
  });

  it("rejects non-JSON and non-finite canonical input", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalProviderOperationHash(value)).toThrow("non-finite number");
    }
    for (const value of [undefined, Symbol("not-json"), () => undefined]) {
      expect(() => canonicalProviderOperationHash(value)).toThrow("only JSON values");
    }
  });

  it("rejects invalid receipt keys before consulting the store", async () => {
    const store = new MemoryStore();
    const acquire = vi.spyOn(store, "acquire");
    const invalidKeys = [
      { ...base, ownerUserId: "" },
      { ...base, requestId: "not-a-uuid" },
      { ...base, inputHash: "A".repeat(64) },
    ];

    for (const key of invalidKeys) {
      await expect(executeProviderOperationIdempotently({
        ...key,
        store,
        execute: async () => ({ status: 200, body: { ok: true } }),
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
    }
    expect(acquire).not.toHaveBeenCalled();
  });

  it("replays the exact stored response after a lost HTTP response without executing again", async () => {
    const store = new MemoryStore();
    const execute = vi.fn(async () => ({ status: 200, body: { content: "Stored Codestead answer", callId: "call-1" } }));

    const first = await executeProviderOperationIdempotently({ ...base, store, execute });
    const replay = await executeProviderOperationIdempotently({
      ...base,
      store,
      execute: vi.fn(async () => ({ status: 500, body: { error: "must not run" } })),
    });

    expect(first).toEqual({ status: 200, body: { content: "Stored Codestead answer", callId: "call-1" }, replayed: false });
    expect(replay).toEqual({ status: 200, body: { content: "Stored Codestead answer", callId: "call-1" }, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("terminalizes a thrown provider callback immediately and replays without another call", async () => {
    const store = new MemoryStore();
    const execute = vi.fn(async () => {
      throw new Error("sensitive provider or database detail");
    });

    const first = await executeProviderOperationIdempotently({ ...base, store, execute });
    const replay = await executeProviderOperationIdempotently({ ...base, store, execute });

    expect(first).toEqual({
      status: 503,
      body: {
        error: "Codestead is unavailable right now. Your authored lesson and deterministic practice are still available. You can keep learning while AI recovers.",
        code: "PROVIDER_OPERATION_INDETERMINATE",
        degraded: true,
      },
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain("sensitive provider or database detail");
  });

  it("serializes exact concurrent retries to one provider callback and one response", async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await providerGate;
      return { status: 200, body: { content: "one call" } };
    });

    const firstPromise = executeProviderOperationIdempotently({ ...base, store, execute });
    await Promise.resolve();
    const secondPromise = executeProviderOperationIdempotently({
      ...base,
      store,
      execute,
      pollIntervalMs: 1,
      delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    release();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ status: 200, body: { content: "one call" }, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects UUID reuse with a different canonical payload before executing", async () => {
    const store = new MemoryStore();
    await executeProviderOperationIdempotently({
      ...base,
      store,
      execute: async () => ({ status: 200, body: { ok: true } }),
    });
    const changed = vi.fn(async () => ({ status: 200, body: { ok: false } }));
    await expect(executeProviderOperationIdempotently({
      ...base,
      inputHash: canonicalProviderOperationHash({ message: "Different input" }),
      store,
      execute: changed,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(changed).not.toHaveBeenCalled();
  });

  it("scopes the same UUID independently by authenticated owner and action", async () => {
    const store = new MemoryStore();
    const execute = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await Promise.all([
      executeProviderOperationIdempotently({ ...base, store, execute }),
      executeProviderOperationIdempotently({ ...base, ownerUserId: "learner-2", store, execute }),
      executeProviderOperationIdempotently({ ...base, action: "credential.test", store, execute }),
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(store.receipts).toHaveProperty("size", 3);
  });

  it("normalizes a safe response into a detached JSON snapshot", async () => {
    const store = new MemoryStore();
    const body = { nested: { answer: true }, omitted: undefined };
    const result = await executeProviderOperationIdempotently({
      ...base,
      store,
      execute: async () => ({ status: 201, body }),
    });

    expect(result).toEqual({ status: 201, body: { nested: { answer: true } }, replayed: false });
    expect(result.body).not.toBe(body);
    expect(result.body.nested).not.toBe(body.nested);
  });

  it.each([99, 600, 200.5])("rejects an invalid durable response status (%s)", async (status) => {
    await expect(executeProviderOperationIdempotently({
      ...base,
      store: new MemoryStore(),
      execute: async () => ({ status, body: { ok: true } }),
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
  });

  it("rejects responses that cannot be represented as a bounded JSON object", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalidBodies: unknown[] = [circular, [], null, "text", undefined, { data: "x".repeat(262_145) }];

    for (const body of invalidBodies) {
      await expect(executeProviderOperationIdempotently({
        ...base,
        store: new MemoryStore(),
        execute: async () => ({ status: 200, body: body as Record<string, unknown> }),
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
    }
  });

  it("fails closed when a processing receipt disappears while waiting", async () => {
    const store: ProviderOperationReceiptStore = {
      acquire: vi.fn(async () => ({ kind: "processing" as const })),
      read: vi.fn(async () => null),
      complete: vi.fn(),
    };

    await expect(executeProviderOperationIdempotently({
      ...base,
      store,
      execute: vi.fn(),
      waitTimeoutMs: 10,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
  });

  it("rejects a waiter receipt whose input hash changes", async () => {
    const store: ProviderOperationReceiptStore = {
      acquire: vi.fn(async () => ({ kind: "processing" as const })),
      read: vi.fn(async () => ({
        inputHash: "b".repeat(64),
        status: "processing" as const,
        responseStatus: null,
        responseBody: null,
      })),
      complete: vi.fn(),
    };

    await expect(executeProviderOperationIdempotently({
      ...base,
      store,
      execute: vi.fn(),
      waitTimeoutMs: 10,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("rejects an incomplete completed receipt instead of replaying it", async () => {
    const store: ProviderOperationReceiptStore = {
      acquire: vi.fn(async () => ({ kind: "processing" as const })),
      read: vi.fn(async () => ({
        inputHash: base.inputHash,
        status: "completed" as const,
        responseStatus: null,
        responseBody: { ok: true },
      })),
      complete: vi.fn(),
    };

    await expect(executeProviderOperationIdempotently({
      ...base,
      store,
      execute: vi.fn(),
      waitTimeoutMs: 10,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
  });

  it("times out without executing when another caller remains in progress", async () => {
    const execute = vi.fn();
    const store: ProviderOperationReceiptStore = {
      acquire: vi.fn(async () => ({ kind: "processing" as const })),
      read: vi.fn(),
      complete: vi.fn(),
    };

    await expect(executeProviderOperationIdempotently({
      ...base,
      store,
      execute,
      waitTimeoutMs: -1,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_WAIT_TIMEOUT" });
    expect(store.read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("terminalizes an expired lease without re-executing the provider callback", async () => {
    const execute = vi.fn();
    const safeResponse = {
      status: 503,
      body: {
        error: "The earlier provider operation has an unknown outcome.",
        code: "PROVIDER_OPERATION_INDETERMINATE",
      },
    };
    const store: ProviderOperationReceiptStore = {
      acquire: vi.fn(async () => ({ kind: "processing" as const })),
      recoverExpired: vi.fn(async () => ({ kind: "completed" as const, response: safeResponse })),
      read: vi.fn(),
      complete: vi.fn(),
    };

    await expect(executeProviderOperationIdempotently({
      ...base,
      store,
      execute,
      waitTimeoutMs: 10,
    })).resolves.toEqual({ ...safeResponse, replayed: true });
    expect(execute).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });
});
