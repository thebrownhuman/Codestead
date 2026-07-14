import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: { profileQuota: number | null; used: number } = { profileQuota: 100, used: 0 };
  const execute = vi.fn(async () => undefined);
  const storedValues = vi.fn(async () => undefined);
  const ledgerValues = vi.fn(async () => undefined);
  const storedTable = { kind: "stored" };
  const ledgerTable = { kind: "ledger" };
  const select = vi.fn((projection: Record<string, unknown>) => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        if ("quota" in projection) {
          return { limit: vi.fn(async () => state.profileQuota === null ? [] : [{ quota: state.profileQuota }]) };
        }
        return Promise.resolve([{ used: state.used }]);
      }),
    })),
  }));
  const insert = vi.fn((table: { kind: string }) => ({
    values: table.kind === "stored" ? storedValues : ledgerValues,
  }));
  const tx = { execute, select, insert };
  const transaction = vi.fn(async (work: (value: typeof tx) => Promise<void>) => work(tx));
  return { state, execute, storedValues, ledgerValues, storedTable, ledgerTable, select, insert, transaction };
});

vi.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => ({ and: values }),
  eq: (...values: unknown[]) => ({ eq: values }),
  isNull: (value: unknown) => ({ isNull: value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
}));
vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/db/schema", () => ({
  learnerProfile: { storageQuotaBytes: "profile.quota", userId: "profile.user" },
  quotaLedger: mocks.ledgerTable,
  storedObject: {
    ...mocks.storedTable,
    sizeBytes: "object.size", ownerUserId: "object.owner", deletedAt: "object.deleted",
  },
}));

import { DEFAULT_STORAGE_QUOTA_BYTES } from "../policy";
import { reserveStoredObject, StorageQuotaExceededError } from "../quota-store";

const reservation = {
  objectId: "object-1",
  userId: "learner-1",
  storageKey: "learner-1/object-1",
  originalName: "main.py",
  mediaType: "text/plain",
  sizeBytes: 25,
  sha256: "a".repeat(64),
  scanStatus: "pending",
};

describe("atomic storage quota reservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.profileQuota = 100;
    mocks.state.used = 50;
  });

  it("locks the learner quota and writes object plus ledger in one transaction", async () => {
    await reserveStoredObject({ ...reservation, idempotencyKey: "upload-request-1" });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.storedValues).toHaveBeenCalledWith({
      id: "object-1", ownerUserId: "learner-1", storageKey: "learner-1/object-1",
      originalName: "main.py", mediaType: "text/plain", sizeBytes: 25,
      sha256: "a".repeat(64), scanStatus: "pending",
    });
    expect(mocks.ledgerValues).toHaveBeenCalledWith({
      userId: "learner-1", objectId: "object-1", operation: "reserve_and_finalize",
      bytes: 25, idempotencyKey: "upload-request-1",
    });
    expect(mocks.execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.storedValues.mock.invocationCallOrder[0]);
  });

  it("allows a reservation that exactly fills the learner quota", async () => {
    mocks.state.used = 75;
    await expect(reserveStoredObject(reservation)).resolves.toBeUndefined();
    expect(mocks.ledgerValues).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "object-1" }));
  });

  it("fails before either insert when the quota would be exceeded", async () => {
    mocks.state.used = 76;
    await expect(reserveStoredObject(reservation)).rejects.toBeInstanceOf(StorageQuotaExceededError);
    expect(mocks.storedValues).not.toHaveBeenCalled();
    expect(mocks.ledgerValues).not.toHaveBeenCalled();
  });

  it("uses the two-gigabyte default when the learner has no override", async () => {
    mocks.state.profileQuota = null;
    mocks.state.used = DEFAULT_STORAGE_QUOTA_BYTES - reservation.sizeBytes;
    await expect(reserveStoredObject(reservation)).resolves.toBeUndefined();
  });

  it("fails closed for invalid aggregate usage returned by storage", async () => {
    mocks.state.used = Number.NaN;
    await expect(reserveStoredObject(reservation)).rejects.toBeInstanceOf(StorageQuotaExceededError);
    expect(mocks.storedValues).not.toHaveBeenCalled();
  });
});
