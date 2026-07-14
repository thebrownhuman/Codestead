import { describe, expect, it } from "vitest";

import { assertAuditMetadataSafe, hashAuditEvent, nextAuditTimestamp } from "../audit";

describe("audit integrity", () => {
  it("produces stable chained hashes", () => {
    const event = { action: "credential.reveal", metadata: { provider: "nvidia" } };
    expect(hashAuditEvent(event, null)).toBe(hashAuditEvent(event, null));
    expect(hashAuditEvent(event, "prior")).not.toBe(hashAuditEvent(event, null));
  });

  it("rejects secret material and suspicious keys", () => {
    expect(() => assertAuditMetadataSafe({ apiKey: "redacted" })).toThrow();
    expect(() =>
      assertAuditMetadataSafe({ note: "nvapi-this-should-never-be-logged" }),
    ).toThrow();
    expect(() => hashAuditEvent({ reason: "nvapi-do-not-log-this-value", metadata: {} }, null))
      .toThrow();
  });

  it("accepts fallback spending metadata without secret-like field names", () => {
    expect(assertAuditMetadataSafe({
      provider: "openai",
      model: "approved/fallback-model",
      usageUnitLimit: 20_000,
      currencyLimitPaise: 10_000,
      inputRatePaisePerMillionUnits: 10_000,
      outputRatePaisePerMillionUnits: 20_000,
      expiresAt: "2026-07-13T00:00:00.000Z",
    })).toMatchObject({ usageUnitLimit: 20_000, currencyLimitPaise: 10_000 });
  });

  it("keeps the serialized chain timestamp strictly monotonic", () => {
    const previous = new Date("2026-07-12T04:00:00.500Z");
    expect(nextAuditTimestamp(previous, previous.getTime() - 5_000).getTime())
      .toBe(previous.getTime() + 1);
    expect(nextAuditTimestamp(previous, previous.getTime() + 10).getTime())
      .toBe(previous.getTime() + 10);
  });
});
