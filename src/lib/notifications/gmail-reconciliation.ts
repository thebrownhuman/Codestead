import type { ProviderCorrelationVersion } from "./provider-correlation";
import { outboxReconciliationMessageId } from
  "./provider-correlation-reconciliation-internal";

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

export type GmailReconciliationAuthority =
  | { readonly kind: "legacy-unbound-v0" }
  | {
      readonly kind: "legacy-raw-bound-v1";
      readonly adapterPayloadSha256: string;
    }
  | {
      readonly kind: "opaque-header-v1";
      readonly operationId: string;
      readonly adapterPayloadSha256: string;
      readonly providerEvidenceSha256: string;
    };

export type GmailReconciliationProof =
  | { readonly kind: "legacy-discovery-v0" }
  | {
      readonly kind: "raw-sha256-v1";
      readonly adapterPayloadSha256: string;
    }
  | {
      readonly kind: "header-evidence-v1";
      readonly providerEvidenceSha256: string;
    };

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
  dispatchBindingVersion: "gmail-raw-v1" | null;
  dispatchBindingSha256: string | null;
  providerCorrelationVersion: ProviderCorrelationVersion;
  providerEvidenceVersion: "gmail-header-evidence-v1" | null;
  providerEvidenceSha256: string | null;
  providerRequestBodySha256: string | null;
  providerRequestBodyLength: number | null;
  releaseReceiptSha256: string | null;
  quarantinedAt: string;
  lastErrorCode: string;
}>;

export function gmailReconciliationAuthority(
  fence: GmailReconciliationFence,
): GmailReconciliationAuthority | null {
  if (fence.providerCorrelationVersion === "legacy-raw-v0") {
    if (
      fence.providerEvidenceVersion !== null
      || fence.providerEvidenceSha256 !== null
      || fence.providerRequestBodySha256 !== null
      || fence.providerRequestBodyLength !== null
      || typeof fence.releaseReceiptSha256 !== "string"
      || !LOWERCASE_SHA256.test(fence.releaseReceiptSha256)
    ) return null;
    if (
      fence.dispatchBindingVersion === null
      && fence.dispatchBindingSha256 === null
    ) return { kind: "legacy-unbound-v0" };
    if (
      fence.dispatchBindingVersion === "gmail-raw-v1"
      && typeof fence.dispatchBindingSha256 === "string"
      && LOWERCASE_SHA256.test(fence.dispatchBindingSha256)
    ) {
      return {
        kind: "legacy-raw-bound-v1",
        adapterPayloadSha256: fence.dispatchBindingSha256,
      };
    }
    return null;
  }
  if (
    fence.providerCorrelationVersion !== "opaque-sha256-v1"
    || fence.dispatchBindingVersion !== "gmail-raw-v1"
    || typeof fence.dispatchBindingSha256 !== "string"
    || !LOWERCASE_SHA256.test(fence.dispatchBindingSha256)
    || fence.providerEvidenceVersion !== "gmail-header-evidence-v1"
    || typeof fence.providerEvidenceSha256 !== "string"
    || !LOWERCASE_SHA256.test(fence.providerEvidenceSha256)
    || typeof fence.providerRequestBodySha256 !== "string"
    || !LOWERCASE_SHA256.test(fence.providerRequestBodySha256)
    || !Number.isSafeInteger(fence.providerRequestBodyLength)
    || fence.providerRequestBodyLength! < 0
    || typeof fence.releaseReceiptSha256 !== "string"
    || !LOWERCASE_SHA256.test(fence.releaseReceiptSha256)
  ) return null;
  return {
    kind: "opaque-header-v1",
    operationId: fence.operationId,
    adapterPayloadSha256: fence.dispatchBindingSha256,
    providerEvidenceSha256: fence.providerEvidenceSha256,
  };
}

export function gmailProofAuthorizesFence(
  authority: GmailReconciliationAuthority,
  proof: GmailReconciliationProof,
) {
  return (
    (authority.kind === "legacy-raw-bound-v1"
      && proof.kind === "raw-sha256-v1"
      && proof.adapterPayloadSha256 === authority.adapterPayloadSha256)
    || (authority.kind === "opaque-header-v1"
      && proof.kind === "header-evidence-v1"
      && proof.providerEvidenceSha256 === authority.providerEvidenceSha256)
  );
}

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
    proof: GmailReconciliationProof;
  }>): Promise<
    | { readonly kind: "applied" }
    | { readonly kind: "already-applied" }
    | { readonly kind: "lost" }
  >;
}

export interface GmailCorrelationLookup {
  findByMessageId(input: Readonly<{
    messageId: string;
    authority: GmailReconciliationAuthority;
  }>): Promise<
    | { readonly kind: "not-found" }
    | { readonly kind: "ambiguous" }
    | {
        readonly kind: "matched";
        readonly providerMessageId: string;
        readonly proof: GmailReconciliationProof;
      }
  >;
}

export type GmailReconciliationResult =
  | { readonly kind: "not-reconcilable" }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "matched" }
  | { readonly kind: "unverified-discovery" }
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

  if (
    typeof candidate.fence.providerCallStartedAt !== "string"
    || candidate.fence.providerCallStartedAt.trim() === ""
  ) {
    return { kind: "not-reconcilable" };
  }

  const authority = gmailReconciliationAuthority(candidate.fence);
  if (authority === null) {
    return { kind: "not-reconcilable" };
  }
  let correlationMessageId: string;
  try {
    correlationMessageId = outboxReconciliationMessageId(
      candidate.fence.operationId,
      candidate.fence.providerCorrelationVersion,
    );
  } catch {
    return { kind: "not-reconcilable" };
  }
  const lookup = await deps.gmail.findByMessageId(
    { messageId: correlationMessageId, authority },
  );
  if (lookup.kind !== "matched") return lookup;
  if (authority.kind === "legacy-unbound-v0") {
    return lookup.proof.kind === "legacy-discovery-v0"
      ? { kind: "unverified-discovery" }
      : { kind: "ambiguous" };
  }
  if (!gmailProofAuthorizesFence(authority, lookup.proof)) {
    return { kind: "ambiguous" };
  }
  if (!input.apply) return { kind: "matched" };

  const finalized = await deps.store.finalizeGmailReconciliation({
    fence: candidate.fence,
    providerMessageId: lookup.providerMessageId,
    proof: lookup.proof,
  });
  return finalized.kind === "lost" ? { kind: "fence-lost" } : finalized;
}
