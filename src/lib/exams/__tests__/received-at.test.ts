import { describe, expect, it } from "vitest";

import { examClockOffsetMs, stampExamReceivedAt } from "../received-at";

describe("exam clock offset", () => {
  it("uses the time the server response arrived, not the time it is read", () => {
    const view = { serverNow: "2026-01-01T00:00:00.000Z" };
    const arrivedAt = Date.parse("2026-01-01T00:00:00.000Z");
    stampExamReceivedAt(view, arrivedAt);
    // The component mounts 4 s later (IndexedDB, hydration); the offset must not shift.
    expect(examClockOffsetMs(view, arrivedAt + 4_000)).toBe(0);
  });

  it("falls back to the given time for an unstamped view", () => {
    const view = { serverNow: "2026-01-01T00:00:10.000Z" };
    expect(examClockOffsetMs(view, Date.parse("2026-01-01T00:00:00.000Z"))).toBe(10_000);
  });
});
