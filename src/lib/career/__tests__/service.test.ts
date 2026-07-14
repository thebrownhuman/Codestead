import { describe, expect, it } from "vitest";

import { CareerGuidanceError, normalizeCareerMarketClaim } from "../service";

const market = {
  claim: " Java roles remain visible in this reviewed regional source. ",
  sourceUrl: "https://example.org/jobs?technology=java",
  region: " India ",
  observedAt: new Date("2026-07-01T00:00:00.000Z"),
  reviewedAt: new Date("2026-07-02T00:00:00.000Z"),
  expiresAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("career market provenance", () => {
  it("normalizes a complete HTTPS claim without changing its evidence dates", () => {
    expect(normalizeCareerMarketClaim(market)).toEqual({
      ...market,
      claim: market.claim.trim(),
      region: market.region.trim(),
    });
  });

  it.each([
    ["non-HTTPS source", { ...market, sourceUrl: "http://example.org/jobs" }],
    ["credential-bearing source", { ...market, sourceUrl: "https://user:secret@example.org/jobs" }],
    ["review before observation", { ...market, reviewedAt: new Date("2026-06-30T00:00:00.000Z") }],
    ["expiry at review", { ...market, expiresAt: market.reviewedAt }],
    ["invalid date", { ...market, observedAt: new Date(Number.NaN) }],
  ])("rejects %s", (_label, value) => {
    expect(() => normalizeCareerMarketClaim(value)).toThrowError(
      expect.objectContaining<Partial<CareerGuidanceError>>({ code: "INVALID_REQUEST" }),
    );
  });

  it("represents the absence of a sourced market claim honestly", () => {
    expect(normalizeCareerMarketClaim(null)).toBeNull();
  });
});
