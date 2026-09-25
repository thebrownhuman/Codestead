import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_STORAGE_QUOTA_BYTES } from "../policy";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, transaction: mocks.transaction } }));

import { changeLearnerStorageQuota, getLearnerStorageQuota } from "../admin-quota";

function chainable(result: unknown) {
  const obj: Record<string, unknown> = {};
  const self = () => obj;
  obj.from = self;
  obj.leftJoin = self;
  obj.where = self;
  obj.groupBy = self;
  obj.limit = self;
  obj.values = self;
  obj.set = self;
  obj.returning = () => Promise.resolve(result);
  obj.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return obj;
}

const learnerPublicId = "a1000000-0000-4000-8000-000000000001";
const requestId = "a2000000-0000-4000-8000-000000000001";
const baseInput = {
  learnerPublicId,
  requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES,
  expectedRowVersion: 3,
  requestId,
  actorUserId: "admin-1",
  reason: "Learner needs more space for course files.",
};

describe("getLearnerStorageQuota", () => {
  it("applies quota and row-version defaults for a learner with no profile row yet", async () => {
    mocks.select.mockReturnValueOnce(chainable([{
      learnerUserId: "learner-1",
      learnerPublicId,
      learnerName: "Learner",
      learnerEmail: "learner@example.test",
      quotaBytes: null,
      rowVersion: null,
      usedBytes: 512,
    }]));

    const quota = await getLearnerStorageQuota(learnerPublicId);

    expect(quota).toMatchObject({
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      rowVersion: 0,
      usedBytes: 512,
      replayed: false,
    });
  });

  it("throws LEARNER_NOT_FOUND when no matching active learner row exists", async () => {
    mocks.select.mockReturnValueOnce(chainable([]));

    await expect(getLearnerStorageQuota(learnerPublicId)).rejects.toMatchObject({
      code: "LEARNER_NOT_FOUND",
    });
  });
});

describe("changeLearnerStorageQuota", () => {
  let selectCalls: unknown[][];
  let txExecute: ReturnType<typeof vi.fn>;
  let txInsert: ReturnType<typeof vi.fn>;
  let txUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    selectCalls = [];
    txExecute = vi.fn().mockResolvedValue(undefined);
    txInsert = vi.fn(() => chainable(undefined));
    txUpdate = vi.fn(() => chainable([{ userId: "learner-1" }]));
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: txExecute,
        select: vi.fn((...args: unknown[]) => {
          const index = selectCalls.length;
          selectCalls.push(args);
          return chainable(queuedSelectResults[index]);
        }),
        insert: txInsert,
        update: txUpdate,
      };
      return work(tx);
    });
  });

  let queuedSelectResults: unknown[] = [];

  function expectedRequestHash(input: typeof baseInput) {
    return createHash("sha256")
      .update(JSON.stringify([
        "storage-quota-change.v1",
        input.actorUserId.trim(),
        input.learnerPublicId.trim().toLowerCase(),
        input.requestedBytes,
        input.expectedRowVersion,
        input.reason.trim(),
      ]))
      .digest("hex");
  }

  it("returns a replayed result without writing again when the request id was already used with the same hash", async () => {
    queuedSelectResults = [
      [{
        requestHash: expectedRequestHash(baseInput),
        learnerUserId: "learner-1",
        learnerPublicId,
        requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        usedBytesAtChange: 100,
        resultingRowVersion: 4,
      }],
      [{
        learnerUserId: "learner-1",
        learnerPublicId,
        learnerName: "Learner",
        learnerEmail: "learner@example.test",
      }],
    ];

    const result = await changeLearnerStorageQuota(baseInput);

    expect(result).toMatchObject({
      requestId,
      usedBytes: 100,
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      rowVersion: 4,
      replayed: true,
    });
    expect(txInsert).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("reports LEARNER_NOT_FOUND when a replayed request's learner identity no longer matches", async () => {
    queuedSelectResults = [
      [{
        requestHash: expectedRequestHash(baseInput),
        learnerUserId: "learner-1",
        learnerPublicId,
        requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        usedBytesAtChange: 100,
        resultingRowVersion: 4,
      }],
      [],
    ];

    await expect(changeLearnerStorageQuota(baseInput)).rejects.toMatchObject({
      code: "LEARNER_NOT_FOUND",
    });
  });

  it("rejects a reused request id bound to a different quota change", async () => {
    queuedSelectResults = [
      [{
        requestHash: "0".repeat(64),
        learnerUserId: "learner-1",
        learnerPublicId,
        requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        usedBytesAtChange: 100,
        resultingRowVersion: 4,
      }],
    ];

    await expect(changeLearnerStorageQuota(baseInput)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("reports LEARNER_NOT_FOUND when the learner is missing on a fresh request", async () => {
    queuedSelectResults = [
      [], // no prior request row
      [], // identity lookup finds nothing
    ];

    await expect(changeLearnerStorageQuota(baseInput)).rejects.toMatchObject({
      code: "LEARNER_NOT_FOUND",
    });
  });

  it("reports VERSION_CONFLICT when the caller's expected row version is stale", async () => {
    queuedSelectResults = [
      [],
      [{ id: "learner-1" }],
      [{
        learnerUserId: "learner-1",
        learnerPublicId,
        learnerName: "Learner",
        learnerEmail: "learner@example.test",
        quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        rowVersion: 9,
      }],
      [{ usedBytes: 100 }],
    ];

    await expect(changeLearnerStorageQuota(baseInput)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(txInsert).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("inserts a new learner profile row when none exists yet", async () => {
    queuedSelectResults = [
      [],
      [{ id: "learner-1" }],
      [{
        learnerUserId: "learner-1",
        learnerPublicId,
        learnerName: "Learner",
        learnerEmail: "learner@example.test",
        quotaBytes: null,
        rowVersion: null,
      }],
      [{ usedBytes: 100 }],
    ];

    const result = await changeLearnerStorageQuota({ ...baseInput, expectedRowVersion: 0 });

    expect(result).toMatchObject({
      quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      rowVersion: 1,
      replayed: false,
    });
    expect(txInsert).toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
  });

  it("updates an existing learner profile row and rejects a concurrent-write race", async () => {
    queuedSelectResults = [
      [],
      [{ id: "learner-1" }],
      [{
        learnerUserId: "learner-1",
        learnerPublicId,
        learnerName: "Learner",
        learnerEmail: "learner@example.test",
        quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        rowVersion: 3,
      }],
      [{ usedBytes: 100 }],
    ];
    txUpdate.mockReturnValueOnce(chainable([]));

    await expect(changeLearnerStorageQuota(baseInput)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
  });

  it("rejects a quota reduced below current durable usage", async () => {
    queuedSelectResults = [
      [],
      [{ id: "learner-1" }],
      [{
        learnerUserId: "learner-1",
        learnerPublicId,
        learnerName: "Learner",
        learnerEmail: "learner@example.test",
        quotaBytes: DEFAULT_STORAGE_QUOTA_BYTES,
        rowVersion: 3,
      }],
      [{ usedBytes: DEFAULT_STORAGE_QUOTA_BYTES + 1 }],
    ];

    await expect(changeLearnerStorageQuota(baseInput)).rejects.toMatchObject({
      code: "QUOTA_BELOW_USAGE",
    });
  });
});
