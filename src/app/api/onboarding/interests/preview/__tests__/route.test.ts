import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));

import { POST } from "../route";

function request(labels: unknown) {
  return new NextRequest("https://learn.test/api/onboarding/interests/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ labels }),
  });
}

describe("onboarding interest preview", () => {
  beforeEach(() => {
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" } },
      response: null,
    });
  });

  it("requires an authenticated approved account", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await POST(request(["cooking"]))).status).toBe(401);
  });

  it("returns suggestions without persisting or claiming confirmation, and never drops a real entry", async () => {
    const response = await POST(request(["home cooking", "racing cars", "stamp collecting", "cats"]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      interests: [
        { label: "home cooking", suggestedCategory: "cooking", recognized: true },
        { label: "racing cars", suggestedCategory: "cars", recognized: true },
        { label: "stamp collecting", suggestedCategory: "everyday-life", recognized: false },
        { label: "cats", suggestedCategory: "animals", recognized: true },
      ],
      rejected: [],
    });
  });

  it("rejects junk entries individually, with a reason, while keeping the real entries", async () => {
    const response = await POST(request(["cooking", "n/a", "123"]));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.interests).toEqual([
      { label: "cooking", suggestedCategory: "cooking", recognized: true },
    ]);
    expect(result.rejected).toEqual([
      { label: "n/a", reason: "It doesn't describe an interest." },
      { label: "123", reason: "It needs at least one letter." },
    ]);
  });

  it("rejects too many, empty, or oversized interests", async () => {
    for (const labels of [
      Array.from({ length: 9 }, (_, index) => `interest ${index}`),
      [""],
      ["x".repeat(51)],
    ]) {
      expect((await POST(request(labels))).status).toBe(400);
    }
  });
});
