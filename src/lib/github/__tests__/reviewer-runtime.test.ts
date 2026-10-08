import { expect, it, vi } from "vitest";

vi.mock("typescript", () => { throw new Error("Reviewer runtime imported a development dependency"); });

it("loads the reviewer and correction worker module graph without TypeScript", async () => {
  await expect(import("../reviewer")).resolves.toHaveProperty("reviewPublicRepository");
  await expect(import("../../projects/review-correction-service")).resolves.toHaveProperty("processProjectReviewCorrectionBatch");
});
