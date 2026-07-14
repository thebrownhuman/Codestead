import type { LearnerAttemptCreationPayload } from "@/lib/learning-service/learner-activity";

export const DAILY_REVIEW_SIZE = 5 as const;

export type DailyReviewPriorityReason =
  | "confirmed_misconception"
  | "overdue_review"
  | "lowest_confidence";

export interface DailyReviewItemPayload {
  readonly id: string;
  readonly position: number;
  readonly skillId: string;
  readonly skillTitle: string;
  readonly courseTitle: string;
  readonly priorityReason: DailyReviewPriorityReason;
  readonly confidencePercent: number;
  readonly status: "pending" | "answered";
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly href: string;
  readonly attempt: LearnerAttemptCreationPayload | null;
}

export interface DailyReviewSessionPayload {
  readonly id: string;
  readonly localDate: string;
  readonly timezone: string;
  readonly status: "ready" | "completed" | "unavailable";
  readonly availableItemCount: number;
  readonly questionCount: 0 | 5;
  readonly completedCount: number;
  readonly items: readonly DailyReviewItemPayload[];
}

export type DailyReviewPayload =
  | {
      readonly state: "not_started";
      readonly localDate: string;
      readonly timezone: string;
      readonly session: null;
    }
  | {
      readonly state: "ready" | "completed" | "unavailable";
      readonly localDate: string;
      readonly timezone: string;
      readonly session: DailyReviewSessionPayload;
    };

export interface DailyReviewCandidate {
  readonly skillId: string;
  readonly skillTitle: string;
  readonly courseSlug: string;
  readonly courseTitle: string;
  readonly conceptId: string;
  readonly enrollmentId: string;
  readonly confidence: number;
  readonly hasConfirmedMisconception: boolean;
  readonly overdueAt: Date | null;
}

export interface RankedDailyReviewCandidate extends DailyReviewCandidate {
  readonly priorityReason: DailyReviewPriorityReason;
}
