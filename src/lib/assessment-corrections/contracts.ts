import { z } from "zod";

const safeIdentifier = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const correctionRunnerTestSchema = z.object({
  id: safeIdentifier,
  visibility: z.enum(["VISIBLE", "HIDDEN"]),
  category: z.string().trim().min(1).max(100),
  stdin: z.string().max(65_536),
  expectedStdout: z.string().max(65_536),
  comparison: z.enum(["EXACT", "TRIMMED"]),
  critical: z.boolean(),
}).strict();

export const replacementEvidenceSchema = z.object({
  kind: z.literal("runner-tests"),
  bundleVersion: safeIdentifier,
  runtimeImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  tests: z.array(correctionRunnerTestSchema).min(1).max(200),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, test] of value.tests.entries()) {
    if (ids.has(test.id)) {
      context.addIssue({ code: "custom", path: ["tests", index, "id"], message: "Test ids must be unique." });
    }
    ids.add(test.id);
  }
});

export const correctionReviewSchema = z.object({
  reviewerKind: z.literal("human"),
  specificationClarified: z.literal(true),
  expectedOutputsReviewed: z.literal(true),
  hiddenTestCoverageReviewed: z.literal(true),
  pinnedRuntimeReviewed: z.literal(true),
  evidenceRef: z.string().trim().min(12).max(500),
  note: z.string().trim().min(20).max(2_000),
}).strict();

export const createCorrectionSchema = z.object({
  requestId: z.uuid(),
  appealId: z.uuid(),
  itemId: safeIdentifier,
  defectKind: z.enum(["faulty_test", "ambiguous_oracle", "runtime_defect"]),
  reason: z.string().trim().min(20).max(2_000),
  replacementEvidence: replacementEvidenceSchema,
  review: correctionReviewSchema,
}).strict();

export const queueCorrectionSchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(20).max(2_000),
}).strict();

export const correctionListQuerySchema = z.object({
  scope: z.enum(["open", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export type ReplacementEvidence = z.infer<typeof replacementEvidenceSchema>;
export type CorrectionReview = z.infer<typeof correctionReviewSchema>;
export type CreateCorrectionInput = z.infer<typeof createCorrectionSchema>;
export type QueueCorrectionInput = z.infer<typeof queueCorrectionSchema>;

export const HASH_PATTERN = sha256;
