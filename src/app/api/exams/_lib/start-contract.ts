import { z } from "zod";

/**
 * Client acknowledgements are deliberately limited to the exam disclosure and
 * readiness statement. Retake remediation is never accepted from this body.
 */
export const startExamRequestSchema = z.object({
  moduleId: z.string().trim().min(3).max(180),
  integrityDisclosureAccepted: z.literal(true),
  readinessAcknowledged: z.literal(true),
  device: z.object({
    viewportWidth: z.number().int().positive().max(20_000),
    viewportHeight: z.number().int().positive().max(20_000),
    userAgent: z.string().max(1_000),
  }).strict(),
}).strict();

export type StartExamRequest = z.infer<typeof startExamRequestSchema>;
