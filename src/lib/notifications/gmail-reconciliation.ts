import { outboxMessageId } from "./provider-correlation";

export type GmailReconciliationFence = Readonly<{
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
  }>): Promise<
    | { readonly kind: "applied" }
    | { readonly kind: "already-applied" }
    | { readonly kind: "lost" }
  >;
}

export interface GmailCorrelationLookup {
  findByMessageId(messageId: string): Promise<
    | { readonly kind: "not-found" }
    | { readonly kind: "ambiguous" }
    | { readonly kind: "matched"; readonly providerMessageId: string }
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
  );
  if (lookup.kind !== "matched") return lookup;
  if (!input.apply) return { kind: "matched" };

  const finalized = await deps.store.finalizeGmailReconciliation({
    fence: candidate.fence,
    providerMessageId: lookup.providerMessageId,
  });
  return finalized.kind === "lost" ? { kind: "fence-lost" } : finalized;
}
