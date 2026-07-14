import { describe, expect, it } from "vitest";

import {
  StorageQuotaAdminError,
  storageQuotaAdminHttpStatus,
  validateRequestedStorageQuota,
} from "../admin-quota";
import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  MAX_STORAGE_QUOTA_BYTES,
} from "../policy";

describe("administrator storage quota policy", () => {
  it.each([
    DEFAULT_STORAGE_QUOTA_BYTES,
    DEFAULT_STORAGE_QUOTA_BYTES + 256 * 1024 ** 2,
    MAX_STORAGE_QUOTA_BYTES,
  ])("accepts an exact in-range quota of %i bytes", (requestedBytes) => {
    expect(() => validateRequestedStorageQuota({ requestedBytes, usedBytes: 1024 })).not.toThrow();
  });

  it.each([
    DEFAULT_STORAGE_QUOTA_BYTES - 1,
    MAX_STORAGE_QUOTA_BYTES + 1,
    2.5,
    Number.NaN,
  ])("rejects an invalid quota of %s", (requestedBytes) => {
    expect(() => validateRequestedStorageQuota({ requestedBytes, usedBytes: 0 })).toThrowError(
      expect.objectContaining({ code: "INVALID_QUOTA" }),
    );
  });

  it("does not reduce a quota below durable usage", () => {
    expect(() => validateRequestedStorageQuota({
      requestedBytes: DEFAULT_STORAGE_QUOTA_BYTES,
      usedBytes: DEFAULT_STORAGE_QUOTA_BYTES + 1,
    })).toThrowError(expect.objectContaining({ code: "QUOTA_BELOW_USAGE" }));
  });

  it("maps expected conflicts without leaking implementation failures", () => {
    expect(storageQuotaAdminHttpStatus(new StorageQuotaAdminError("LEARNER_NOT_FOUND", "missing"))).toBe(404);
    expect(storageQuotaAdminHttpStatus(new StorageQuotaAdminError("VERSION_CONFLICT", "conflict"))).toBe(409);
    expect(storageQuotaAdminHttpStatus(new StorageQuotaAdminError("IDEMPOTENCY_CONFLICT", "reuse"))).toBe(409);
    expect(storageQuotaAdminHttpStatus(new StorageQuotaAdminError("QUOTA_BELOW_USAGE", "usage"))).toBe(409);
    expect(storageQuotaAdminHttpStatus(new StorageQuotaAdminError("INVALID_REQUEST", "request"))).toBe(400);
    expect(storageQuotaAdminHttpStatus(new StorageQuotaAdminError("INVALID_QUOTA", "invalid"))).toBe(400);
    expect(storageQuotaAdminHttpStatus(new Error("database secret"))).toBe(500);
  });
});
