import { NextRequest, NextResponse } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createContentRepository, type AssessmentBank } from "@/lib/content";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), examGate: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/exams/capability-gate", () => ({ gateClosedBookCapability: mocks.examGate }));
vi.mock("@/lib/security/rate-limit", () => ({
  withRateLimit: vi.fn(async (_checks, handler: () => Promise<Response>) => handler()),
}));

import { POST } from "../route";

let bank: AssessmentBank;
let codeBank: AssessmentBank;

beforeAll(async () => {
  const repository = createContentRepository();
  bank = (await repository.listAssessmentBanks({ skillId: "ai.applications.multimodal" }))[0]!;
  codeBank = (await repository.listAssessmentBanks({ skillId: "pf.state.variables" }))[0]!;
});

beforeEach(() => {
  mocks.examGate.mockResolvedValue({ allowed: true });
  mocks.requireAuth.mockResolvedValue({
    session: { user: { id: "learner-1" }, session: { id: "session-1" } },
    response: null,
  });
});

function request(body: Record<string, unknown>) {
  return new NextRequest("https://learn.test/api/games/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("server-checked lesson quest API", () => {
  it("requires authentication and bounded input", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await POST(request({}))).status).toBe(401);
    expect((await POST(request({ skillId: "x" }))).status).toBe(400);
  });

  it("fails closed before reading a quest while an official exam is active", async () => {
    mocks.examGate.mockResolvedValueOnce({
      allowed: false,
      code: "EXAM_CLOSED_BOOK",
      status: 423,
      message: "Return to the exam workspace.",
    });
    const response = await POST(request({}));
    expect(response.status).toBe(423);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ code: "EXAM_CLOSED_BOOK" });
  });

  it("advances only a correct private-oracle response without awarding evidence", async () => {
    const item = bank.items.find((candidate) => candidate.kind === "mcq")!;
    if (item.kind !== "mcq") throw new Error("Expected MCQ fixture");
    const response = await POST(request({
      skillId: bank.skillId,
      itemId: item.id,
      response: { selectedOptionIds: item.answer.correctOptionIds },
      hintIndex: 0,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      correct: true,
      stageAdvance: true,
      authoritativeEvidence: false,
      reviewRequired: true,
    });
    expect(body.notice).toMatch(/never awards mastery/i);
    expect(JSON.stringify(body)).not.toMatch(/correctOptionIds|acceptedByGap|acceptedTraces|referenceSolution|privateAuthorNotes/);
  });

  it("keeps a wrong response on the same stage and returns a bounded hint", async () => {
    const item = bank.items.find((candidate) => candidate.kind === "mcq")!;
    if (item.kind !== "mcq") throw new Error("Expected MCQ fixture");
    const wrong = item.options.find((option) => !item.answer.correctOptionIds.includes(option.id))!;
    const response = await POST(request({
      skillId: bank.skillId,
      itemId: item.id,
      response: { selectedOptionIds: [wrong.id] },
      hintIndex: 0,
      clientRequestId: "22222222-2222-4222-8222-222222222222",
    }));
    expect(await response.json()).toMatchObject({
      correct: false,
      stageAdvance: false,
      authoritativeEvidence: false,
      hint: item.hints[0],
    });
  });

  it("binds the item to its skill and refuses code items", async () => {
    const item = bank.items[0]!;
    expect((await POST(request({
      skillId: "pf.state.constants",
      itemId: item.id,
      response: { trace: "anything" },
      clientRequestId: "33333333-3333-4333-8333-333333333333",
    }))).status).toBe(404);
    const code = codeBank.items.find((candidate) => candidate.kind === "code");
    if (code) {
      expect((await POST(request({
        skillId: codeBank.skillId,
        itemId: code.id,
        response: { trace: "anything" },
        clientRequestId: "44444444-4444-4444-8444-444444444444",
      }))).status).toBe(404);
    }
  });
});
