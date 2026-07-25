import { describe, expect, it } from "vitest";

import {
  LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
  OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
} from "../provider-correlation";
import { outboxReconciliationMessageId } from
  "../provider-correlation-reconciliation-internal";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";

describe("persisted provider correlation version", () => {
  it("derives the frozen opaque v1 Message-ID", () => {
    const messageId = outboxReconciliationMessageId(
      OPERATION_ID,
      OPAQUE_SHA256_PROVIDER_CORRELATION_VERSION,
    );

    expect(messageId).toBe(
      "<codestead.outbox.v1.okd-aMXCHPuS1pgnjdYfjG17CU5nfw-6stQE23enb8Q@mail.codestead.invalid>",
    );
    expect(messageId).not.toContain(OPERATION_ID);
  });

  it("reconstructs raw UUID correlation only for an explicit legacy version", () => {
    expect(outboxReconciliationMessageId(
      OPERATION_ID,
      LEGACY_RAW_PROVIDER_CORRELATION_VERSION,
    )).toBe(
      `<codestead.outbox.${OPERATION_ID}@mail.codestead.invalid>`,
    );
  });

  it("fails closed for an unknown persisted correlation version", () => {
    expect(() => outboxReconciliationMessageId(
      OPERATION_ID,
      "future-unreviewed-v2" as never,
    )).toThrow("Outbox provider correlation version is invalid.");
  });
});
