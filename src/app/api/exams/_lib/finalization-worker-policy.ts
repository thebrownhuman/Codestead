export function examFinalizationRetryDelayMs(attemptCount: number): number {
  return Math.min(10 * 60_000, 5_000 * (2 ** Math.max(0, Math.min(7, attemptCount - 1))));
}

/** Runner requests (generations) a finalization job may spend before it fails. */
export const MAX_EXAM_RUNNER_GENERATIONS = 10;
/**
 * Hard ceiling on claims of one job. An "indeterminate" runner answer keeps the
 * same generation, so without this a dead runner is retried every 10 minutes
 * forever. 60 claims is roughly 9 hours of retries at the capped delay.
 */
export const MAX_EXAM_FINALIZATION_ATTEMPTS = 60;

export function isExamFinalizationTerminal(input: {
  readonly errorCode: string;
  readonly attemptCount: number;
  readonly runnerRequestGeneration: number;
}): boolean {
  if (input.errorCode === "LEARNER_NOT_ACTIVE") return true;
  if (input.attemptCount >= MAX_EXAM_FINALIZATION_ATTEMPTS) return true;
  if (input.errorCode === "RUNNER_INDETERMINATE") return false;
  return input.runnerRequestGeneration >= MAX_EXAM_RUNNER_GENERATIONS;
}
