export const DRAFT_CONTENT_MAX_BYTES = 131_072;
export const DRAFT_ACCOUNT_MAX_BYTES = 32 * 1024 * 1024;
export const DRAFT_ACCOUNT_MAX_RECORDS = 512;

export type DraftKind = "code" | "lesson";

export type DraftKey = Readonly<{
  kind: DraftKind;
  courseId: string;
  skillId: string;
  /**
   * Code drafts are language-faceted. Lesson notes deliberately use null.
   * Keeping this in the key prevents a DSA language switch from overwriting
   * another implementation's work.
   */
  language: string | null;
}>;

export type LearnerDraftRecord = DraftKey & Readonly<{
  id: string;
  content: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}>;

export type SaveLearnerDraftInput = DraftKey & Readonly<{
  userId: string;
  content: string;
  language: string | null;
  expectedRowVersion: number;
  requestId: string;
}>;

export type SaveLearnerDraftResult = Readonly<{
  draft: LearnerDraftRecord;
  replayed: boolean;
  committedRowVersion: number;
}>;
