import { describe, expect, it, vi } from "vitest";

import {
  reconcileGmailDelivery,
  type GmailReconciliationFence,
} from "../gmail-reconciliation";
import {
  LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
} from "../provider-correlation";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const PAYLOAD_SHA256 = "b".repeat(64);
const EVIDENCE_SHA256 = "c".repeat(64);
const PROVIDER_REQUEST_BODY_SHA256 = "d".repeat(64);
const RELEASE_RECEIPT_SHA256 = "e".repeat(64);

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
  dispatchBindingVersion: null,
  dispatchBindingSha256: null,
  providerCorrelationVersion: LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
  providerEvidenceVersion: null,
  providerEvidenceSha256: null,
  providerRequestBodySha256: null,
  providerRequestBodyLength: null,
  releaseReceiptSha256: RELEASE_RECEIPT_SHA256,
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
    proof: { kind: "legacy-discovery-v0" as const },
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
  it("lets class A discover/report but never auto-finalizes legacy-unbound mail", async () => {
    const input = harness();

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: true,
      confirmOperationId: OPERATION_ID,
    }, input)).resolves.toEqual({
      kind: "unverified-discovery",
    });

    expect(input.findGmailReconciliationFence).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
    });
    expect(input.findByMessageId).toHaveBeenCalledWith(
      {
        messageId:
          "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>",
        authority: { kind: "legacy-unbound-v0" },
      },
    );
    expect(input.finalizeGmailReconciliation).not.toHaveBeenCalled();
  });

  it("finalizes class B only with an exact decoded RAW SHA proof", async () => {
    const input = harness();
    const boundFence = {
      ...fence,
      dispatchBindingVersion: "gmail-raw-v1" as const,
      dispatchBindingSha256: PAYLOAD_SHA256,
    };
    input.findGmailReconciliationFence.mockResolvedValueOnce({
      kind: "ready",
      fence: boundFence,
    } as never);
    const proof = {
      kind: "raw-sha256-v1" as const,
      adapterPayloadSha256: PAYLOAD_SHA256,
    };
    input.findByMessageId.mockResolvedValueOnce({
      kind: "matched",
      providerMessageId: "gmail-message-1",
      proof,
    } as never);

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: true,
      confirmOperationId: OPERATION_ID,
    }, input)).resolves.toEqual({ kind: "applied" });

    expect(input.findByMessageId).toHaveBeenCalledWith(
      {
        messageId:
          "<codestead.outbox.22222222-2222-4222-8222-222222222222@mail.codestead.invalid>",
        authority: {
          kind: "legacy-raw-bound-v1",
          adapterPayloadSha256: PAYLOAD_SHA256,
        },
      },
    );
    expect(input.finalizeGmailReconciliation).toHaveBeenCalledWith({
      fence: boundFence,
      providerMessageId: "gmail-message-1",
      proof,
    });
  });

  it("finalizes class C only with the frozen opaque ID and exact header-evidence proof", async () => {
    const input = harness();
    const opaqueFence = {
      ...fence,
      dispatchBindingVersion: "gmail-raw-v1" as const,
      dispatchBindingSha256: PAYLOAD_SHA256,
      providerCorrelationVersion:
        OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
      providerEvidenceVersion: "gmail-header-evidence-v1" as const,
      providerEvidenceSha256: EVIDENCE_SHA256,
      providerRequestBodySha256: PROVIDER_REQUEST_BODY_SHA256,
      providerRequestBodyLength: 128,
      releaseReceiptSha256: RELEASE_RECEIPT_SHA256,
    };
    input.findGmailReconciliationFence.mockResolvedValueOnce({
      kind: "ready",
      fence: opaqueFence,
    } as never);
    const proof = {
      kind: "header-evidence-v1" as const,
      providerEvidenceSha256: EVIDENCE_SHA256,
    };
    input.findByMessageId.mockResolvedValueOnce({
      kind: "matched",
      providerMessageId: "gmail-message-1",
      proof,
    } as never);

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: true,
      confirmOperationId: OPERATION_ID,
    }, input)).resolves.toEqual({ kind: "applied" });

    expect(input.findByMessageId).toHaveBeenCalledWith({
      messageId:
        "<codestead.outbox.v1.okd-aMXCHPuS1pgnjdYfjG17CU5nfw-6stQE23enb8Q@mail.codestead.invalid>",
      authority: {
        kind: "opaque-header-v1",
        operationId: OPERATION_ID,
        adapterPayloadSha256: PAYLOAD_SHA256,
        providerEvidenceSha256: EVIDENCE_SHA256,
      },
    });
    expect(input.finalizeGmailReconciliation).toHaveBeenCalledWith({
      fence: opaqueFence,
      providerMessageId: "gmail-message-1",
      proof,
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

  it.each([
    {
      name: "a null provider-call timestamp",
      patch: { providerCallStartedAt: null },
    },
    {
      name: "a blank provider-call timestamp",
      patch: { providerCallStartedAt: " " },
    },
    {
      name: "a null persisted correlation version",
      patch: { providerCorrelationVersion: null },
    },
    {
      name: "an unknown persisted correlation version",
      patch: { providerCorrelationVersion: "future-unreviewed-v2" },
    },
    {
      name: "a missing legacy release receipt",
      patch: { releaseReceiptSha256: null },
    },
  ])("never queries Gmail for $name", async ({ patch }) => {
    const input = harness();
    input.findGmailReconciliationFence.mockResolvedValueOnce({
      kind: "ready",
      fence: { ...fence, ...patch },
    } as never);

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: false,
    }, input)).resolves.toEqual({ kind: "not-reconcilable" });

    expect(input.findByMessageId).not.toHaveBeenCalled();
    expect(input.finalizeGmailReconciliation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a null request-body digest",
      patch: { providerRequestBodySha256: null },
    },
    {
      name: "a malformed request-body digest",
      patch: { providerRequestBodySha256: "not-a-digest" },
    },
    {
      name: "a null request-body length",
      patch: { providerRequestBodyLength: null },
    },
    {
      name: "a negative request-body length",
      patch: { providerRequestBodyLength: -1 },
    },
    {
      name: "an unsafe request-body length",
      patch: { providerRequestBodyLength: Number.MAX_SAFE_INTEGER + 1 },
    },
    {
      name: "a null release receipt",
      patch: { releaseReceiptSha256: null },
    },
    {
      name: "a malformed release receipt",
      patch: { releaseReceiptSha256: "not-a-digest" },
    },
  ])("never queries Gmail for opaque mail with $name", async ({ patch }) => {
    const input = harness();
    input.findGmailReconciliationFence.mockResolvedValueOnce({
      kind: "ready",
      fence: {
        ...fence,
        dispatchBindingVersion: "gmail-raw-v1",
        dispatchBindingSha256: PAYLOAD_SHA256,
        providerCorrelationVersion:
          OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
        providerEvidenceVersion: "gmail-header-evidence-v1",
        providerEvidenceSha256: EVIDENCE_SHA256,
        providerRequestBodySha256: PROVIDER_REQUEST_BODY_SHA256,
        providerRequestBodyLength: 128,
        releaseReceiptSha256: RELEASE_RECEIPT_SHA256,
        ...patch,
      },
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
    input.findGmailReconciliationFence.mockResolvedValueOnce({
      kind: "ready",
      fence: {
        ...fence,
        dispatchBindingVersion: "gmail-raw-v1",
        dispatchBindingSha256: PAYLOAD_SHA256,
      },
    } as never);
    input.findByMessageId.mockResolvedValueOnce({
      kind: "matched",
      providerMessageId: "gmail-message-1",
      proof: {
        kind: "raw-sha256-v1",
        adapterPayloadSha256: PAYLOAD_SHA256,
      },
    } as never);

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: false,
    }, input)).resolves.toEqual({ kind: "matched" });

    expect(input.finalizeGmailReconciliation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a mismatched class-B RAW digest",
      fence: {
        ...fence,
        dispatchBindingVersion: "gmail-raw-v1",
        dispatchBindingSha256: PAYLOAD_SHA256,
      },
      proof: {
        kind: "raw-sha256-v1",
        adapterPayloadSha256: "d".repeat(64),
      },
    },
    {
      name: "a mismatched class-C evidence digest",
      fence: {
        ...fence,
        dispatchBindingVersion: "gmail-raw-v1",
        dispatchBindingSha256: PAYLOAD_SHA256,
        providerCorrelationVersion:
          OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
        providerEvidenceVersion: "gmail-header-evidence-v1",
        providerEvidenceSha256: EVIDENCE_SHA256,
        providerRequestBodySha256: PROVIDER_REQUEST_BODY_SHA256,
        providerRequestBodyLength: 128,
        releaseReceiptSha256: RELEASE_RECEIPT_SHA256,
      },
      proof: {
        kind: "header-evidence-v1",
        providerEvidenceSha256: "d".repeat(64),
      },
    },
  ])("never finalizes $name", async ({ fence: candidateFence, proof }) => {
    const input = harness();
    input.findGmailReconciliationFence.mockResolvedValueOnce({
      kind: "ready",
      fence: candidateFence,
    } as never);
    input.findByMessageId.mockResolvedValueOnce({
      kind: "matched",
      providerMessageId: "gmail-message-1",
      proof,
    } as never);

    await expect(reconcileGmailDelivery({
      operationId: OPERATION_ID,
      apply: true,
      confirmOperationId: OPERATION_ID,
    }, input)).resolves.toEqual({ kind: "ambiguous" });
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
