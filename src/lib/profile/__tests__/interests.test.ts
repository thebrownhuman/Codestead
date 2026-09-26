import { describe, expect, it } from "vitest";

import {
  inferInterestCategory,
  INTEREST_CATEGORIES,
  INTEREST_CATEGORY_EXAMPLES,
  isRecognizedInterest,
  junkInterestReason,
} from "../interests";

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
    ["cats", "animals"],
    ["my dog", "animals"],
    ["gardening", "nature"],
    ["astronomy", "science"],
    ["collecting stamps", "everyday-life"],
  ])("suggests %s as %s", (label, expected) => {
    expect(inferInterestCategory(label)).toBe(expected);
  });

  it("returns only a learner-correctable allowlisted category", () => {
    for (const label of ["unknown", "<script>alert(1)</script>", "🚀 space"]) {
      expect(INTEREST_CATEGORIES).toContain(inferInterestCategory(label));
    }
  });

  it("flags whether a label matched a specific category or only the Other catch-all", () => {
    expect(isRecognizedInterest("cats")).toBe(true);
    expect(isRecognizedInterest("collecting stamps")).toBe(false);
  });

  it("has example chips for every category, including the Other bucket", () => {
    for (const category of INTEREST_CATEGORIES) {
      expect(INTEREST_CATEGORY_EXAMPLES[category].length).toBeGreaterThan(0);
    }
  });
});

describe("junk interest rejection", () => {
  it.each([
    ["", "It was empty."],
    ["n/a", "It doesn't describe an interest."],
    ["idk", "It doesn't describe an interest."],
    ["123", "It needs at least one letter."],
    ["<script>", "It can't contain markup."],
    ["aaaa", "It looks like a repeated character, not an interest."],
  ])("rejects %j with a reason", (label, expectedReason) => {
    expect(junkInterestReason(label)).toBe(expectedReason);
  });

  it("accepts real interests, including short and unrecognized ones, without a reason", () => {
    for (const label of ["cats", "F1", "collecting stamps"]) {
      expect(junkInterestReason(label)).toBeNull();
    }
  });
});
