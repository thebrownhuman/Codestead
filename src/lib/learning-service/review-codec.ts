import {
  DEFAULT_REVIEW_POLICY,
  type ReviewSchedule,
} from "@/lib/domain";

import type { StoredReview } from "./types";

const REASON_PATTERN = /^adaptive:v1:index=(\d+);success=(\d+);lapses=(\d+);context=([A-Za-z0-9:+_.-]+)$/;

export function encodeReviewReason(
  schedule: ReviewSchedule,
  languageContext: string,
): string {
  return `adaptive:v1:index=${schedule.intervalIndex};success=${schedule.successfulReviews};lapses=${schedule.lapses};context=${languageContext}`;
}

export function decodeReviewSchedule(review: StoredReview): ReviewSchedule {
  const match = REASON_PATTERN.exec(review.reason);
  const fallbackIndex = Math.max(
    0,
    DEFAULT_REVIEW_POLICY.intervalsDays.findIndex((days) => days === review.intervalDays),
  );
  return {
    skillId: review.skillId,
    intervalIndex: match ? Number(match[1]) : fallbackIndex,
    intervalDays: review.intervalDays,
    dueAtMs: review.dueAt.getTime(),
    successfulReviews: match ? Number(match[2]) : 0,
    lapses: match ? Number(match[3]) : 0,
  };
}

export function reviewLanguageContext(review: StoredReview): string {
  return REASON_PATTERN.exec(review.reason)?.[4] ?? review.languageContext;
}
