import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return {
    limit, where, from, select, returning, values, insert,
    requireAuth: vi.fn(), withRateLimit: vi.fn(), writeAuditEvent: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, insert: mocks.insert } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.writeAuditEvent }));

import { POST } from "../route";

const callId = "00000000-0000-4000-8000-000000000001";
const request = (body: unknown) => new NextRequest("https://learn.test/api/ai/reports", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("AI output report API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" }, session: { id: "session-1" } },
      account: { role: "learner" },
      response: null,
    });
    mocks.withRateLimit.mockImplementation(async (_config, callback) => callback());
    mocks.limit.mockReset().mockResolvedValue([{
      id: callId,
      provider: "nvidia_nim",
      model: "test/model",
      promptVersion: "buddy-tutor-v1",
      contextManifest: { included: ["course", "skill"], excluded: ["credentials"] },
      requestHash: "a".repeat(64),
      responseHash: "b".repeat(64),
      createdAt: new Date("2026-07-12T10:00:00.000Z"),
    }]);
    mocks.returning.mockResolvedValue([{
      id: "00000000-0000-4000-8000-000000000002",
      status: "pending",
      createdAt: new Date("2026-07-12T10:01:00.000Z"),
    }]);
    mocks.writeAuditEvent.mockResolvedValue({ correlationId: "c", eventHash: "h" });
  });

  it("rejects malformed reports before querying evidence", async () => {
    const response = await POST(request({ modelCallId: callId, category: "incorrect", description: "too short" }));
    expect(response.status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("prevents a learner from reporting another learner's model call", async () => {
    mocks.limit.mockReset().mockResolvedValueOnce([]);
    const response = await POST(request({
      modelCallId: callId,
      category: "privacy",
      description: "This response appears to include information that is not mine.",
    }));
    expect(response.status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    ["21st", ["21", "st_sk_", "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6"].join("")],
    ["AWS", ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("")],
    ["Slack", ["xox", "b-", "1234567890-abcdefghijklmnopqrstuvwxyz"].join("")],
    ["labelled custom", "access token=abcdefghijklmnop"],
  ])("rejects %s credential material before evidence lookup or persistence", async (_label, candidate) => {
    const response = await POST(request({
      modelCallId: callId,
      category: "privacy",
      description: `This response exposed private material by mistake: ${candidate}`,
    }));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain(candidate);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("preserves safe model evidence and queues human review without raw output or keys", async () => {
    const response = await POST(request({
      modelCallId: callId,
      category: "incorrect",
      description: "The explanation says assignment compares values, which is incorrect.",
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      kind: "ai-output-report",
      subject: "AI tutor report: incorrect",
    }));
    const persisted = JSON.stringify(mocks.values.mock.calls);
    expect(persisted).toContain(callId);
    expect(persisted).toContain("buddy-tutor-v1");
    expect(persisted).toContain("requestHash");
    expect(persisted).toContain("responseHash");
    expect(persisted).not.toMatch(/nvapi-|api[_-]?key|ciphertext|rawResponse/i);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai_output.report",
      outcome: "success",
      metadata: expect.objectContaining({ modelCallId: callId, provider: "nvidia_nim" }),
    }));
  });
});
