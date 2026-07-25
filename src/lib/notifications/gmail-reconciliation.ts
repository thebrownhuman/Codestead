import { outboxMessageId } from "./provider-correlation";
import type { ProviderPayloadSha256 } from "./prepared-dispatch";

export type GmailReconciliationDispatchBinding =
  | Readonly<{
      kind: "legacy-unbound";
      bindingVersion: null;
      bindingSha256: null;
    }>
  | Readonly<{
      kind: "exact-bound";
      bindingVersion: "gmail-raw-v1";
      bindingSha256: ProviderPayloadSha256;
    }>;

type GmailReconciliationFenceBase = Readonly<{
  id: string;
  operationId: string;
  claimVersion: number;
  userId: string | null;
  deliveryScopeKey: string;
  claimToken: string | null;
  claimOwner: string | null;
  leaseExpiresAt: string | null;
  adapter: "gmail";
  providerCallStartedAt: string;
  quarantinedAt: string;
  lastErrorCode: string;
}>;

export type GmailReconciliationFence = Readonly<
  GmailReconciliationFenceBase & GmailReconciliationDispatchBinding
>;

export interface GmailReconciliationStore {
  findGmailReconciliationFence(input: Readonly<{
    operationId: string;
  }>): Promise<
    | { readonly kind: "ready"; readonly fence: GmailReconciliationFence }
    | { readonly kind: "already-applied" }
    | { readonly kind: "not-reconcilable" }
  >;

  finalizeGmailReconciliation(input: Readonly<{
    fence: GmailReconciliationFence;
    providerMessageId: string;
    bindingEvidence: GmailReconciliationDispatchBinding;
  }>): Promise<
    | { readonly kind: "applied" }
    | { readonly kind: "already-applied" }
    | { readonly kind: "lost" }
  >;
}

export interface GmailCorrelationLookup {
  findByMessageId(
    messageId: string,
    expectedBinding: GmailReconciliationDispatchBinding,
  ): Promise<
    | { readonly kind: "not-found" }
    | { readonly kind: "ambiguous" }
    | Readonly<{
        kind: "matched";
        providerMessageId: string;
        bindingEvidence: GmailReconciliationDispatchBinding;
      }>
  >;
}

export type GmailReconciliationResult =
  | { readonly kind: "not-reconcilable" }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "matched" }
  | { readonly kind: "applied" }
  | { readonly kind: "already-applied" }
  | { readonly kind: "fence-lost" };

export async function reconcileGmailDelivery(
  input: Readonly<{
    operationId: string;
    apply: boolean;
    confirmOperationId?: string;
  }>,
  deps: Readonly<{
    store: GmailReconciliationStore;
    gmail: GmailCorrelationLookup;
  }>,
): Promise<GmailReconciliationResult> {
  if (input.apply && input.confirmOperationId !== input.operationId) {
    throw new Error("Applying Gmail reconciliation requires exact operation confirmation.");
  }

  const candidate = await deps.store.findGmailReconciliationFence({
    operationId: input.operationId,
  });
  if (candidate.kind !== "ready") return candidate;

  const lookup = await deps.gmail.findByMessageId(
    outboxMessageId(candidate.fence.operationId),
    candidate.fence,
  );
  if (lookup.kind !== "matched") return lookup;
  const exactBindingEvidence =
    lookup.bindingEvidence.kind === candidate.fence.kind &&
    lookup.bindingEvidence.bindingVersion === candidate.fence.bindingVersion &&
    lookup.bindingEvidence.bindingSha256 === candidate.fence.bindingSha256;
  if (!exactBindingEvidence) return { kind: "ambiguous" };
  if (!input.apply) return { kind: "matched" };

  const finalized = await deps.store.finalizeGmailReconciliation({
    fence: candidate.fence,
    providerMessageId: lookup.providerMessageId,
    bindingEvidence: lookup.bindingEvidence,
  });
  return finalized.kind === "lost" ? { kind: "fence-lost" } : finalized;
}
