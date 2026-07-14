import {
  DAILY_REVIEW_SIZE,
  type DailyReviewCandidate,
  type DailyReviewPriorityReason,
  type RankedDailyReviewCandidate,
} from "./types";

function normalizedConfidence(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function priorityReason(candidate: DailyReviewCandidate): DailyReviewPriorityReason {
  if (candidate.hasConfirmedMisconception) return "confirmed_misconception";
  if (candidate.overdueAt) return "overdue_review";
  return "lowest_confidence";
}

function priority(reason: DailyReviewPriorityReason): number {
  if (reason === "confirmed_misconception") return 0;
  if (reason === "overdue_review") return 1;
  return 2;
}

/**
 * Pure, deterministic ordering for a learner's daily five. Skill IDs are
 * unique so the learning service can resolve one independently reviewed item
 * per slot without accidentally showing the same concept twice.
 */
export function selectDailyReviewCandidates(
  candidates: readonly DailyReviewCandidate[],
  size = DAILY_REVIEW_SIZE,
): readonly RankedDailyReviewCandidate[] {
  const bySkill = new Map<string, RankedDailyReviewCandidate>();
  for (const candidate of candidates) {
    const ranked = {
      ...candidate,
      confidence: normalizedConfidence(candidate.confidence),
      priorityReason: priorityReason(candidate),
    } satisfies RankedDailyReviewCandidate;
    const current = bySkill.get(ranked.skillId);
    if (!current || compareCandidates(ranked, current) < 0) bySkill.set(ranked.skillId, ranked);
  }
  return [...bySkill.values()].sort(compareCandidates).slice(0, Math.max(0, size));
}

function compareCandidates(
  left: RankedDailyReviewCandidate,
  right: RankedDailyReviewCandidate,
): number {
  const priorityDifference = priority(left.priorityReason) - priority(right.priorityReason);
  if (priorityDifference) return priorityDifference;
  if (left.priorityReason === "overdue_review" && right.priorityReason === "overdue_review") {
    const dueDifference = (left.overdueAt?.getTime() ?? 0) - (right.overdueAt?.getTime() ?? 0);
    if (dueDifference) return dueDifference;
  }
  const confidenceDifference = left.confidence - right.confidence;
  if (confidenceDifference) return confidenceDifference;
  return left.skillId.localeCompare(right.skillId, "en-US");
}
