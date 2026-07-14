import { describe, expect, it } from "vitest";

import { examFinalizationRetryDelayMs } from "./finalization-worker-policy";

describe("exam finalization worker policy", () => {
  it("uses bounded deterministic exponential retry delays", () => {
    expect(examFinalizationRetryDelayMs(1)).toBe(5_000);
    expect(examFinalizationRetryDelayMs(2)).toBe(10_000);
    expect(examFinalizationRetryDelayMs(8)).toBe(600_000);
    expect(examFinalizationRetryDelayMs(100)).toBe(600_000);
  });

  it("never returns a zero or negative retry for recovered rows", () => {
    expect(examFinalizationRetryDelayMs(0)).toBe(5_000);
    expect(examFinalizationRetryDelayMs(-5)).toBe(5_000);
  });
});
