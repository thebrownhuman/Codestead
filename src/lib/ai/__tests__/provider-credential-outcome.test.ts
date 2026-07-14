import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn();
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { returning, where, set, update };
});

vi.mock("@/lib/db/client", () => ({ db: { update: mocks.update } }));

import { recordProviderCredentialOutcome } from "../provider-credential-outcome";

const snapshot = {
  id: "71000000-0000-4000-8000-000000000001",
  userId: "learner-1",
  keyVersion: 3,
  updatedAtToken: "2026-07-12T08:00:00.000000Z",
};
const now = new Date("2026-07-12T09:00:00.000Z");

describe("provider credential outcome CAS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.returning.mockResolvedValue([{ id: snapshot.id }]);
  });

  it("records success metadata without an active status assignment", async () => {
    await expect(recordProviderCredentialOutcome({ snapshot, outcome: { kind: "success" }, now }))
      .resolves.toEqual({ applied: true });
    expect(mocks.set).toHaveBeenCalledWith({ lastUsedAt: now, failureCode: null, updatedAt: now });
    expect(JSON.stringify(mocks.set.mock.calls)).not.toContain('"status":"active"');
  });

  it("uses only explicit invalid/rate-limit transitions and reports a lost CAS", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await expect(recordProviderCredentialOutcome({
      snapshot,
      outcome: { kind: "failure", code: "RATE_LIMIT" },
      now,
    })).resolves.toEqual({ applied: false });
    expect(mocks.set).toHaveBeenCalledWith({ status: "rate_limited", failureCode: "RATE_LIMIT", updatedAt: now });
  });

  it("rejects an invalid internal timestamp before touching storage", async () => {
    await expect(recordProviderCredentialOutcome({
      snapshot,
      outcome: { kind: "success" },
      now: new Date(Number.NaN),
    })).rejects.toThrow(/timestamp is invalid/i);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
