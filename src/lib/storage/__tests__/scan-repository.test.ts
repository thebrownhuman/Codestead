import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const poolQuery = vi.fn();
  return { query, release, connect, poolQuery };
});

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect, query: mocks.poolQuery },
}));

import { PostgresUploadScanRepository } from "../scan-repository";
import type { ScanLease } from "../upload-scanner";

const now = new Date("2026-07-12T00:00:00.000Z");
const id = "11111111-1111-4111-8111-111111111111";
const lease: ScanLease = {
  id,
  storageKey: `learner_1/${id}`,
  sizeBytes: 12,
  sha256: "a".repeat(64),
  leaseToken: "22222222-2222-4222-8222-222222222222",
  attempt: 1,
};

describe("Postgres upload scan leases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (statement: string) => {
      if (/with candidates/.test(statement)) {
        return {
          rows: [{
            id,
            storage_key: `learner_1/${id}`,
            size_bytes: "12",
            sha256: "a".repeat(64),
            scan_attempts: 2,
          }],
        };
      }
      return { rows: [] };
    });
    mocks.poolQuery.mockResolvedValue({ rowCount: 1 });
  });

  it("claims due and expired jobs under a transaction using skip-locked leases", async () => {
    const repository = new PostgresUploadScanRepository();
    const claimed = await repository.claimBatch({ now, limit: 10, leaseMs: 180_000 });
    const leaseQuery = mocks.query.mock.calls.find(([statement]) => /with candidates/.test(statement as string));
    expect(leaseQuery?.[0]).toMatch(/for update skip locked/i);
    expect(leaseQuery?.[0]).toMatch(/scan_lease_expires_at <= \$1/i);
    expect(leaseQuery?.[0]).toMatch(/scan_attempts = object\.scan_attempts \+ 1/i);
    expect(leaseQuery?.[1]).toEqual([
      now,
      10,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      new Date(now.getTime() + 180_000),
    ]);
    expect(claimed).toEqual([expect.objectContaining({
      id,
      storageKey: `learner_1/${id}`,
      sizeBytes: 12,
      attempt: 2,
      leaseToken: leaseQuery?.[1][2],
    })]);
    expect(mocks.query.mock.calls.map(([statement]) => statement)).toEqual([
      "begin",
      expect.stringMatching(/with candidates/),
      "commit",
    ]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the client when claiming fails", async () => {
    mocks.query.mockImplementationOnce(async () => ({ rows: [] }))
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ rows: [] });
    const repository = new PostgresUploadScanRepository();
    await expect(repository.claimBatch({ now, limit: 1, leaseMs: 30_000 })).rejects.toThrow("database unavailable");
    expect(mocks.query).toHaveBeenLastCalledWith("rollback");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["clean", "safe"],
    ["infected", "quarantined"],
  ] as const)("commits %s with token compare-and-set", async (verdict, status) => {
    const repository = new PostgresUploadScanRepository();
    await expect(repository.complete(lease, verdict, now)).resolves.toBe(true);
    const [statement, parameters] = mocks.poolQuery.mock.calls[0];
    expect(statement).toMatch(/scan_status = 'scanning'/i);
    expect(statement).toMatch(/scan_lease_token = \$4/i);
    expect(parameters).toEqual([status, now, lease.id, lease.leaseToken]);
  });

  it("persists retry state or a terminal fail-closed state without losing the error code", async () => {
    const repository = new PostgresUploadScanRepository();
    const retryAt = new Date(now.getTime() + 5_000);
    await repository.fail(lease, {
      code: "scanner_unavailable",
      terminal: false,
      retryAt,
      now,
    });
    expect(mocks.poolQuery.mock.calls[0][1]).toEqual([
      "pending", retryAt, "scanner_unavailable", now, lease.id, lease.leaseToken,
    ]);

    await repository.fail(lease, {
      code: "file_changed",
      terminal: true,
      retryAt,
      now,
    });
    expect(mocks.poolQuery.mock.calls[1][1][0]).toBe("scanner_error");
  });

  it("reports a lost lease when compare-and-set updates no row", async () => {
    mocks.poolQuery.mockResolvedValue({ rowCount: 0 });
    const repository = new PostgresUploadScanRepository();
    await expect(repository.complete(lease, "clean", now)).resolves.toBe(false);
  });
});
