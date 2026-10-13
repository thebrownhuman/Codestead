import { z } from "zod";

export const REVIEW_DIMENSIONS = [
  "technical",
  "source",
  "pedagogy",
  "accessibility",
  "security",
  "answerOracle",
  "exampleExecution",
] as const;

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const evidenceRef = z.string().trim().min(12).max(500);
const reviewDimensionSchema = z.object({
  passed: z.boolean(),
  evidenceRef,
  note: z.string().trim().min(12).max(1_000),
}).strict();

export const curriculumReviewChecklistSchema = z.object({
  technical: reviewDimensionSchema,
  source: reviewDimensionSchema,
  pedagogy: reviewDimensionSchema,
  accessibility: reviewDimensionSchema,
  security: reviewDimensionSchema,
  answerOracle: reviewDimensionSchema,
  exampleExecution: reviewDimensionSchema,
}).strict();

export type CurriculumReviewChecklist = z.infer<typeof curriculumReviewChecklistSchema>;
export type CurriculumReviewDecision = "approved" | "changes_requested" | "rejected";

const passedReportSchema = z.object({
  passed: z.literal(true),
  reportHash: hash,
}).strict();

const scopedReportSchema = z.object({
  status: z.enum(["passed", "not_applicable"]),
  reportHash: hash,
  rationale: z.string().trim().min(20).max(1_000),
}).strict();

export const notRunReportSchema = z.object({
  status: z.literal("not_run"),
  reason: z.string().trim().min(1).max(1_000),
  acknowledgedBy: z.string().trim().min(1).max(200),
  acknowledgedAt: z.string().datetime({ offset: true }),
}).strict();

// Clients request checks, never submit passes or acknowledgement identity/time.
export const generateReleaseEvidenceRequestSchema = z.object({
  requestId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  expectedContentHash: hash,
  reason: z.string().trim().min(20).max(500),
  acknowledgeNotRun: z.literal(true),
  notRunReason: z.string().trim().min(1).max(1_000),
  targetStage: z.enum(["beta", "verified"]).optional(),
}).strict();

export const curriculumReleaseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  generator: z.string().trim().min(3).max(200),
  sourceCoverage: passedReportSchema.extend({
    sourceRefs: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  skillCoverage: passedReportSchema.extend({
    skillIds: z.array(z.string().trim().min(1)).min(1),
    lessonArtifactKeys: z.array(z.string().trim().min(1)).min(1),
    assessmentBankArtifactKeys: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  dagMastery: passedReportSchema,
  codeExecution: z.union([notRunReportSchema, passedReportSchema.extend({
    executedItemIds: z.array(z.string().trim().min(1)),
    runtimeImageDigests: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
  }).strict()]),
  languageParity: z.union([notRunReportSchema, scopedReportSchema.extend({
    languages: z.array(z.string().trim().min(1)),
  }).strict()]),
  webAccessibility: z.union([notRunReportSchema, scopedReportSchema]),
  security: z.union([notRunReportSchema, passedReportSchema]),
  exclusions: z.object({
    reportHash: hash,
    items: z.array(z.string().trim().min(3)),
  }).strict(),
}).strict();

export type CurriculumReleaseEvidence = z.infer<typeof curriculumReleaseEvidenceSchema>;

export function allReviewDimensionsPassed(checklist: CurriculumReviewChecklist): boolean {
  return REVIEW_DIMENSIONS.every((dimension) => checklist[dimension].passed);
}
