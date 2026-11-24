import { serverClockOffsetMs } from "@/app/api/exams/_lib/policy";

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
