export function examFinalizationRetryDelayMs(attemptCount: number): number {
  return Math.min(10 * 60_000, 5_000 * (2 ** Math.max(0, Math.min(7, attemptCount - 1))));
}
