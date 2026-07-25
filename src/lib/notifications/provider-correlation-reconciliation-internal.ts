import {
  LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
  outboxCorrelationToken,
  outboxMessageId,
  type ProviderCorrelationVersion,
} from "./provider-correlation";

/**
 * Recovery-only compatibility formatter. Production sends use
 * `outboxMessageId` directly and can therefore never select the legacy form.
 */
export function outboxReconciliationMessageId(
  operationId: string,
  version: ProviderCorrelationVersion,
) {
  if (version === OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION) {
    return outboxMessageId(operationId);
  }
  if (version === LEGACY_RAW_PROVIDER_CORRELATION_VERSION) {
    // Validation is intentionally shared with the opaque formatter.
    outboxCorrelationToken(operationId);
    return `<codestead.outbox.${operationId}@mail.codestead.invalid>`;
  }
  throw new Error("Outbox provider correlation version is invalid.");
}
