/**
 * Derives the adaptive recommender's session counts from stored session
 * events. Review completions are browser telemetry and are never stored as
 * meaningful, so they are counted as completed actions here as well; otherwise
 * reviewActions could exceed completedActions, which selectNextAction rejects.
 */
export function countSessionActions(
  rows: readonly { readonly type: string; readonly metadata: { readonly meaningful?: unknown } }[],
): { completedActions: number; reviewActions: number } {
  let completedActions = 0;
  let reviewActions = 0;
  for (const row of rows) {
    const review = row.type === "review_completed";
    if (review) reviewActions += 1;
    if (review || row.metadata.meaningful === true) completedActions += 1;
  }
  return { completedActions, reviewActions };
}
