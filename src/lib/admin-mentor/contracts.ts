import { z } from "zod";

export const MENTOR_EVIDENCE_CATEGORIES = [
  "chats",
  "code_submissions",
  "exams",
  "projects",
  "ai_summaries",
] as const;

export const MENTOR_EVIDENCE_PURPOSES = [
  "learning_support",
  "progress_review",
  "appeal_investigation",
  "curriculum_adjustment",
  "safety_review",
] as const;

export const mentorEvidenceReadSchema = z.object({
  requestId: z.uuid(),
  category: z.enum(MENTOR_EVIDENCE_CATEGORIES),
  purpose: z.enum(MENTOR_EVIDENCE_PURPOSES),
  reason: z.string().trim().min(20).max(500),
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();

export type MentorEvidenceCategory = (typeof MENTOR_EVIDENCE_CATEGORIES)[number];
export type MentorEvidencePurpose = (typeof MENTOR_EVIDENCE_PURPOSES)[number];
export type MentorEvidenceReadInput = z.infer<typeof mentorEvidenceReadSchema>;
