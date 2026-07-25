import { createHash } from "node:crypto";

import {
  outboxCorrelationToken,
  PROVIDER_CORRELATION_VERSION,
  type ProviderCorrelationVersion,
} from "./provider-correlation";
import type { ProviderPayloadSha256 } from "./prepared-dispatch";

const DISPATCH_EVIDENCE_DOMAIN =
  "codestead.mail.dispatch-evidence.v1";
const EVIDENCE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const PROVIDER_EVIDENCE_VERSION =
  "gmail-header-evidence-v1" as const;
export type ProviderEvidenceVersion = typeof PROVIDER_EVIDENCE_VERSION;

declare const dispatchEvidenceSha256Brand: unique symbol;

export type DispatchEvidenceSha256 = string & Readonly<{
  [dispatchEvidenceSha256Brand]: "DispatchEvidenceSha256";
}>;

export type DispatchEvidenceInput = Readonly<{
  operationId: string;
  providerCorrelationVersion: ProviderCorrelationVersion;
  providerCorrelationToken: string;
  dispatchBindingVersion: "gmail-raw-v1";
  adapterPayloadSha256: ProviderPayloadSha256;
  providerEvidenceVersion: ProviderEvidenceVersion;
  evidenceToken: string;
}>;

function invalidEvidence(): never {
  throw new Error("Dispatch evidence input is invalid.");
}

function canonicalInput(value: unknown): DispatchEvidenceInput {
  try {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) invalidEvidence();
    const keys = Reflect.ownKeys(value);
    const expected = [
      "adapterPayloadSha256",
      "dispatchBindingVersion",
      "evidenceToken",
      "operationId",
      "providerCorrelationToken",
      "providerCorrelationVersion",
      "providerEvidenceVersion",
    ];
    if (
      keys.some((key) => typeof key !== "string")
      || keys.length !== expected.length
      || [...keys].sort().some((key, index) => key !== expected[index])
    ) invalidEvidence();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const fields: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) invalidEvidence();
      fields[key] = descriptor.value;
    }
    if (
      typeof fields.operationId !== "string"
      || fields.providerCorrelationVersion !== PROVIDER_CORRELATION_VERSION
      || typeof fields.providerCorrelationToken !== "string"
      || fields.dispatchBindingVersion !== "gmail-raw-v1"
      || typeof fields.adapterPayloadSha256 !== "string"
      || !SHA256_HEX.test(fields.adapterPayloadSha256)
      || fields.providerEvidenceVersion !== PROVIDER_EVIDENCE_VERSION
      || typeof fields.evidenceToken !== "string"
      || !EVIDENCE_TOKEN.test(fields.evidenceToken)
    ) invalidEvidence();
    const evidenceBytes = Buffer.from(fields.evidenceToken, "base64url");
    if (
      evidenceBytes.length !== 32
      || evidenceBytes.toString("base64url") !== fields.evidenceToken
      || outboxCorrelationToken(fields.operationId)
        !== fields.providerCorrelationToken
    ) invalidEvidence();
    return Object.freeze({
      operationId: fields.operationId,
      providerCorrelationVersion: fields.providerCorrelationVersion,
      providerCorrelationToken: fields.providerCorrelationToken,
      dispatchBindingVersion: fields.dispatchBindingVersion,
      adapterPayloadSha256: fields.adapterPayloadSha256,
      providerEvidenceVersion: fields.providerEvidenceVersion,
      evidenceToken: fields.evidenceToken,
    }) as DispatchEvidenceInput;
  } catch (error) {
    if (error instanceof Error && error.message === "Dispatch evidence input is invalid.") {
      throw error;
    }
    return invalidEvidence();
  }
}

function updateLengthFramed(
  hash: ReturnType<typeof createHash>,
  value: string,
) {
  hash.update(`${Buffer.byteLength(value, "utf8")}:`, "utf8");
  hash.update(value, "utf8");
}

export function dispatchEvidenceSha256(
  input: DispatchEvidenceInput,
): DispatchEvidenceSha256 {
  const canonical = canonicalInput(input);
  const hash = createHash("sha256");
  for (const field of [
    DISPATCH_EVIDENCE_DOMAIN,
    canonical.operationId,
    canonical.providerCorrelationVersion,
    canonical.providerCorrelationToken,
    canonical.dispatchBindingVersion,
    canonical.adapterPayloadSha256,
    canonical.providerEvidenceVersion,
    canonical.evidenceToken,
  ]) updateLengthFramed(hash, field);
  return hash.digest("hex") as DispatchEvidenceSha256;
}