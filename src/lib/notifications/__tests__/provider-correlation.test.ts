import { describe, expect, it } from "vitest";

import {
  outboxCorrelationToken,
  outboxMessageId,
} from "../provider-correlation";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "okd-aMXCHPuS1pgnjdYfjG17CU5nfw-6stQE23enb8Q";
const MESSAGE_ID =
  `<codestead.outbox.v1.${TOKEN}@mail.codestead.invalid>`;
const UTF8_UUID_BASE64URL = Buffer.from(OPERATION_ID, "utf8").toString(
  "base64url",
);
const BINARY_UUID_BASE64URL = Buffer.from(
  OPERATION_ID.replaceAll("-", ""),
  "hex",
).toString("base64url");

describe("opaque provider correlation", () => {
  it("derives the fixed v1 domain-separated correlation vector", () => {
    expect(outboxCorrelationToken(OPERATION_ID)).toBe(TOKEN);
    expect(outboxMessageId(OPERATION_ID)).toBe(MESSAGE_ID);
  });

  it("keeps raw and base64url UUID canaries out of public correlation bytes", () => {
    const serialized = JSON.stringify({
      token: outboxCorrelationToken(OPERATION_ID),
      messageId: outboxMessageId(OPERATION_ID),
    });

    expect(serialized).not.toContain(OPERATION_ID);
    expect(serialized).not.toContain(OPERATION_ID.replaceAll("-", ""));
    expect(serialized).not.toContain(UTF8_UUID_BASE64URL);
    expect(serialized).not.toContain(BINARY_UUID_BASE64URL);
  });

  it.each([
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    `{${OPERATION_ID}}`,
    OPERATION_ID.replace("-4222-", "-6222-"),
    OPERATION_ID.replace(/.$/u, ""),
    ` ${OPERATION_ID}`,
  ])("rejects non-canonical operation UUID input %s", (operationId) => {
    expect(() => outboxCorrelationToken(operationId)).toThrow(
      "Outbox operation ID must be a canonical UUID.",
    );
    expect(() => outboxMessageId(operationId)).toThrow(
      "Outbox operation ID must be a canonical UUID.",
    );
  });

  it("separates distinct persisted operation identities", () => {
    expect(outboxCorrelationToken(
      "55555555-5555-4555-8555-555555555555",
    )).not.toBe(TOKEN);
  });
});
