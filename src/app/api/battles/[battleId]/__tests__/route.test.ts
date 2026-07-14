import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getBattle: vi.fn(),
  joinBattle: vi.fn(),
  submitBattle: vi.fn(),
  audit: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/battles/service", () => ({
  BattleError: class BattleError extends Error { constructor(readonly code: string) { super(code); } },
  getBattle: mocks.getBattle,
  joinBattle: mocks.joinBattle,
  submitBattle: mocks.submitBattle,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { POST } from "../route";

describe("battle detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" }, session: { id: "session-1" } },
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
    mocks.submitBattle.mockResolvedValue({ accepted: true, replayed: false });
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
  });

  it("returns the committed submission with a reconciliation warning when completion audit degrades", async () => {
    const response = await POST(
      new NextRequest("https://learn.example.test/api/battles/cb000000-0000-4000-8000-000000000001", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          requestId: "cb000000-0000-4000-8000-000000000002",
          answer: { value: "a" },
        }),
      }),
      { params: Promise.resolve({ battleId: "cb000000-0000-4000-8000-000000000001" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      report: { accepted: true, replayed: false },
      completionAuditRecorded: false,
      auditCorrelationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      warning: expect.stringContaining("completed"),
    });
    expect(mocks.submitBattle).toHaveBeenCalledOnce();
  });
});
