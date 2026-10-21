/**
 * Password-reset requests for known and unknown emails do different amounts of
 * work (verification insert, source lookup, outbox enqueue). Every response is
 * held to one fixed floor so latency is not an account-enumeration oracle.
 */
export const RESET_REQUEST_MIN_DURATION_MS = 800;

export const NEUTRAL_RESET_REQUEST_BODY = Object.freeze({
  status: true,
  message: "If this email exists in our system, check your email for the reset link",
});

const startedAt = new WeakMap<Request, number>();

export function markResetRequestStarted(request: Request | undefined, now = Date.now()) {
  if (request && !startedAt.has(request)) startedAt.set(request, now);
}

export async function holdResetRequestFloor(
  request: Request | undefined,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = request ? startedAt.get(request) : undefined;
  if (request) startedAt.delete(request);
  // Without a recorded start, wait the whole floor: slower, never a leak.
  const remaining = RESET_REQUEST_MIN_DURATION_MS - (started === undefined ? 0 : now() - started);
  if (remaining > 0) await sleep(remaining);
}
