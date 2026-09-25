import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn(),
  enqueueEmailInTransaction: vi.fn(),
  writeAuditEventInTransaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, transaction: mocks.transaction } }));
vi.mock("@/lib/notifications/outbox", () => ({ enqueueEmailInTransaction: mocks.enqueueEmailInTransaction }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEventInTransaction: mocks.writeAuditEventInTransaction }));

import {
  deriveLostDeviceProof,
  hashLostDeviceProof,
  issueLostDeviceProof,
  materializeLostDeviceProofDelivery,
  verifyLostDeviceProof,
} from "../lost-device-recovery";

function chainable(result: unknown) {
  const obj: Record<string, unknown> = {};
  const self = () => obj;
  obj.from = self;
  obj.innerJoin = self;
  obj.where = self;
  obj.limit = self;
  obj.for = self;
  obj.set = self;
  obj.values = self;
  obj.onConflictDoNothing = self;
  obj.returning = () => Promise.resolve(result);
  obj.then = (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return obj;
}

const requestId = "10000000-0000-4000-8000-000000000001";
const TEST_KEY = "unit-only-lost-device-proof-key-32-bytes-minimum";

describe("materializeLostDeviceProofDelivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("builds a URL-fragment proof and evidence when the stored hash matches", async () => {
    vi.stubEnv("LOST_DEVICE_PROOF_KEY", TEST_KEY);
    const rawProof = deriveLostDeviceProof(requestId);
    const proofHash = hashLostDeviceProof(rawProof);
    mocks.select.mockReturnValueOnce(chainable([{ proofHash }]));

    const delivery = await materializeLostDeviceProofDelivery({ requestId, name: "Learner" });

    expect(delivery).not.toBeNull();
    expect(delivery?.variables.name).toBe("Learner");
    expect(delivery?.variables.url).toContain(`proof=${encodeURIComponent(rawProof)}`);
    expect(delivery?.authorityEvidence.sourceId).toBe(requestId);
    vi.unstubAllEnvs();
  });

  it("returns null when no unconsumed unexpired proof row exists", async () => {
    mocks.select.mockReturnValueOnce(chainable([]));

    expect(await materializeLostDeviceProofDelivery({ requestId, name: "Learner" })).toBeNull();
  });

  it("returns null when the persisted hash does not match the derived proof", async () => {
    vi.stubEnv("LOST_DEVICE_PROOF_KEY", TEST_KEY);
    mocks.select.mockReturnValueOnce(chainable([{ proofHash: "a".repeat(64) }]));

    expect(await materializeLostDeviceProofDelivery({ requestId, name: "Learner" })).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("issueLostDeviceProof", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for an unknown or ineligible email without opening a transaction", async () => {
    mocks.select.mockReturnValueOnce(chainable([]));

    expect(await issueLostDeviceProof("nobody@example.test")).toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("returns null when the candidate's session was revoked between the lookup and the lock", async () => {
    mocks.select.mockReturnValueOnce(chainable([{
      userId: "user-1", name: "Learner", email: "learner@example.test", sessionId: "session-1",
    }]));
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: vi.fn(() => chainable([])),
        insert: vi.fn(() => chainable(undefined)),
        update: vi.fn(() => chainable(undefined)),
      };
      return work(tx);
    });

    expect(await issueLostDeviceProof("learner@example.test")).toBeNull();
  });

  it("issues a fresh proof, enqueues its email, and writes an audit event when none is open", async () => {
    vi.stubEnv("LOST_DEVICE_PROOF_KEY", TEST_KEY);
    mocks.select.mockReturnValueOnce(chainable([{
      userId: "user-1", name: "Learner", email: "learner@example.test", sessionId: "session-1",
    }]));
    let selectCall = 0;
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: vi.fn(() => {
          selectCall += 1;
          if (selectCall === 1) return chainable([{ id: "session-1" }]);
          return chainable([]); // no open proof row
        }),
        insert: vi.fn(() => chainable(undefined)),
        update: vi.fn(() => chainable(undefined)),
      };
      return work(tx);
    });
    mocks.enqueueEmailInTransaction.mockResolvedValue(undefined);
    mocks.writeAuditEventInTransaction.mockResolvedValue(undefined);

    const issued = await issueLostDeviceProof("learner@example.test", new Date("2026-07-12T00:00:00.000Z"));

    expect(issued).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(mocks.enqueueEmailInTransaction).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEventInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "session.lost_device_proof_issued",
    }));
    vi.unstubAllEnvs();
  });
});

describe("verifyLostDeviceProof", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when no unconsumed unexpired proof matches the claimed hash", async () => {
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: vi.fn(() => chainable([])) };
      return work(tx);
    });

    expect(await verifyLostDeviceProof({ rawProof: "bad-proof", reason: "Lost my device." })).toBeNull();
  });

  it("returns null when the claimed proof's session is no longer active", async () => {
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn(() => chainable([{ id: requestId, userId: "user-1", sessionId: "session-1" }])),
        select: vi.fn(() => chainable([])),
        insert: vi.fn(() => chainable(undefined)),
      };
      return work(tx);
    });

    expect(await verifyLostDeviceProof({ rawProof: "any-proof", reason: "Lost my device." })).toBeNull();
  });

  it("creates a pending revocation request and notifies every active admin", async () => {
    const createdRequestId = "20000000-0000-4000-8000-000000000001";
    let selectCall = 0;
    mocks.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: vi.fn(() => chainable([{ id: requestId, userId: "user-1", sessionId: "session-1" }])),
        select: vi.fn(() => {
          selectCall += 1;
          if (selectCall === 1) return chainable([{ id: "user-1", name: "Learner" }]);
          return chainable([{ id: "admin-1", email: "admin@example.test", name: "Admin" }]);
        }),
        insert: vi.fn(() => chainable([{ id: createdRequestId }])),
      };
      return work(tx);
    });
    mocks.enqueueEmailInTransaction.mockResolvedValue(undefined);
    mocks.writeAuditEventInTransaction.mockResolvedValue(undefined);

    const result = await verifyLostDeviceProof({ rawProof: "any-proof", reason: "Lost my device." });

    expect(result).toMatchObject({ requestId: createdRequestId, userId: "user-1", sessionId: "session-1" });
    expect(mocks.enqueueEmailInTransaction).toHaveBeenCalledOnce();
    expect(mocks.writeAuditEventInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "session.lost_device_proof_verified",
      metadata: expect.objectContaining({ requestChannel: "email_proof" }),
    }));
  });
});
