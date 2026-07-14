import { describe, expect, it } from "vitest";

import { decodeNotificationCursor, encodeNotificationCursor } from "../center";

describe("notification cursor", () => {
  it("round-trips a stable opaque timeline cursor", () => {
    const source = {
      createdAt: new Date("2026-07-14T10:20:30.000Z"),
      id: "11111111-1111-4111-8111-111111111111",
    };
    expect(decodeNotificationCursor(encodeNotificationCursor(source))).toEqual(source);
  });

  it.each(["", "not-base64", Buffer.from("bad|id").toString("base64url")])("rejects malformed cursor %s", (value) => {
    expect(decodeNotificationCursor(value)).toBeNull();
  });
});
