import { describe, expect, it } from "vitest";

import { inferInterestCategory, INTEREST_CATEGORIES } from "../interests";

describe("interest-category suggestions", () => {
  it.each([
    ["baking sourdough", "cooking"],
    ["Formula 1 cars", "cars"],
    ["playing chess", "games"],
    ["cricket", "sports"],
    ["guitar songs", "music"],
    ["digital painting", "art"],
    ["mountain trekking", "travel"],
    ["building robots", "technology"],
    ["collecting stamps", "everyday-life"],
  ])("suggests %s as %s", (label, expected) => {
    expect(inferInterestCategory(label)).toBe(expected);
  });

  it("returns only a learner-correctable allowlisted category", () => {
    for (const label of ["unknown", "<script>alert(1)</script>", "🚀 space"]) {
      expect(INTEREST_CATEGORIES).toContain(inferInterestCategory(label));
    }
  });
});
