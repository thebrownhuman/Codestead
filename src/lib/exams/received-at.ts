export function serverClockOffsetMs(serverNowIso: string, receivedAtMs: number): number {
  const serverNowMs = Date.parse(serverNowIso);
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(receivedAtMs)) {
    throw new RangeError("server and client clock values must be valid");
  }
  return serverNowMs - receivedAtMs;
}

/**
 * Browser time at which each exam view arrived from the server. The deadline
 * clock offset must be measured at arrival: computing it later (at component
 * mount, after IndexedDB and hydration) makes the timer show extra time.
 */
const receivedAt = new WeakMap<object, number>();

export function stampExamReceivedAt(view: object, receivedAtMs: number): void {
  if (!receivedAt.has(view)) receivedAt.set(view, receivedAtMs);
}

export function examClockOffsetMs(view: { readonly serverNow: string }, fallbackMs: number): number {
  return serverClockOffsetMs(view.serverNow, receivedAt.get(view) ?? fallbackMs);
}
