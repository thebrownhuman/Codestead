import { describe, expect, it } from "vitest";

import { approvedLabel, reviewApprovalSummary, reviewedLabel } from "../review-approval-labels";

describe("review-approval-labels", () => {
  it("labels approved counts distinctly from reviewed counts", () => {
    expect(approvedLabel(0, 81)).toBe("0/81 approved");
    expect(reviewedLabel(81, 81)).toBe("81/81 reviewed");
  });

  it("combines both into one consistent summary", () => {
    expect(reviewApprovalSummary({ reviewedCount: 81, approvedCount: 0, artifactCount: 81 }))
      .toBe("81/81 reviewed · 0/81 approved");
  });
});
