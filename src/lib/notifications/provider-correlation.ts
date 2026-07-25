import { createHash } from "node:crypto";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CORRELATION_DOMAIN =
  "codestead.mail.provider-correlation.v1";

export const LEGACY_RAW_PROVIDER_CORRELATION_VERSION =
  "legacy-raw-v0" as const;
export const OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION =
  "opaque-sha256-v1" as const;
export type ProviderCorrelationVersion =
  | typeof LEGACY_RAW_PROVIDER_CORRELATION_VERSION
  | typeof OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION;

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: string,
) {
  hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8");
  hash.update(value, "utf8");
}

function assertCanonicalOperationId(operationId: string) {
  if (
    typeof operationId !== "string" ||
    !CANONICAL_UUID.test(operationId)
  ) {
    throw new Error("Outbox operation ID must be a canonical UUID.");
  }
  return operationId;
}

export function outboxCorrelationToken(operationId: string) {
  const canonicalOperationId = assertCanonicalOperationId(operationId);
  const hash = createHash("sha256");
  updateLengthFramed(hash, CORRELATION_DOMAIN);
  updateLengthFramed(hash, canonicalOperationId);
  return hash.digest("base64url");
}

export function outboxMessageId(operationId: string) {
  return `<codestead.outbox.v1.${outboxCorrelationToken(operationId)}@mail.codestead.invalid>`;
}
