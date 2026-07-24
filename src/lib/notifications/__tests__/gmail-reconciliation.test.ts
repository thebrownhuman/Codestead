import { describe, expect, it, vi } from "vitest";

import {
  reconcileGmailDelivery,
  type GmailReconciliationFence,
} from "../gmail-reconciliation";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

const fence: GmailReconciliationFence = {
  id: "11111111-1111-4111-8111-111111111111",
  operationId: OPERATION_ID,
  claimVersion: 4,
  userId: "learner-1",
  deliveryScopeKey: "a:learner-1",
  claimToken: null,
  claimOwner: null,
  leaseExpiresAt: null,
  adapter: "gmail",
  providerCallStartedAt: "2026-07-22 19:00:05+00",
  quarantinedAt: "2026-07-22 19:01:05+00",
  lastErrorCode: "PROVIDER_OUTCOME_AMBIGUOUS",
};

function harness() {
  const findGmailReconciliationFence = vi.fn(async () => ({
    kind: "ready" as const,
    fence,
  }));
  const finalizeGmailReconciliation = vi.fn(async () => ({
    kind: "applied" as const,
  }));
  const findByMessageId = vi.fn(async () => ({
    kind: "matched" as const,
    providerMessageId: "gmail-message-1",
  }));
  return {
    store: {
      findGmailReconciliationFence,
      finalizeGmailReconciliation,
    },
    gmail: { findByMessageId },
    findGmailReconciliationFence,
    finalizeGmailReconciliation,
    findByMessageId,
  };
}

describe("Gmail outbox reconciliation", () => {
  it("searches only after a durable fence and finalizes the unique match under that exact fence", async () => {
    const input = harness();

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: true,
      confirmOperationId: OPERATION_ID,
    }, input)).resolves.toEqual({ kind: "applied" });

    expect(input.findGmailReconciliationFence).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
    });
    expect(input.findByMessageId).toHaveBeenCalledWith(
      "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>",
    );
    expect(input.finalizeGmailReconciliation).toHaveBeenCalledWith({
      fence,
      providerMessageId: "gmail-message-1",
    });
  });

  it("does not query Gmail when no exact quarantined fence is available", async () => {
    const input = harness();
    input.findGmailReconciliationFence.mockResolvedValueOnce({
      kind: "not-reconcilable",
    } as never);

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: false,
    }, input)).resolves.toEqual({ kind: "not-reconcilable" });

    expect(input.findByMessageId).not.toHaveBeenCalled();
    expect(input.finalizeGmailReconciliation).not.toHaveBeenCalled();
  });

  it("short-circuits an exact terminal replay as already applied", async () => {
    const input = harness();
    input.findGmailReconciliationFence.mockResolvedValueOnce({
      kind: "already-applied",
    } as never);

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: true,
      confirmOperationId: OPERATION_ID,
    }, input)).resolves.toEqual({ kind: "already-applied" });

    expect(input.findByMessageId).not.toHaveBeenCalled();
    expect(input.finalizeGmailReconciliation).not.toHaveBeenCalled();
  });

  it("keeps a unique dry-run match quarantined until explicitly confirmed", async () => {
    const input = harness();

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: false,
    }, input)).resolves.toEqual({ kind: "matched" });

    expect(input.finalizeGmailReconciliation).not.toHaveBeenCalled();
  });

  it("never finalizes zero or ambiguous Gmail matches", async () => {
    for (const kind of ["not-found", "ambiguous"] as const) {
      const input = harness();
      input.findByMessageId.mockResolvedValueOnce({ kind } as never);

      await expect(reconcileGmailDelivery({
        operationId: OPERATION_ID,
        apply: true,
        confirmOperationId: OPERATION_ID,
      }, input)).resolves.toEqual({ kind });

      expect(input.finalizeGmailReconciliation).not.toHaveBeenCalled();
    }
  });
});
