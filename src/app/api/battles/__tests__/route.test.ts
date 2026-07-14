import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createBattle: vi.fn(),
  listBattles: vi.fn(),
  audit: vi.fn(),
  withRateLimit: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/battles/service", () => ({
  BattleError: class BattleError extends Error { constructor(readonly code: string) { super(code); } },
  createBattle: mocks.createBattle,
  listBattles: mocks.listBattles,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));

import { POST } from "../route";

describe("battle collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" }, session: { id: "session-1" } },
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    mocks.withRateLimit.mockImplementation(async (_input, callback) => callback());
    mocks.createBattle.mockResolvedValue({ id: "cb000000-0000-4000-8000-000000000001", replayed: false });
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
  });

  it("returns the committed create result with a reconciliation warning when completion audit degrades", async () => {
    const response = await POST(new NextRequest("https://learn.example.test/api/battles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "cb000000-0000-4000-8000-000000000002",
        activityId: "cb000000-0000-4000-8000-000000000003",
        scope: "cohort",
        startsAt: "2026-07-14T12:00:00.000Z",
        durationMinutes: 30,
      }),
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      report: { id: "cb000000-0000-4000-8000-000000000001", replayed: false },
      completionAuditRecorded: false,
      auditCorrelationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      warning: expect.stringContaining("completed"),
    });
    expect(mocks.createBattle).toHaveBeenCalledOnce();
  });
});
