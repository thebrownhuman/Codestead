import { describe, expect, it } from "vitest";

import {
  dispatchEvidenceSha256,
  PROVIDER_EVIDENCE_VERSION,
  type DispatchEvidenceInput,
} from "../dispatch-evidence";
import {
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
  outboxCorrelationToken,
} from "../provider-correlation";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_TOKEN = "A".repeat(43);

function evidenceInput(
  overrides: Partial<DispatchEvidenceInput> = {},
): DispatchEvidenceInput {
  return {
    operationId: OPERATION_ID,
    providerCorrelationVersion:
      OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
    providerCorrelationToken: outboxCorrelationToken(OPERATION_ID),
    dispatchBindingVersion: "gmail-raw-v1",
    adapterPayloadSha256: "b".repeat(64),
    providerEvidenceVersion: PROVIDER_EVIDENCE_VERSION,
    evidenceToken: EVIDENCE_TOKEN,
    ...overrides,
  };
}

describe("dispatch evidence digest", () => {
  it("matches the frozen eight-field length-framed vector", () => {
    expect(dispatchEvidenceSha256(evidenceInput())).toBe(
      "6889a4e92ed4f994f2f039da46e2a9d482c8162d1ef9cc1050664b965a7c9d80",
    );
  });

  it("binds both the final adapter bytes and the exact random header token", () => {
    const canonical = dispatchEvidenceSha256(evidenceInput());
    expect(dispatchEvidenceSha256(evidenceInput({
      adapterPayloadSha256: "c".repeat(64),
    }))).not.toBe(canonical);
    expect(dispatchEvidenceSha256(evidenceInput({
      evidenceToken: Buffer.alloc(32, 1).toString("base64url"),
    }))).not.toBe(canonical);
  });

  it.each([
    { providerCorrelationToken: "A".repeat(43) },
    { operationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    { providerCorrelationVersion: "legacy-raw-v0" },
    { dispatchBindingVersion: "legacy-raw-v0" },
    { providerEvidenceVersion: "gmail-header-evidence-v2" },
    { adapterPayloadSha256: "B".repeat(64) },
    { evidenceToken: "A".repeat(42) },
    { evidenceToken: `${"A".repeat(42)}=` },
  ])("rejects a noncanonical field set %#", (overrides) => {
    expect(() => dispatchEvidenceSha256({
      ...evidenceInput(),
      ...overrides,
    } as DispatchEvidenceInput)).toThrow(
      "Dispatch evidence input is invalid.",
    );
  });

  it("rejects accessors without invoking them", () => {
    let reads = 0;
    const input = evidenceInput() as Record<string, unknown>;
    Object.defineProperty(input, "evidenceToken", {
      enumerable: true,
      get() {
        reads += 1;
        return EVIDENCE_TOKEN;
      },
    });
    expect(() => dispatchEvidenceSha256(
      input as DispatchEvidenceInput,
    )).toThrow("Dispatch evidence input is invalid.");
    expect(reads).toBe(0);
  });
});
