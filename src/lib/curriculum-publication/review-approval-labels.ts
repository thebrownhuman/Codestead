/**
 * Single source of truth for the "reviewed" vs "approved" wording in the
 * admin curriculum publication UI. The two terms track different things:
 * "reviewed" is the owner's one-click personal mark (see owner-review.ts),
 * "approved" is the formal review_status = 'approved' gate that release
 * evidence and ARTIFACT_STAGE_UNAPPROVED blockers key off. They used to be
 * shown under the same word ("reviewed") in different places, which made
 * the counts look contradictory across the course list, detail panel, and
 * editorial queue.
 */
export function approvedLabel(approvedCount: number, artifactCount: number): string {
  return `${approvedCount}/${artifactCount} approved`;
}

export function reviewedLabel(reviewedCount: number, artifactCount: number): string {
  return `${reviewedCount}/${artifactCount} reviewed`;
}

export function reviewApprovalSummary(input: {
  reviewedCount: number;
  approvedCount: number;
  artifactCount: number;
}): string {
  return `${reviewedLabel(input.reviewedCount, input.artifactCount)} · ${approvedLabel(input.approvedCount, input.artifactCount)}`;
}
